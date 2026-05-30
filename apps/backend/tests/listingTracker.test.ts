import { describe, it, expect, vi, afterEach } from "vitest";
import { extractListingItems } from "../src/services/listingTracker.js";

/** A Shopify-style collection page with products already in best-selling order. */
function collectionHtml(handles: string[]): string {
  const cards = handles
    .map(
      (h) =>
        `<li class="card"><a href="/products/${h}"><img src="/cdn/${h}.jpg"><span>${h} title</span></a></li>`,
    )
    .join("");
  return `<html><body><ul class="grid">${cards}</ul></body></html>`;
}

function jsonResponse(body: unknown): Response {
  // `Response.url` is empty when built via the constructor; callers stub it.
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractListingItems — plain-fetch HTML tier (auto)", () => {
  it("preserves DOM order as best-selling rank without launching a browser", async () => {
    const order = ["mattis-1", "alaric", "bawelniana", "benjamin"];
    const fetchMock = vi.fn(async (input: string | URL) => {
      const u = new URL(input.toString());
      // Page 1 → product grid; later pages → empty (ends pagination).
      const page = Number(u.searchParams.get("page") ?? "1");
      const html = page === 1 ? collectionHtml(order) : "<html><body></body></html>";
      const res = new Response(html, { status: 200, headers: { "content-type": "text/html" } });
      Object.defineProperty(res, "url", { value: u.toString() });
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);

    const url = new URL("https://shop.example/collections/all?sort_by=best-selling");
    const result = await extractListingItems(url, "auto", 100, 3);

    expect(result.sourceUsed).toBe("html");
    expect(result.rawMetadata.tier).toBe("fetched-html");
    expect(result.rawMetadata.orderReliable).toBe(true);
    expect(result.items.map((i) => i.rank)).toEqual([1, 2, 3, 4]);
    expect(result.items.map((i) => i.handle)).toEqual(order);
    // Best-seller must be rank #1, not buried later.
    expect(result.items[0]?.handle).toBe("mattis-1");
  });
});

describe("extractListingItems — shopify_json fallback warns about lost sort order", () => {
  it("flags order as unreliable when sort_by is present", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const u = new URL(input.toString());
      const page = Number(u.searchParams.get("page") ?? "1");
      const products =
        page === 1
          ? [
              { id: 1, handle: "alaric", title: "Alaric" },
              { id: 2, handle: "mattis-1", title: "Mattis 1" },
            ]
          : [];
      const res = jsonResponse({ products });
      Object.defineProperty(res, "url", { value: u.toString() });
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);

    const url = new URL("https://shop.example/collections/all?sort_by=best-selling");
    const result = await extractListingItems(url, "shopify_json", 100, 3);

    expect(result.sourceUsed).toBe("shopify_json");
    expect(result.items.length).toBe(2);
    expect(result.rawMetadata.orderReliable).toBe(false);
    expect(result.warnings.some((w) => w.includes("Best-selling order could not be preserved"))).toBe(true);
  });

  it("does not warn when no sort_by is requested", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const u = new URL(input.toString());
      const page = Number(u.searchParams.get("page") ?? "1");
      const products = page === 1 ? [{ id: 1, handle: "alaric", title: "Alaric" }] : [];
      const res = jsonResponse({ products });
      Object.defineProperty(res, "url", { value: u.toString() });
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);

    const url = new URL("https://shop.example/collections/all");
    const result = await extractListingItems(url, "shopify_json", 100, 3);

    expect(result.rawMetadata.orderReliable).toBe(true);
    expect(result.warnings.some((w) => w.includes("Best-selling order"))).toBe(false);
  });
});
