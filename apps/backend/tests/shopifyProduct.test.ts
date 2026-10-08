import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acceptingWork: true,
  logUsage: vi.fn(async (_request: unknown, _input: Record<string, unknown>) => {}),
}));

vi.mock("../src/services/pageLoader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/pageLoader.js")>()),
  isAcceptingWork: () => mocks.acceptingWork,
}));

vi.mock("../src/services/usageLogger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/usageLogger.js")>()),
  logUsage: mocks.logUsage,
}));

const PROXY_URL = "http://relay-user:relay-secret@proxy.example:8080";
const MB = 1024 * 1024;

interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
  redirect: RequestInit["redirect"];
  signal: AbortSignal | null;
  /** True when the request was handed an undici dispatcher, i.e. sent through the proxy. */
  proxied: boolean;
  at: number;
}

type Upstream = (call: UpstreamCall) => Response | Promise<Response>;

/** Stand in for the shop: stub the global fetch that proxyFetch / fetchDirect end up calling. */
function stubUpstream(upstream: Upstream): UpstreamCall[] {
  const calls: UpstreamCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit & { dispatcher?: unknown } = {}) => {
      const call: UpstreamCall = {
        url: input.toString(),
        headers: (init.headers ?? {}) as Record<string, string>,
        redirect: init.redirect,
        signal: init.signal ?? null,
        proxied: init.dispatcher !== undefined,
        at: Date.now(),
      };
      calls.push(call);
      return upstream(call);
    }),
  );
  return calls;
}

/** An upstream that never answers. Like fetch, it rejects once the request is aborted. */
function hang(call: UpstreamCall): Promise<Response> {
  return new Promise((_, reject) => {
    call.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
  });
}

function redirectTo(location: string, status = 301): Response {
  return new Response(null, { status, headers: { location } });
}

let app: FastifyInstance | undefined;

/**
 * A server on a fresh module graph: the deadline is read from env at load, and
 * the per-host lanes and proxy health are module state that must not leak
 * between tests.
 */
async function startApp(): Promise<FastifyInstance> {
  vi.resetModules();
  const { buildServer } = await import("../src/server.js");
  app = await buildServer();
  return app;
}

async function relay(payload: Record<string, unknown>) {
  const server = app ?? (await startApp());
  return server.inject({ method: "POST", url: "/api/shopify-product", payload });
}

/** The service on its own (fresh module graph), for the tests that drive the clock. */
async function loadService() {
  vi.resetModules();
  return import("../src/services/shopifyProduct.js");
}

function lastUsage(): Record<string, unknown> {
  return mocks.logUsage.mock.calls.at(-1)![1];
}

// The first import of the server pulls in the whole backend; keep that cold
// start out of the first test's own timeout.
beforeAll(async () => {
  await import("../src/server.js");
}, 60_000);

