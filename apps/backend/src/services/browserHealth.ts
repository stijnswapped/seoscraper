import { readFileSync, readdirSync } from "node:fs";
import { createLogger } from "../utils/logger.js";

const log = createLogger("browserHealth");

/**
 * Tracks whether headless Chromium can still start in this process, and
 * recycles the process when it can't.
 *
 * Why: every Chromium session leaves helper processes (zygote, crashpad
 * handler, renderers) that are re-parented to PID 1 when the browser exits.
 * If PID 1 doesn't reap them they pile up as zombies until the container's task
 * limit (pids.max) is hit; from then on every chrome-headless-shell dies ~100 ms
 * into launch with a bare `signal=SIGTRAP` and no stderr. Nothing inside the app
 * recovers from that: node keeps serving, /health stays green, and only a
 * container restart clears it. The Dockerfile runs tini as PID 1, which removes
 * that cause; this is the backstop for whatever else exhausts the box (memory,
 * threads, /tmp).
 *
 * A launch counts as working once the browser has opened a page, not when the
 * process merely started: a browser that starts and dies straight away is just
 * as unusable. After N such failures in a row — in a process where the browser
 * DID work before, so a fresh container can actually fix it — the process
 * drains and exits non-zero so the platform starts a clean container:
 *  1. keep serving (scrapes run without a browser meanwhile) and exit as soon
 *     as nothing is in flight: no browser slot held, no request running, no
 *     finished check result still waiting to be collected;
 *  2. still busy after `stopAcceptingAfterMs`: refuse new work (503) so the
 *     in-flight work can finish;
 *  3. exit after `maxDrainMs` whatever still runs.
 * A browser that launches again during the drain cancels the restart.
 */
export interface BrowserHealthSnapshot {
  /** Launches that got as far as opening a page, since this process started. */
  launches: number;
  /** Failed launches in a row (each one already retried inside the launcher). */
  consecutiveLaunchFailures: number;
  lastLaunchOkAt: string | null;
  lastLaunchFailedAt: string | null;
  /** True once the process has decided to drain and exit so it can be restarted. */
  recycling: boolean;
  /** When that decision fell. */
  recyclingSince: string | null;
  /** False in the last drain phase, while new scrape requests are refused. */
  acceptingWork: boolean;
}

