import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserHealth, isReapingInit, orphansAreReaped } from "../src/services/browserHealth.js";

const SIGTRAP = "Failed to launch browser after 3 attempts: signal=SIGTRAP";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A health tracker whose browser worked once and has now failed `failures` times in a row. */
function brokenAfterWorking(opts: { failures: number; isBusy?: () => boolean; exit: (code: number) => void }) {
  const health = createBrowserHealth({
    failuresBeforeExit: 3,
    drainPollMs: 1_000,
    stopAcceptingAfterMs: 120_000,
    maxDrainMs: 600_000,
    isBusy: opts.isBusy,
    exit: opts.exit,
  });
  health.recordLaunchSuccess();
  for (let i = 0; i < opts.failures; i++) health.recordLaunchFailure(SIGTRAP);
  return health;
}

describe("createBrowserHealth: when to restart", () => {
  it("decides to restart after N failed launches in a process where the browser used to work", () => {
    const exit = vi.fn();
    const health = brokenAfterWorking({ failures: 2, exit });
    expect(health.isRecycling()).toBe(false);

    health.recordLaunchFailure(SIGTRAP);
    expect(health.isRecycling()).toBe(true);
    expect(exit).not.toHaveBeenCalled();

    // Nothing in flight: exits at the first drain check.
    vi.advanceTimersByTime(1_000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits only once, however many launches fail afterwards", () => {
    const exit = vi.fn();
    const health = brokenAfterWorking({ failures: 3, exit });
    for (let i = 0; i < 6; i++) health.recordLaunchFailure("boom");
    vi.advanceTimersByTime(700_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("resets the streak on a successful launch (a transient failure is not a broken box)", () => {
    const exit = vi.fn();
    const health = brokenAfterWorking({ failures: 2, exit });
    health.recordLaunchSuccess();
    health.recordLaunchFailure("boom");
    health.recordLaunchFailure("boom");
    vi.advanceTimersByTime(700_000);

    expect(exit).not.toHaveBeenCalled();
    expect(health.snapshot()).toMatchObject({ launches: 2, consecutiveLaunchFailures: 2, recycling: false });
  });

  it("never restarts when the browser has not launched once in this process (a restart can't fix a broken build)", () => {
    const exit = vi.fn();
    const health = createBrowserHealth({ failuresBeforeExit: 3, exit });

    for (let i = 0; i < 10; i++) health.recordLaunchFailure("Executable doesn't exist");
    vi.advanceTimersByTime(700_000);

    expect(exit).not.toHaveBeenCalled();
    expect(health.isRecycling()).toBe(false);
    expect(health.snapshot().consecutiveLaunchFailures).toBe(10);
  });

  it("is disabled with failuresBeforeExit = 0", () => {
    const exit = vi.fn();
    const health = createBrowserHealth({ failuresBeforeExit: 0, exit });

    health.recordLaunchSuccess();
    for (let i = 0; i < 10; i++) health.recordLaunchFailure("boom");
    vi.advanceTimersByTime(700_000);

    expect(exit).not.toHaveBeenCalled();
  });
});

describe("createBrowserHealth: draining before the exit", () => {
  it("waits for in-flight work instead of cutting it off after a fixed grace period", () => {
    const exit = vi.fn();
    let busy = true;
    const health = brokenAfterWorking({ failures: 3, exit, isBusy: () => busy });

    // A healthy session (or a listings-track run) is still working: no exit,
    // and new work is still accepted during the first drain phase.
    vi.advanceTimersByTime(60_000);
    expect(exit).not.toHaveBeenCalled();
    expect(health.isAcceptingWork()).toBe(true);

    busy = false;
    vi.advanceTimersByTime(1_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("stops accepting new work when it stays busy, and exits at the drain deadline regardless", () => {
    const exit = vi.fn();
    const health = brokenAfterWorking({ failures: 3, exit, isBusy: () => true });

    vi.advanceTimersByTime(119_000);
    expect(health.isAcceptingWork()).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(health.isAcceptingWork()).toBe(false);
    expect(health.snapshot().acceptingWork).toBe(false);
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(480_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("cancels the restart when the browser launches again during the drain", () => {
    const exit = vi.fn();
    const health = brokenAfterWorking({ failures: 3, exit, isBusy: () => true });
    vi.advanceTimersByTime(130_000);
    expect(health.isAcceptingWork()).toBe(false);

    health.recordLaunchSuccess();
    expect(health.isRecycling()).toBe(false);
    expect(health.isAcceptingWork()).toBe(true);
    vi.advanceTimersByTime(700_000);
    expect(exit).not.toHaveBeenCalled();

    // And a later breakdown can still trigger a fresh restart.
    for (let i = 0; i < 3; i++) health.recordLaunchFailure(SIGTRAP);
    expect(health.isRecycling()).toBe(true);
  });
});

describe("isReapingInit / orphansAreReaped", () => {
  it("recognises the usual container inits and rejects npm/node", () => {
    expect(isReapingInit("tini")).toBe(true);
    expect(isReapingInit("dumb-init")).toBe(true);
    expect(isReapingInit("docker-init")).toBe(true);
    expect(isReapingInit("npm")).toBe(false);
    expect(isReapingInit("node")).toBe(false);
    expect(isReapingInit(undefined)).toBe(false);
  });

  it("also accepts tini as the parent (tini -s is a subreaper even when not PID 1)", () => {
    expect(orphansAreReaped({ pid1: "tini", parent: "tini" })).toBe(true);
    expect(orphansAreReaped({ pid1: "sh", parent: "tini" })).toBe(true);
    expect(orphansAreReaped({ pid1: "npm", parent: "sh" })).toBe(false);
    expect(orphansAreReaped({ pid1: "node" })).toBe(false);
  });
});