beforeEach(() => {
  // Hermetic whatever this machine's environment says: no proxy, open auth, no database.
  for (const key of ["SCRAPE_PROXY_URL", "HTTPS_PROXY", "HTTP_PROXY", "API_KEY", "REQUIRE_API_KEY", "DATABASE_URL"]) {
    vi.stubEnv(key, "");
  }
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  mocks.acceptingWork = true;
  mocks.logUsage.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/shopify-product, which URLs it accepts", () => {
  it("refuses anything that is not an https product URL on a public host with 400, without fetching", async () => {
    const calls = stubUpstream(() => new Response("{}", { status: 200 }));

    const refused: Array<[url: string, code: string]> = [
      ["http://shop.example/products/linen-dress.json", "INVALID_URL"],
      ["ftp://shop.example/products/linen-dress.json", "INVALID_URL"],
      ["not a url", "INVALID_URL"],
      ["https://user:secret@shop.example/products/linen-dress.json", "INVALID_URL"],
      ["https://shop.example:8443/products/linen-dress.json", "INVALID_URL"],
      ["https://shop.example/collections/x", "INVALID_URL"],
      ["https://shop.example/products/a/b", "INVALID_URL"],
      ["https://shop.example/products/", "INVALID_URL"],
      ["https://shop.example/products.json", "INVALID_URL"],
      ["https://shop.example/english/products/linen-dress", "INVALID_URL"],
      ["https://shop.example/en-de/fr/products/linen-dress", "INVALID_URL"],
      ["https://127.0.0.1/products/x.json", "DOMAIN_NOT_ALLOWED"],
      ["https://localhost/products/x", "DOMAIN_NOT_ALLOWED"],
      ["https://localhost./products/x", "DOMAIN_NOT_ALLOWED"],
      ["https://10.0.0.5/products/x.js", "DOMAIN_NOT_ALLOWED"],
      ["https://[::1]/products/x.json", "INVALID_URL"],
    ];
    for (const [url, code] of refused) {
      const res = await relay({ url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json(), url).toMatchObject({ success: false, error: { code } });
      // A refused URL is logged, never billed.
      expect(lastUsage(), url).toMatchObject({ endpoint: "/api/shopify-product", status: 400, ok: false, billable: false });
    }

    // A malformed body never gets as far as the URL rules.
    for (const payload of [{}, { url: "" }, { url: "https://shop.example/products/x", proxy: "http://127.0.0.1:8080" }]) {
      const res = await relay(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ success: false, error: { code: "INVALID_URL" } });
    }

    expect(calls).toHaveLength(0);
  });

  it("accepts a market-prefixed path and tells the three kinds apart by the path's ending", async () => {
    const calls = stubUpstream(() => new Response("ok", { status: 200 }));

    // One host per case, so the pause between two starts for the same host stays out of this test.
    const accepted: Array<[url: string, kind: string]> = [
      ["https://a.example/en-de/products/linen-dress.js", "js"],
      ["https://b.example/pt-br/products/linen-dress.json", "json"],
      ["https://c.example/fr/products/linen-dress", "page"],
      ["https://d.example/EN-DE/Products/Linen-Dress.JSON", "json"],
      ["https://e.example:443/products/linen-dress", "page"],
    ];
    for (const [url, kind] of accepted) {
      const res = await relay({ url });
      expect(res.statusCode, url).toBe(200);
      expect(res.json().result, url).toMatchObject({ kind, status: 200, body: "ok" });
    }
    expect(calls).toHaveLength(accepted.length);
    // The default port is not an explicit one: it is normalised away.
    expect(calls.at(-1)!.url).toBe("https://e.example/products/linen-dress");
  });
});

