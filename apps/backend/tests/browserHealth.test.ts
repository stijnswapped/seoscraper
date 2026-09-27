import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserHealth, isReapingInit } from "../src/services/browserHealth.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createBrowserHealth", () => {
  it("exits (after the grace period) once launches keep failing in a process where they used to work", () => {
    const exit = vi.fn();
    const health = createBrowserHealth({ failuresBeforeExit: 3, graceMs: 30_000, exit });

    health.recordLaunchSuccess();
    health.recordLaunchFailure("Failed to launch browser after 3 attempts: signal=SIGTRAP");
    health.recordLaunchFailure("Failed to launch browser after 3 attempts: signal=SIGTRAP");
    expect(health.isRecycling()).toBe(false);

    health.recordLaunchFailure("Failed to launch browser after 3 attempts: signal=SIGTRAP");
    expect(health.isRecycling()).toBe(true);
    // In-flight work gets the grace period to finish on its fetch fallback.
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("schedules the exit only once, however many launches fail afterwards", () => {
    const exit = vi.fn();
    const health = createBrowserHealth({ failuresBeforeExit: 2, graceMs: 1_000, exit });

    health.recordLaunchSuccess();
    for (let i = 0; i < 6; i++) health.recordLaunchFailure("boom");
    vi.advanceTimersByTime(5_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("resets the streak on a successful launch (a transient failure is not a broken box)", () => {
    const exit = vi.fn();
    const health = createBrowserHealth({ failuresBeforeExit: 3, graceMs: 0, exit });

    health.recordLaunchSuccess();
    health.recordLaunchFailure("boom");
    health.recordLaunchFailure("boom");
    health.recordLaunchSuccess();
    health.recordLaunchFailure("boom");
    health.recordLaunchFailure("boom");
    vi.runAllTimers();

    expect(exit).not.toHaveBeenCalled();
    expect(health.snapshot()).toMatchObject({ launches: 2, consecutiveLaunchFailures: 2, recycling: false });
  });

  it("never restarts when the browser has not launched once in this process (a restart can't fix a broken build)", () => {
    const exit = vi.fn();
    const health = createBrowserHealth({ failuresBeforeExit: 3, graceMs: 0, exit });

    for (let i = 0; i < 10; i++) health.recordLaunchFailure("Executable doesn't exist");
    vi.runAllTimers();

    expect(exit).not.toHaveBeenCalled();
    expect(health.isRecycling()).toBe(false);
    expect(health.snapshot().consecutiveLaunchFailures).toBe(10);
  });

  it("is disabled with failuresBeforeExit = 0", () => {
    const exit = vi.fn();
    const health = createBrowserHealth({ failuresBeforeExit: 0, graceMs: 0, exit });

    health.recordLaunchSuccess();
    for (let i = 0; i < 10; i++) health.recordLaunchFailure("boom");
    vi.runAllTimers();

    expect(exit).not.toHaveBeenCalled();
  });
});

describe("isReapingInit", () => {
  it("recognises the usual container inits and rejects npm/node", () => {
    expect(isReapingInit("tini")).toBe(true);
    expect(isReapingInit("dumb-init")).toBe(true);
    expect(isReapingInit("docker-init")).toBe(true);
    expect(isReapingInit("npm")).toBe(false);
    expect(isReapingInit("node")).toBe(false);
    expect(isReapingInit(undefined)).toBe(false);
  });
});