export interface BrowserHealthOptions {
  /** Consecutive failed launches before the process drains and exits (0 = never). */
  failuresBeforeExit: number;
  /** True while work that an exit would cut off is still running. */
  isBusy?: () => boolean;
  /** How often the drain checks whether the process has gone quiet. */
  drainPollMs?: number;
  /** Still busy after draining this long: stop accepting new work. */
  stopAcceptingAfterMs?: number;
  /** Exit after draining this long, whatever is still running. */
  maxDrainMs?: number;
  /** Injected for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
}

export interface BrowserHealth {
  recordLaunchSuccess(): void;
  recordLaunchFailure(message: string): void;
  isRecycling(): boolean;
  isAcceptingWork(): boolean;
  snapshot(): BrowserHealthSnapshot;
}

export function createBrowserHealth(options: BrowserHealthOptions): BrowserHealth {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const isBusy = options.isBusy ?? (() => false);
  const drainPollMs = options.drainPollMs ?? 1_000;
  const stopAcceptingAfterMs = options.stopAcceptingAfterMs ?? 120_000;
  const maxDrainMs = options.maxDrainMs ?? 600_000;

  let launches = 0;
  let consecutive = 0;
  let lastOk: number | null = null;
  let lastFailed: number | null = null;
  let recyclingSince: number | null = null;
  let acceptingWork = true;
  let drainTimer: ReturnType<typeof setInterval> | null = null;

  const stopDrain = () => {
    if (drainTimer) clearInterval(drainTimer);
    drainTimer = null;
  };

  const checkDrain = () => {
    if (recyclingSince === null) return;
    const drainedMs = Date.now() - recyclingSince;
    const busy = isBusy();
    if (!busy || drainedMs >= maxDrainMs) {
      stopDrain();
      if (busy) log.error("drain deadline reached; exiting with work still in flight", { drainedMs });
      else log.error("drained; exiting so the platform restarts the container", { drainedMs });
      exit(1);
      return;
    }
    if (acceptingWork && drainedMs >= stopAcceptingAfterMs) {
      acceptingWork = false;
      log.warn("still busy while draining; refusing new scrape requests until in-flight work finishes", { drainedMs });
    }
  };

  return {
    recordLaunchSuccess() {
      launches += 1;
      consecutive = 0;
      lastOk = Date.now();
      if (recyclingSince !== null) {
        // Chromium works again (a launch that was already under way when the
        // decision fell): no reason to drop the container any more.
        stopDrain();
        recyclingSince = null;
        acceptingWork = true;
        log.warn("browser launched again; restart cancelled");
      }
    },

    recordLaunchFailure(message: string) {
      consecutive += 1;
      lastFailed = Date.now();
      // Record what ran out, so the logs answer "pids? memory? zombies?" next time.
      log.error("browser could not be launched", {
        consecutiveFailures: consecutive,
        launchesSinceStart: launches,
        message: message.slice(0, 300),
        ...readProcessDiagnostics(),
      });

      if (recyclingSince !== null || options.failuresBeforeExit <= 0 || consecutive < options.failuresBeforeExit) return;
      if (launches === 0) {
        // Chromium never worked in this process: a build/config problem that a
        // fresh container would repeat, so restarting would only drop traffic.
        if (consecutive === options.failuresBeforeExit) {
          log.error("browser has never launched in this process; not restarting (a fresh container would fail the same way)");
        }
        return;
      }
      recyclingSince = Date.now();
      log.error("browser can no longer launch; draining, then exiting so the platform restarts the container", {
        consecutiveFailures: consecutive,
        stopAcceptingAfterMs,
        maxDrainMs,
      });
      drainTimer = setInterval(checkDrain, drainPollMs);
      drainTimer.unref?.();
    },

    isRecycling: () => recyclingSince !== null,

    isAcceptingWork: () => acceptingWork,

    snapshot: () => ({
      launches,
      consecutiveLaunchFailures: consecutive,
      lastLaunchOkAt: lastOk === null ? null : new Date(lastOk).toISOString(),
      lastLaunchFailedAt: lastFailed === null ? null : new Date(lastFailed).toISOString(),
      recycling: recyclingSince !== null,
      recyclingSince: recyclingSince === null ? null : new Date(recyclingSince).toISOString(),
      acceptingWork,
    }),
  };
}

/**
 * Best-effort container vitals (Linux only; empty elsewhere): what PID 1 and
 * this process's parent are, the cgroup task and memory limits, and how many
 * zombie processes exist.
 */
export function readProcessDiagnostics(): Record<string, string | number> {
  if (process.platform !== "linux") return {};
  const out: Record<string, string | number> = {};
  const pid1 = readTrimmed("/proc/1/comm");
  if (pid1) out.pid1 = pid1;
  const parent = readTrimmed(`/proc/${process.ppid}/comm`);
  if (parent) out.parent = parent;
  const pidsCurrent = readTrimmed("/sys/fs/cgroup/pids.current") ?? readTrimmed("/sys/fs/cgroup/pids/pids.current");
  const pidsMax = readTrimmed("/sys/fs/cgroup/pids.max") ?? readTrimmed("/sys/fs/cgroup/pids/pids.max");
  if (pidsCurrent) out.pidsCurrent = pidsCurrent;
  if (pidsMax) out.pidsMax = pidsMax;
  const memCurrent = Number(readTrimmed("/sys/fs/cgroup/memory.current"));
  if (memCurrent > 0) out.memoryCurrentMb = Math.round(memCurrent / 1048576);
  const memMax = readTrimmed("/sys/fs/cgroup/memory.max");
  if (memMax) out.memoryMax = memMax === "max" ? "max" : `${Math.round(Number(memMax) / 1048576)}MB`;
  const zombies = countZombies();
  if (zombies !== null) out.zombies = zombies;
  return out;
}

/** True when PID 1 is an init that reaps orphans (tini, dumb-init, docker --init). */
export function isReapingInit(pid1: string | undefined): boolean {
  return !!pid1 && /^(tini|tini-static|dumb-init|docker-init|init|systemd)$/.test(pid1);
}

/**
 * True when exited Chromium helpers get reaped: PID 1 is an init, or our parent
 * is tini (started with `-s`, it is a subreaper for everything below it even
 * when it is not PID 1).
 */
export function orphansAreReaped(diag: { pid1?: string | number; parent?: string | number }): boolean {
  return isReapingInit(diag.pid1 === undefined ? undefined : String(diag.pid1)) ||
    /^tini(-static)?$/.test(String(diag.parent ?? ""));
}

function readTrimmed(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function countZombies(): number | null {
  try {
    let zombies = 0;
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const stat = readTrimmed(`/proc/${entry}/stat`);
      if (!stat) continue;
      // Format: "pid (comm) S ..." — comm may contain spaces/parens, so read the
      // state right after the LAST closing paren.
      const close = stat.lastIndexOf(")");
      if (stat.charAt(close + 2) === "Z") zombies += 1;
    }
    return zombies;
  } catch {
    return null;
  }
}