describe("POST /api/shopify-product, what the shop answered", () => {
  it("hands a .json 200 back byte for byte, with the query string forwarded and the fragment dropped", async () => {
    // Odd spacing, an escape, non-ASCII and a price with trailing zeros: any
    // JSON round trip on the way would change this text.
    const body = '{ "product" : {"id":1,  "title":"\\u017b\u00f3\u0142ta  sukienka",\n\t"variants":[ {"price":"149.00"} ] } }\n';
    const calls = stubUpstream(
      () => new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }),
    );

    const res = await relay({ url: "https://shop.example/products/linen-dress.json?variant=42&a=b%20c#reviews" });

    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.success).toBe(true);
    expect(Object.keys(payload.result)).toEqual([
      "url",
      "kind",
      "status",
      "finalUrl",
      "retryAfter",
      "contentType",
      "body",
      "bytes",
      "via",
      "redirects",
      "ms",
    ]);
    expect(payload.result).toMatchObject({
      url: "https://shop.example/products/linen-dress.json?variant=42&a=b%20c",
      kind: "json",
      status: 200,
      finalUrl: "https://shop.example/products/linen-dress.json?variant=42&a=b%20c",
      retryAfter: null,
      contentType: "application/json; charset=utf-8",
      body,
      bytes: Buffer.byteLength(body),
      via: "direct",
      redirects: 0,
    });
    expect(payload.result.body).toContain('"price":"149.00"');
    expect(typeof payload.result.ms).toBe("number");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://shop.example/products/linen-dress.json?variant=42&a=b%20c");
    expect(calls[0]!.redirect).toBe("manual");
    // An XHR-style request, the way the tracker asks for products.json.
    expect(calls[0]!.headers).toMatchObject({
      accept: "application/json,text/plain,*/*;q=0.8",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      referer: "https://shop.example",
    });
    expect(calls[0]!.headers["user-agent"]).toBeTruthy();

    expect(lastUsage()).toMatchObject({
      endpoint: "/api/shopify-product",
      status: 200,
      ok: true,
      usedProxy: "none",
      units: 1,
      billable: true,
    });
  });

  it("asks for a .js URL the same XHR-style way", async () => {
    const calls = stubUpstream(() => new Response('{"id":1}', { status: 200 }));

    const res = await relay({ url: "https://shop.example/products/linen-dress.js" });

    expect(res.json().result).toMatchObject({ kind: "js", status: 200, body: '{"id":1}' });
    expect(calls[0]!.headers).toMatchObject({ accept: "application/json,text/plain,*/*;q=0.8", "sec-fetch-mode": "cors" });
  });

  it("asks for the product page as a top-level navigation", async () => {
    const html = "<html><head><title>Linen Dress</title></head><body>  <h1>Linen Dress</h1>\n</body></html>";
    const calls = stubUpstream(() => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));

    const res = await relay({ url: "https://shop.example/products/linen-dress" });

    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ kind: "page", status: 200, body: html, contentType: "text/html; charset=utf-8" });
    expect(calls[0]!.headers).toMatchObject({
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "upgrade-insecure-requests": "1",
    });
    expect(calls[0]!.headers.accept).toContain("text/html");
    expect(calls[0]!.headers.referer).toBeUndefined();
  });

  it("reports an upstream 429 inside result.status with HTTP 200, Retry-After in seconds, and no body", async () => {
    stubUpstream(() => new Response("Too many requests", { status: 429, headers: { "retry-after": "120" } }));

    const res = await relay({ url: "https://shop.example/products/linen-dress.json" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      result: { kind: "json", status: 429, retryAfter: 120, body: "", bytes: 0, via: "direct", redirects: 0 },
    });
    // The shop answered, but the caller did not get the product: logged, not billed.
    expect(lastUsage()).toMatchObject({ endpoint: "/api/shopify-product", status: 200, ok: false, units: 1, billable: false });
  });

  it("converts an HTTP-date Retry-After to seconds from now, and gives null for anything else", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    const expectations: Array<[header: string, retryAfter: number | null]> = [
      ["Thu, 08 Oct 2026 12:01:30 GMT", 90],
      ["Thu, 08 Oct 2026 11:59:00 GMT", 0],
      ["0", 0],
      ["soon", null],
      ["12.5", null],
      ["-5", null],
    ];
    let header = "";
    stubUpstream(() => new Response(null, { status: 503, headers: { "retry-after": header } }));

    for (const [index, [value, retryAfter]] of expectations.entries()) {
      header = value;
      const res = await relay({ url: `https://shop${index}.example/products/x.js` });
      expect(res.json().result, value).toMatchObject({ status: 503, retryAfter, body: "" });
    }
  });

  it("reports an upstream 404 inside result.status, without the error body", async () => {
    stubUpstream(
      () => new Response('{"errors":"Not Found"}', { status: 404, headers: { "content-type": "application/json; charset=utf-8" } }),
    );

    const res = await relay({ url: "https://shop.example/products/gone.json" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      result: { status: 404, retryAfter: null, contentType: "application/json; charset=utf-8", body: "", bytes: 0 },
    });
    expect(lastUsage()).toMatchObject({ status: 200, ok: false, billable: false });
  });
});

