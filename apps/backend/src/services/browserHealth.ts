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
 * threads, /tmp): after N consecutive failed launches — in a process where the
 * browser DID launch before, so a fresh container can actually fix it — exit
 * non-zero after a short grace so the platform starts a clean container.
 */
export interface BrowserHealthSnapshot {
  /** Successful launches since this process started. */
  launches: number;
  /** Failed launches in a row (each one already retried inside the launcher). */
  consecutiveLaunchFailures: number;
  lastLaunchOkAt: string | null;
  lastLaunchFailedAt: string | null;
  /** True once the process has decided to exit so it can be restarted. */
  recycling: boolean;
}

export interface BrowserHealthOptions {
  /** Consecutive failed launches before the process exits (0 = never). */
  failuresBeforeExit: number;
  /** Time between deciding to recycle and exiting, so in-flight work can finish. */
  graceMs: number;
  /** Injected for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
}

export interface BrowserHealth {
  recordLaunchSuccess(): void;
  recordLaunchFailure(message: string): void;
  isRecycling(): boolean;
  snapshot(): BrowserHealthSnapshot;
}

export function createBrowserHealth(options: BrowserHealthOptions): BrowserHealth {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let launches = 0;
  let consecutive = 0;
  let lastOk: number | null = null;
  let lastFailed: number | null = null;
  let recycling = false;

  return {
    recordLaunchSuccess() {
      launches += 1;
      consecutive = 0;
      lastOk = Date.now();
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

      if (recycling || options.failuresBeforeExit <= 0 || consecutive < options.failuresBeforeExit) return;
      if (launches === 0) {
        // Chromium never started in this process: a build/config problem that a
        // fresh container would repeat, so restarting would only drop traffic.
        // Stay up — callers fall back to a plain fetch.
        if (consecutive === options.failuresBeforeExit) {
          log.error("browser has never launched in this process; not restarting (a fresh container would fail the same way)");
        }
        return;
      }
      recycling = true;
      log.error("browser can no longer launch; exiting so the platform restarts the container", {
        consecutiveFailures: consecutive,
        graceMs: options.graceMs,
      });
      setTimeout(() => exit(1), options.graceMs);
    },

    isRecycling: () => recycling,

    snapshot: () => ({
      launches,
      consecutiveLaunchFailures: consecutive,
      lastLaunchOkAt: lastOk === null ? null : new Date(lastOk).toISOString(),
      lastLaunchFailedAt: lastFailed === null ? null : new Date(lastFailed).toISOString(),
      recycling,
    }),
  };
}

/**
 * Best-effort container vitals (Linux only; empty elsewhere): what PID 1 is,
 * the cgroup task and memory limits, and how many zombie processes exist.
 */
export function readProcessDiagnostics(): Record<string, string | number> {
  if (process.platform !== "linux") return {};
  const out: Record<string, string | number> = {};
  const pid1 = readTrimmed("/proc/1/comm");
  if (pid1) out.pid1 = pid1;
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
