import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock("playwright", () => ({ chromium: { launch: mocks.launch } }));

type PageLoader = typeof import("../src/services/pageLoader.js");
type ProductCheck = typeof import("../src/types/productCheck.js");

// Fresh modules per test: the browser pool and launch health are process-wide.
let pl: PageLoader;
let pc: ProductCheck;

async function loadModules(env: Record<string, string> = {}): Promise<void> {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  pl = await import("../src/services/pageLoader.js");
  pc = await import("../src/types/productCheck.js");
}

/** The exact failure seen in production once the container ran out of tasks. */
const SIGTRAP_LAUNCH_ERROR =
  "browserType.launch: Target page, context or browser has been closed\n" +
  "  - <launched> pid=411490\n  - <process did exit: exitCode=null, signal=SIGTRAP>";

/** A page whose navigation fails: enough to prove the browser could open a page. */
function failingNavigationPage() {
  return {
    setDefaultTimeout: vi.fn(),
    goto: vi.fn(async () => {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    }),
    close: vi.fn(async () => {}),
  };
}

function fakeBrowser(
  opts: { close?: () => Promise<void>; newPage?: () => Promise<unknown> } = {},
) {
  const context = {
    addInitScript: vi.fn(async () => {}),
    route: vi.fn(async () => {}),
    newPage: vi.fn(opts.newPage ?? (async () => failingNavigationPage())),
  };
  return { newContext: vi.fn(async () => context), close: vi.fn(opts.close ?? (async () => {})), context };
}

/** Browser that starts, then dies before it can open a page (a half-full container). */
function deadOnArrivalBrowser() {
  return fakeBrowser({
    newPage: async () => {
      throw new Error("browserContext.newPage: Target page, context or browser has been closed");
    },
  });
}

function htmlResponse(html: string, url: string): Response {
  const res = new Response(html, { status: 200, headers: { "content-type": "text/html", server: "nginx" } });
  Object.defineProperty(res, "url", { value: url });
  return res;
}