describe("POST /api/shopify-product, redirects", () => {
  it("follows a redirect to another public host and reports where the answer came from", async () => {
    const calls = stubUpstream((call) =>
      call.url.startsWith("https://shop.myshopify.example/")
        ? redirectTo("https://www.shop.example/products/linen-dress.json#top")
        : new Response('{"product":{}}', { status: 200 }),
    );

    const res = await relay({ url: "https://shop.myshopify.example/products/linen-dress.json" });

    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({
      url: "https://shop.myshopify.example/products/linen-dress.json",
      status: 200,
      finalUrl: "https://www.shop.example/products/linen-dress.json",
      redirects: 1,
      body: '{"product":{}}',
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://shop.myshopify.example/products/linen-dress.json",
      "https://www.shop.example/products/linen-dress.json",
    ]);
    expect(calls[1]!.headers.referer).toBe("https://www.shop.example");
  });

  it("resolves a relative Location against the current URL", async () => {
    stubUpstream((call) =>
      call.url.includes("/en-de/") ? new Response("{}", { status: 200 }) : redirectTo("/en-de/products/linen-dress.js", 302),
    );

    const res = await relay({ url: "https://shop.example/products/linen-dress.js" });

    expect(res.json().result).toMatchObject({ finalUrl: "https://shop.example/en-de/products/linen-dress.js", redirects: 1 });
  });

  it("refuses a redirect to http, to a private host or to a malformed URL with 502, without following it", async () => {
    let location = "";
    const calls = stubUpstream(() => redirectTo(location));

    const refused = [
      "http://shop.example/products/linen-dress.json",
      "https://127.0.0.1/products/linen-dress.json",
      "https://localhost/admin",
      "https://[::1]/products/linen-dress.json",
      "https://user:secret@other.example/products/linen-dress.json",
      "https://",
      " ",
    ];
    for (const [index, target] of refused.entries()) {
      location = target;
      const res = await relay({ url: `https://shop${index}.example/products/linen-dress.json` });
      expect(res.statusCode, target).toBe(502);
      expect(res.json(), target).toMatchObject({ success: false, error: { code: "PAGE_LOAD_FAILED" } });
      expect(res.json().error.message, target).not.toContain("secret");
      expect(lastUsage(), target).toMatchObject({ status: 502, ok: false, billable: false });
    }
    // One request per case: the redirect itself was never requested.
    expect(calls).toHaveLength(refused.length);
  });

  it("follows five hops, and gives up with 502 on the sixth", async () => {
    let hopsBeforeAnswer = 5;
    const calls = stubUpstream((call) => {
      const hop = Number(new URL(call.url).searchParams.get("hop") ?? 0);
      return hop < hopsBeforeAnswer ? redirectTo(`/products/linen-dress.json?hop=${hop + 1}`, 307) : new Response("{}", { status: 200 });
    });

    const five = await relay({ url: "https://five.example/products/linen-dress.json" });
    expect(five.json().result).toMatchObject({
      status: 200,
      redirects: 5,
      finalUrl: "https://five.example/products/linen-dress.json?hop=5",
    });
    expect(calls).toHaveLength(6);

    hopsBeforeAnswer = 6;
    const six = await relay({ url: "https://six.example/products/linen-dress.json" });
    expect(six.statusCode).toBe(502);
    expect(six.json()).toMatchObject({ success: false, error: { code: "PAGE_LOAD_FAILED" } });
    expect(calls).toHaveLength(12);
  });

  it("reports a 3xx that carries no Location as the shop's answer", async () => {
    stubUpstream(() => new Response(null, { status: 304 }));

    const res = await relay({ url: "https://shop.example/products/linen-dress.json" });

    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ status: 304, redirects: 0, body: "" });
  });
});

