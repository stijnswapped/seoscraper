import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock("playwright", () => ({ chromium: { launch: mocks.launch } }));

import {
  getBrowserHealth,
  loadPageOrFetch,
  withBrowserSessionOrFetch,
  type BrowserSession,
} from "../src/services/pageLoader.js";
import { CheckError } from "../src/types/productCheck.js";

/** The exact failure seen in production once the container ran out of tasks. */
const SIGTRAP_LAUNCH_ERROR =
  "browserType.launch: Target page, context or browser has been closed\n" +
  "  - <launched> pid=411490\n  - <process did exit: exitCode=null, signal=SIGTRAP>";

function fakeBrowser(close: () => Promise<void> = async () => {}) {
  const context = {
    addInitScript: vi.fn(async () => {}),
    route: vi.fn(async () => {}),
    newPage: vi.fn(),
  };
  return { newContext: vi.fn(async () => context), close: vi.fn(close) };
}

function htmlResponse(html: string, url: string): Response {
  const res = new Response(html, { status: 200, headers: { "content-type": "text/html", server: "nginx" } });
  Object.defineProperty(res, "url", { value: url });
  return res;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mocks.launch.mockReset();
});

describe("withBrowserSessionOrFetch, Chromium cannot start", () => {
  it("runs the check once on a plain fetch instead of failing it (no more 502 on a SIGTRAP launch)", async () => {
    mocks.launch.mockRejectedValue(new Error(SIGTRAP_LAUNCH_ERROR));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        htmlResponse("<html><head><title>Linen Dress - Shop</title></head><body>ok</body></html>", input.toString()),
      ),
    );

    const unavailable = vi.fn();
    const fallback = vi.fn();
    const fn = vi.fn((session: BrowserSession) =>
      loadPageOrFetch("https://shop.example/products/linen-dress", { scrollProfile: "product" }, session, fallback),
    );

    const page = await withBrowserSessionOrFetch(fn, unavailable);

    expect(page.title).toBe("Linen Dress - Shop");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mocks.launch).toHaveBeenCalledTimes(3);
    expect(unavailable).toHaveBeenCalledWith(expect.stringMatching(/^Failed to launch browser after 3 attempts: .*SIGTRAP/s));
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(getBrowserHealth().consecutiveLaunchFailures).toBeGreaterThanOrEqual(1);
    // Never launched in this process → no self-restart (a fresh container can't fix that).
    expect(getBrowserHealth().recycling).toBe(false);
  });
});

describe("withBrowserSessionOrFetch, errors after the browser started", () => {
  it("propagates the error instead of re-running the work on fetch, and closes the browser once", async () => {
    const browser = fakeBrowser();
    mocks.launch.mockResolvedValue(browser);

    const fn = vi.fn(async () => {
      throw new CheckError("PAGE_LOAD_FAILED", "Page returned HTTP 500.");
    });

    await expect(withBrowserSessionOrFetch(fn)).rejects.toThrow("Page returned HTTP 500.");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(getBrowserHealth().consecutiveLaunchFailures).toBe(0);
  });
});

describe("withBrowserSession slot hand-off", () => {
  it("keeps the slot until the previous Chromium has actually closed (no two live browsers)", async () => {
    vi.useFakeTimers();
    // A browser that takes 10s to go away: longer than the old 5s release cap,
    // shorter than Playwright's 30s graceful-close → SIGKILL escalation.
    const slow = fakeBrowser(() => new Promise<void>((resolve) => setTimeout(resolve, 10_000)));
    const next = fakeBrowser();
    mocks.launch.mockResolvedValueOnce(slow).mockResolvedValueOnce(next);

    const first = withBrowserSessionOrFetch(async () => "first");
    const second = withBrowserSessionOrFetch(async () => "second");

    await vi.advanceTimersByTimeAsync(6_000);
    expect(mocks.launch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });
});