function stubFetchOk(title = "Linen Dress - Shop") {
  const fetchMock = vi.fn(async (input: string | URL) =>
    htmlResponse(`<html><head><title>${title}</title></head><body>ok</body></html>`, input.toString()),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const PRODUCT = "https://shop.example/products/linen-dress";

/** One session that opens a page: the browser counts as having worked in this process. */
async function oneWorkingSession(): Promise<void> {
  mocks.launch.mockResolvedValueOnce(fakeBrowser());
  await expect(pl.withBrowserSession((s) => s.loadPage(PRODUCT))).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
}

beforeEach(async () => {
  mocks.launch.mockReset();
  await loadModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("withBrowserSession (default for check-product): Chromium cannot start", () => {
  it("fails with PAGE_LOAD_FAILED (502) and does not fetch, so API clients keep their own fallback", async () => {
    mocks.launch.mockRejectedValue(new Error(SIGTRAP_LAUNCH_ERROR));
    const fetchMock = stubFetchOk();
    const fn = vi.fn((session: import("../src/services/pageLoader.js").BrowserSession) =>
      pl.loadPageOrFetch(PRODUCT, { scrollProfile: "product" }, session),
    );

    const err = await pl.withBrowserSession(fn).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(pc.BrowserUnavailableError);
    expect((err as InstanceType<ProductCheck["CheckError"]>).code).toBe("PAGE_LOAD_FAILED");
    expect((err as Error).message).toMatch(/^Failed to launch browser after 3 attempts: .*SIGTRAP/s);
    expect(fn).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.launch).toHaveBeenCalledTimes(3);
    expect(pl.getBrowserHealth()).toMatchObject({ launches: 0, consecutiveLaunchFailures: 1, recycling: false });
  });

  it("a browser that starts but cannot open a page is a failed launch too: 502-type error (not a raw 500), counted", async () => {
    mocks.launch.mockResolvedValue(deadOnArrivalBrowser());
    const fetchMock = stubFetchOk();

    const err = await pl
      .withBrowserSession((s) => pl.loadPageOrFetch(PRODUCT, { scrollProfile: "product" }, s))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(pc.BrowserUnavailableError);
    expect(err).toBeInstanceOf(pc.CheckError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pl.getBrowserHealth()).toMatchObject({ launches: 0, consecutiveLaunchFailures: 1 });
  });

  it("counts a launch as working only once it opened a page", async () => {
    await oneWorkingSession();
    expect(pl.getBrowserHealth()).toMatchObject({ launches: 1, consecutiveLaunchFailures: 0 });
  });
});

describe("withBrowserSessionOrFetch (fetchFallback opt-in)", () => {
  it("runs the work once on a plain fetch when Chromium cannot start, and marks the page", async () => {
    mocks.launch.mockRejectedValue(new Error(SIGTRAP_LAUNCH_ERROR));
    stubFetchOk();
    const unavailable = vi.fn();
    const fallback = vi.fn();
    const fn = vi.fn((session: import("../src/services/pageLoader.js").BrowserSession) =>
      pl.loadPageOrFetch(PRODUCT, { scrollProfile: "product" }, session, fallback),
    );

    const page = await pl.withBrowserSessionOrFetch(fn, unavailable);

    expect(page.title).toBe("Linen Dress - Shop");
    expect(page.browserUnavailable).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledWith(expect.stringMatching(/^Failed to launch browser after 3 attempts: .*SIGTRAP/s));
    // Not a page-level fallback: the per-page hook stays quiet.
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back to fetch per page when the browser dies before opening one", async () => {
    mocks.launch.mockResolvedValue(deadOnArrivalBrowser());
    const fetchMock = stubFetchOk();

    const page = await pl.withBrowserSessionOrFetch((s) => pl.loadPageOrFetch(PRODUCT, { scrollProfile: "product" }, s));

    expect(page.browserUnavailable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch a second time when the fetch without a browser fails too", async () => {
    mocks.launch.mockRejectedValue(new Error(SIGTRAP_LAUNCH_ERROR));
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const err = await pl
      .withBrowserSessionOrFetch((s) => pl.loadPageOrFetch(PRODUCT, { scrollProfile: "product" }, s))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(pc.BrowserUnavailableError);
    expect((err as Error).message).toMatch(/; direct fetch also failed: /);
    // proxy + direct attempt of ONE fetchPageDirect, not two rounds.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("propagates errors after the browser started instead of re-running the work, and closes the browser once", async () => {
    const browser = fakeBrowser();
    mocks.launch.mockResolvedValue(browser);
    const fn = vi.fn(async () => {
      throw new pc.CheckError("PAGE_LOAD_FAILED", "Page returned HTTP 500.");
    });

    await expect(pl.withBrowserSessionOrFetch(fn)).rejects.toThrow("Page returned HTTP 500.");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe("self-restart backstop", () => {
  it("counts browsers that start but die before a page (half-full container) toward the restart", async () => {
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await oneWorkingSession();

    mocks.launch.mockResolvedValue(deadOnArrivalBrowser());
    for (let i = 0; i < 3; i++) {
      await expect(pl.withBrowserSession((s) => s.loadPage(PRODUCT))).rejects.toBeInstanceOf(pc.BrowserUnavailableError);
    }

    expect(pl.getBrowserHealth()).toMatchObject({ launches: 1, consecutiveLaunchFailures: 3, recycling: true });
  });

  it("never starts another Chromium once the restart is decided, not even for a session already queued for the slot, and exits only when the running session is done", async () => {
    vi.useFakeTimers();
    await loadModules({ BROWSER_MAX_CONCURRENCY: "2" });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await oneWorkingSession();

    // Session A: healthy and busy in slot 1.
    mocks.launch.mockResolvedValueOnce(fakeBrowser());
    let finishA!: () => void;
    const a = pl.withBrowserSession(() => new Promise<string>((resolve) => (finishA = () => resolve("A done"))));
    await vi.advanceTimersByTimeAsync(0);

    // Slot 2: launches keep dying with SIGTRAP.
    mocks.launch.mockRejectedValue(new Error(SIGTRAP_LAUNCH_ERROR));
    for (let i = 0; i < 2; i++) {
      const failing = pl.withBrowserSession(async () => "never").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await failing).toBeInstanceOf(pc.BrowserUnavailableError);
    }
    const third = pl.withBrowserSession(async () => "never").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    // E queues for slot 2 BEFORE the third failure decides the restart.
    const e = pl.withBrowserSession(async () => "E ran").catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await third).toBeInstanceOf(pc.BrowserUnavailableError);
    expect(pl.getBrowserHealth().recycling).toBe(true);

    const launchesBefore = mocks.launch.mock.calls.length;
    const eResult = await e;
    expect(eResult).toBeInstanceOf(pc.BrowserUnavailableError);
    expect((eResult as Error).message).toMatch(/restarting/);
    expect(mocks.launch.mock.calls.length).toBe(launchesBefore);

    // A is still working: no exit, however long it takes.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exit).not.toHaveBeenCalled();

    finishA();
    await expect(a).resolves.toBe("A done");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("withBrowserSession slot hand-off", () => {
  it("keeps the slot until the previous Chromium has actually closed (no two live browsers)", async () => {
    vi.useFakeTimers();
    // A browser that takes 10s to go away: longer than the old 5s release cap,
    // shorter than Playwright's 30s graceful-close → SIGKILL escalation.
    const slow = fakeBrowser({ close: () => new Promise<void>((resolve) => setTimeout(resolve, 10_000)) });
    const next = fakeBrowser();
    mocks.launch.mockResolvedValueOnce(slow).mockResolvedValueOnce(next);

    const first = pl.withBrowserSession(async () => "first");
    const second = pl.withBrowserSession(async () => "second");

    await vi.advanceTimersByTimeAsync(6_000);
    expect(mocks.launch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });
});