describe("POST /api/shopify-product, when no answer comes", () => {
  it("answers 502 PAGE_LOAD_FAILED on a network error, naming the cause", async () => {
    stubUpstream(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND shop.example" } });
    });

    const res = await relay({ url: "https://shop.example/products/linen-dress.json" });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ success: false, error: { code: "PAGE_LOAD_FAILED" } });
    expect(res.json().error.message).toContain("ENOTFOUND");
    expect(lastUsage()).toMatchObject({ endpoint: "/api/shopify-product", status: 502, ok: false, billable: false });
  });

  it("answers 502 when the shop does not answer within SHOPIFY_PRODUCT_TIMEOUT_MS, and aborts the request", async () => {
    vi.stubEnv("SHOPIFY_PRODUCT_TIMEOUT_MS", "150");
    const calls = stubUpstream(hang);

    const startedAt = Date.now();
    const res = await relay({ url: "https://shop.example/products/linen-dress.json" });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ success: false, error: { code: "PAGE_LOAD_FAILED" } });
    expect(res.json().error.message).toContain("within 150 ms");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(calls).toHaveLength(1);
    await vi.waitFor(() => expect(calls[0]!.signal?.aborted).toBe(true));
  });

  it("holds the body read to the same deadline, and cancels the stream", async () => {
    vi.stubEnv("SHOPIFY_PRODUCT_TIMEOUT_MS", "150");
    const cancelled = vi.fn();
    stubUpstream(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => controller.enqueue(new TextEncoder().encode('{"product":')),
            cancel: cancelled,
          }),
          { status: 200 },
        ),
    );

    const res = await relay({ url: "https://shop.example/products/linen-dress.json" });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ success: false, error: { code: "PAGE_LOAD_FAILED" } });
    expect(res.json().error.message).toContain("within 150 ms");
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
  });

  it("answers 502 for a body over 8 MB, and stops reading once the cap is passed", async () => {
    const chunk = new Uint8Array(MB).fill(0x61);
    let pulls = 0;
    const cancelled = vi.fn();
    stubUpstream(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: (controller) => {
              pulls += 1;
              controller.enqueue(chunk);
              if (pulls === 32) controller.close();
            },
            cancel: cancelled,
          }),
          { status: 200 },
        ),
    );

    const res = await relay({ url: "https://shop.example/products/linen-dress.json" });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ success: false, error: { code: "PAGE_LOAD_FAILED" } });
    expect(res.json().error.message).toContain("8 MB");
    expect(cancelled).toHaveBeenCalled();
    // Nine chunks cross the cap; the stream may have one more queued.
    expect(pulls).toBeLessThanOrEqual(10);
  });

  it("still hands back a body of exactly 8 MB", async () => {
    const { fetchShopifyProduct } = await loadService();
    stubUpstream(() => new Response(new Uint8Array(8 * MB).fill(0x61), { status: 200 }));

    const result = await fetchShopifyProduct("https://shop.example/products/linen-dress.json");

    expect(result.bytes).toBe(8 * MB);
    expect(result.body).toHaveLength(8 * MB);
  });
});

