import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withBrowserSession: vi.fn(),
  buildRealisticHeaders: vi.fn(() => ({})),
  fetchDirect: vi.fn(),
  isBlockedResponse: vi.fn(() => false),
  isProxyConfigured: vi.fn(() => true),
  isProxyRotating: vi.fn(() => true),
  proxyFetch: vi.fn(),
}));

vi.mock("../src/services/pageLoader.js", () => ({
  withBrowserSession: mocks.withBrowserSession,
}));

vi.mock("../src/services/antiBlock.js", () => ({
  buildRealisticHeaders: mocks.buildRealisticHeaders,
  fetchDirect: mocks.fetchDirect,
  isBlockedResponse: mocks.isBlockedResponse,
  isProxyConfigured: mocks.isProxyConfigured,
  isProxyRotating: mocks.isProxyRotating,
  proxyFetch: mocks.proxyFetch,
}));

import { extractListingItems } from "../src/services/listingTracker.js";

function jsonResponse(body: unknown, url: string): Response {
  const res = new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(res, "url", { value: url });
  return res;
}

function htmlResponse(html: string, url: string): Response {
  const res = new Response(html, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  Object.defineProperty(res, "url", { value: url });
  return res;
}

function collectionHtml(handles: string[]): string {
  const links = handles.map((handle) => `<a href="/products/${handle}">${handle}</a>`).join("");
  return `<html><body><ul id="product-grid">${links}</ul></body></html>`;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("extractListingItems, auto browser retry on rotating proxy", () => {
  it("retries browser HTML in auto mode when fetched HTML is empty and the first browser render has no products", async () => {
    mocks.proxyFetch.mockImplementation(async (input: string | URL) => {
      const url = input.toString();
      if (url.includes("/products.json")) {
        return jsonResponse({ products: [{ id: 1, handle: "default-first", title: "Default First" }] }, url);
      }
      return htmlResponse("<html><body><h1>Produits</h1></body></html>", url);
    });

    let browserAttempts = 0;
    mocks.withBrowserSession.mockImplementation(async (fn: (session: { loadPage(url: string): Promise<{ finalUrl: string; html: string; title: string }> }) => Promise<unknown>) => {
      browserAttempts += 1;
      const html =
        browserAttempts === 1
          ? "<html><body><a href=\"/search\">search</a></body></html>"
          : collectionHtml(["best-1", "best-2", "best-3"]);
      return fn({
        loadPage: vi.fn(async (url: string) => ({ finalUrl: url, html, title: "Produits" })),
      });
    });

    const result = await extractListingItems(
      new URL("https://shop.example/collections/all?sort_by=best-selling"),
      "auto",
      50,
      1,
    );

    expect(browserAttempts).toBe(2);
    expect(result.sourceUsed).toBe("both");
    expect(result.rawMetadata.orderReliable).toBe(true);
    expect(result.items.map((item) => item.handle).slice(0, 3)).toEqual(["best-1", "best-2", "best-3"]);
    expect(result.items[0]?.handle).not.toBe("default-first");
  });
});
