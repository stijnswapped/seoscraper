import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchPageDirect, loadPageOrFetch, isRedirectAway } from "../src/services/pageLoader.js";
import { CheckError } from "../src/types/productCheck.js";

describe("isRedirectAway", () => {
  const collection = "https://jacinnewyork.co/collections/all?sort_by=best-selling";
  it("flags a redirect to the home page", () => {
    expect(isRedirectAway(collection, "https://jacinnewyork.co/")).toBe(true);
  });
  it("flags a dropped sort_by (same path, sort lost)", () => {
    expect(isRedirectAway(collection, "https://jacinnewyork.co/collections/all")).toBe(true);
  });
  it("allows www/host change when sort_by is preserved", () => {
    expect(isRedirectAway(collection, "https://www.jacinnewyork.co/collections/all?sort_by=best-selling")).toBe(false);
  });
  it("allows a locale-prefixed copy of the same collection (e.g. /en-us)", () => {
    expect(isRedirectAway(collection, "https://jacinnewyork.co/en-us/collections/all?sort_by=best-selling")).toBe(false);
  });
  it("still flags a locale-prefixed redirect that drops sort_by", () => {
    expect(isRedirectAway(collection, "https://jacinnewyork.co/en-us/collections/all")).toBe(true);
  });
  it("ignores a trailing slash difference (no sort requested)", () => {
    expect(isRedirectAway("https://x.co/collections/all", "https://x.co/collections/all/")).toBe(false);
  });
  it("does not flag a dropped non-sort query param", () => {
    expect(isRedirectAway("https://x.co/collections/all?page=2", "https://x.co/collections/all")).toBe(false);
  });
  it("flags a redirect to a different product", () => {
    expect(isRedirectAway("https://x.co/products/a", "https://x.co/products/b")).toBe(true);
  });
});

function htmlResponse(html: string, status = 200, server = "nginx"): Response {
  const res = new Response(html, { status, headers: { "content-type": "text/html", server } });
  return res;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchPageDirect", () => {
  it("returns HTML + <title> for a normal page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      const r = htmlResponse("<html><head><title> Elegante Kanten Jurk - Aocadia </title></head><body>x</body></html>");
      Object.defineProperty(r, "url", { value: "https://shop.example/products/x" });
      return r;
    }));
    const page = await fetchPageDirect("https://shop.example/products/x");
    expect(page.title).toBe("Elegante Kanten Jurk - Aocadia");
    expect(page.html).toContain("<title>");
  });

  it("throws PAGE_LOAD_FAILED on a Cloudflare challenge body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      const r = htmlResponse("<html><head><title>Just a moment...</title></head></html>", 200, "cloudflare");
      Object.defineProperty(r, "url", { value: "https://shop.example/products/x" });
      return r;
    }));
    await expect(fetchPageDirect("https://shop.example/products/x")).rejects.toBeInstanceOf(CheckError);
  });

  it("retries direct when the proxied fetch is blocked", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (fetchMock.mock.calls.length === 1) {
        const r = htmlResponse("<html><head><title>Just a moment...</title></head></html>", 403, "cloudflare");
        Object.defineProperty(r, "url", { value: url });
        return r;
      }
      const r = htmlResponse("<html><head><title>Recovered</title></head><body>ok</body></html>");
      Object.defineProperty(r, "url", { value: url });
      return r;
    });
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchPageDirect("https://shop.example/products/x");
    expect(page.title).toBe("Recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("loadPageOrFetch", () => {
  it("falls back to direct fetch when the browser session is blocked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      const r = htmlResponse("<html><head><title>Real Product</title></head><body>ok</body></html>");
      Object.defineProperty(r, "url", { value: "https://shop.example/products/x" });
      return r;
    }));
    const session = {
      loadPage: vi.fn(async () => {
        throw new CheckError("PAGE_LOAD_FAILED", "Page returned HTTP 403.");
      }),
    };
    let fallbackReason = "";
    const page = await loadPageOrFetch(
      "https://shop.example/products/x",
      { scrollProfile: "product" },
      session,
      (reason) => (fallbackReason = reason),
    );
    expect(session.loadPage).toHaveBeenCalledOnce();
    expect(page.title).toBe("Real Product");
    expect(fallbackReason).toContain("403");
  });

  it("uses the browser result when it succeeds (no fetch)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const session = {
      loadPage: vi.fn(async () => ({ finalUrl: "https://shop.example/products/x", html: "<html></html>", title: "Browser Title" })),
    };
    const page = await loadPageOrFetch("https://shop.example/products/x", { scrollProfile: "product" }, session);
    expect(page.title).toBe("Browser Title");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