describe("fetchShopifyProduct, one request at a time per host", () => {
  it("serialises calls for the same host 300 ms apart, without holding up another host", async () => {
    const { fetchShopifyProduct } = await loadService();
    vi.useFakeTimers();
    const inFlight = new Map<string, number>();
    let overlapped = false;
    const calls = stubUpstream(async (call) => {
      const host = new URL(call.url).hostname;
      inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
      if (inFlight.get(host)! > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 100));
      inFlight.set(host, inFlight.get(host)! - 1);
      return new Response("{}", { status: 200 });
    });

    const first = fetchShopifyProduct("https://one.example/products/a.json");
    const second = fetchShopifyProduct("https://one.example/products/b.json");
    const other = fetchShopifyProduct("https://two.example/products/c.json");

    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((call) => call.url)).toEqual(["https://one.example/products/a.json", "https://two.example/products/c.json"]);

    // The first answer is in after 100 ms; the second call still waits out the gap.
    await vi.advanceTimersByTimeAsync(299);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.url).toBe("https://one.example/products/b.json");
    expect(calls[2]!.at - calls[0]!.at).toBe(300);

    await vi.advanceTimersByTimeAsync(100);
    expect((await first).ms).toBe(100);
    expect((await other).ms).toBe(100);
    // Time spent waiting for the host's turn is part of the exchange.
    expect((await second).ms).toBe(400);
    expect(overlapped).toBe(false);
  });

  it("starts the next call as soon as a slow one is done, never on top of it", async () => {
    const { fetchShopifyProduct } = await loadService();
    vi.useFakeTimers();
    const calls = stubUpstream(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return new Response("{}", { status: 200 });
    });

    const first = fetchShopifyProduct("https://one.example/products/a.json");
    const second = fetchShopifyProduct("https://one.example/products/b.json");

    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at - calls[0]!.at).toBe(500);

    await vi.advanceTimersByTimeAsync(500);
    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(second).resolves.toMatchObject({ status: 200, ms: 1_000 });
  });

  it("gives up with PAGE_LOAD_FAILED when the deadline passes while waiting for the host, sending nothing", async () => {
    const { fetchShopifyProduct } = await loadService();
    vi.useFakeTimers();
    let upstream: Upstream = hang;
    const calls = stubUpstream((call) => upstream(call));

    const stuck = fetchShopifyProduct("https://one.example/products/a.json").catch((err: unknown) => err);
    const queued = fetchShopifyProduct("https://one.example/products/b.json").catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(11_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await stuck).toMatchObject({ code: "PAGE_LOAD_FAILED", message: expect.stringContaining("within 12000 ms") });
    expect(await queued).toMatchObject({ code: "PAGE_LOAD_FAILED", message: expect.stringContaining("no request was sent") });
    expect(calls).toHaveLength(1);

    // The lane is free again: the next call for the host goes straight out.
    upstream = () => new Response("{}", { status: 200 });
    await expect(fetchShopifyProduct("https://one.example/products/c.json")).resolves.toMatchObject({ status: 200, ms: 0 });
    expect(calls.map((call) => call.url)).toEqual(["https://one.example/products/a.json", "https://one.example/products/c.json"]);
  });
});

describe("POST /api/shopify-product, with a proxy configured", () => {
  it("retries a blocked proxy answer once direct and reports via: direct", async () => {
    vi.stubEnv("SCRAPE_PROXY_URL", PROXY_URL);
    const calls = stubUpstream((call) =>
      call.proxied
        ? new Response("blocked", { status: 429, headers: { "retry-after": "60" } })
        : new Response('{"product":{}}', { status: 200 }),
    );

    const res = await relay({ url: "https://shop.example/products/linen-dress.json" });

    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ status: 200, retryAfter: null, body: '{"product":{}}', via: "direct" });
    expect(calls.map((call) => call.proxied)).toEqual([true, false]);
    expect(lastUsage()).toMatchObject({ usedProxy: "env", billable: true });
  });

  it("reports via: proxy when the proxy's answer stands", async () => {
    vi.stubEnv("SCRAPE_PROXY_URL", PROXY_URL);
    const calls = stubUpstream(() => new Response("{}", { status: 404 }));

    const res = await relay({ url: "https://shop.example/products/linen-dress.json" });

    expect(res.json().result).toMatchObject({ status: 404, via: "proxy" });
    // A 404 is not a block: nothing to retry.
    expect(calls.map((call) => call.proxied)).toEqual([true]);
  });

  it("keeps the proxy's blocked answer when the direct retry gets no answer at all", async () => {
    vi.stubEnv("SCRAPE_PROXY_URL", PROXY_URL);
    stubUpstream((call) => {
      if (call.proxied) return new Response(null, { status: 403, headers: { "cf-mitigated": "challenge" } });
      throw new TypeError("fetch failed");
    });

    const res = await relay({ url: "https://shop.example/products/linen-dress.json" });

    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ status: 403, via: "proxy", body: "" });
  });

  it("does not retry direct when the answer already came from this server's own IP, and never leaks proxy credentials", async () => {
    vi.stubEnv("SCRAPE_PROXY_URL", PROXY_URL);
    // The proxy is dead: proxyFetch marks it broken and goes direct by itself.
    const calls = stubUpstream((call) => {
      if (call.proxied) throw new TypeError(`connect ECONNREFUSED via ${PROXY_URL}`);
      return new Response(null, { status: 429, headers: { "retry-after": "30" } });
    });

    const blocked = await relay({ url: "https://shop.example/products/linen-dress.json" });
    expect(blocked.json().result).toMatchObject({ status: 429, retryAfter: 30, via: "direct" });
    expect(calls.map((call) => call.proxied)).toEqual([true, false]);

    // With the proxy in its cooldown the call goes direct at once; a failure there is the caller's 502.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { message: `tunnel to ${PROXY_URL} refused for relay-user:relay-secret (was http://old-user:old-secret@gw.example:9)` },
        });
      }),
    );
    const failed = await relay({ url: "https://other.example/products/linen-dress.json" });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ success: false, error: { code: "PAGE_LOAD_FAILED" } });
    expect(failed.json().error.message).toContain("refused");
    // Neither the active proxy's credentials nor anything else shaped like URL userinfo.
    for (const secret of ["relay-secret", "relay-user", "old-secret"]) expect(failed.body).not.toContain(secret);
  });

  it("answers at the deadline without aborting the proxied attempt, so the proxy is not switched off for the tracker", async () => {
    vi.stubEnv("SCRAPE_PROXY_URL", PROXY_URL);
    vi.stubEnv("SHOPIFY_PRODUCT_TIMEOUT_MS", "600");
    const { fetchShopifyProduct } = await loadService();
    const { isProxyHealthy } = await import("../src/services/antiBlock.js");
    let answerFirst!: (response: Response) => void;
    let seen = 0;
    const calls = stubUpstream((call) => {
      seen += 1;
      if (seen > 1) return new Response("{}", { status: 200 });
      return Promise.race([new Promise<Response>((resolve) => (answerFirst = resolve)), hang(call)]);
    });

    const err = await fetchShopifyProduct("https://shop.example/products/a.json").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "PAGE_LOAD_FAILED", message: expect.stringContaining("within 600 ms") });

    // proxyFetch reads an attempt it times out itself as a BROKEN proxy, disables
    // it process-wide and repeats the request direct. The relay's shorter budget
    // must not trigger that — not at the deadline, and not a moment later either.
    // Meanwhile the host stays taken: the first request is still out.
    const next = fetchShopifyProduct("https://shop.example/products/b.json");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.proxied).toBe(true);
    expect(calls[0]!.signal?.aborted).toBe(false);
    expect(isProxyHealthy()).toBe(true);

    // The shop answers after all. Nobody is waiting for that answer; it frees the host for the next call.
    answerFirst(new Response("late", { status: 200 }));
    await expect(next).resolves.toMatchObject({ status: 200, via: "proxy" });
    expect(calls.map((call) => call.url)).toEqual(["https://shop.example/products/a.json", "https://shop.example/products/b.json"]);
  });
});

describe("POST /api/shopify-product, self-restart drain and billing", () => {
  it("is turned away with a retryable 503 while the service drains, like the other scrape routes", async () => {
    const calls = stubUpstream(() => new Response("{}", { status: 200 }));
    await startApp();
    mocks.acceptingWork = false;

    const res = await relay({ url: "https://shop.example/products/linen-dress.json" });

    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.json()).toMatchObject({ success: false, error: { code: "SERVICE_RESTARTING" } });
    expect(calls).toHaveLength(0);
  });

  it("counts as in-flight work, so a self-restart waits for it", async () => {
    await startApp();
    const { activeWorkCount } = await import("../src/services/workTracker.js");
    let answer!: (response: Response) => void;
    const calls = stubUpstream(() => new Promise<Response>((resolve) => (answer = resolve)));

    const pending = relay({ url: "https://shop.example/products/linen-dress.json" });
    await vi.waitFor(() => expect([calls.length, activeWorkCount()]).toEqual([1, 1]));

    answer(new Response("{}", { status: 200 }));
    expect((await pending).statusCode).toBe(200);
    expect(activeWorkCount()).toBe(0);
  });

  it("costs one unit", async () => {
    const { estimateShopifyProductUnits } = await import("../src/services/billing.js");
    expect(estimateShopifyProductUnits()).toBe(1);
  });
});
