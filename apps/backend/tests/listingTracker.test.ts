import { describe, it, expect, vi, afterEach } from "vitest";
import { extractListingItems, fetchCollectionPageHtml } from "../src/services/listingTracker.js";

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

    // auto = html order (+ json enrichment; json is empty in this mock).
    expect(result.sourceUsed).toBe("html");
    expect(result.rawMetadata.orderReliable).toBe(true);
    expect(result.items.map((i) => i.rank)).toEqual([1, 2, 3, 4]);
    expect(result.items.map((i) => i.handle)).toEqual(order);
    // Best-seller must be rank #1, not buried later.
    expect(result.items[0]?.handle).toBe("mattis-1");
  });

  it("extracts titles from image-only anchors (img alt / card heading)", async () => {
    const html = `<html><body><ul class="grid">
      <li class="card"><a href="/products/p1">Text Title One</a></li>
      <li class="card"><a href="/products/p2"><img src="/i2.jpg" alt="Alt Title Two"></a></li>
      <li class="card"><a href="/products/p3"><img src="/i3.jpg"></a><h3 class="card__title">Heading Title Three</h3></li>
    </ul></body></html>`;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const u = new URL(input.toString());
      const page = Number(u.searchParams.get("page") ?? "1");
      const res = new Response(page === 1 ? html : "<html><body></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(res, "url", { value: u.toString() });
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);

    const url = new URL("https://shop.example/collections/all?sort_by=best-selling");
    const result = await extractListingItems(url, "html", 100, 2);

    expect(result.items.map((i) => i.title)).toEqual([
      "Text Title One",
      "Alt Title Two",
      "Heading Title Three",
    ]);
  });

  it("combines duplicate image/title anchors from the same product card", async () => {
    const html = `<html><body><ul class="grid">
      <li class="card">
        <a class="card-media" href="/products/p1">
          <span>Varsovia Moda</span>
          <img data-srcset="//cdn.shop.example/p1_800x.jpg 800w, //cdn.shop.example/p1_400x.jpg 400w" alt="Image Alt Title One">
        </a>
        <a class="card-title" href="/products/p1" data-product-title="Real Product Title One">
          <span>Real Product Title One</span>
        </a>
      </li>
    </ul></body></html>`;
    fetchHtmlPage1(html);

    const url = new URL("https://shop.example/collections/all?sort_by=best-selling");
    const result = await extractListingItems(url, "html", 100, 2);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("Image Alt Title One");
    expect(result.items[0]?.imageUrl).toBe("https://cdn.shop.example/p1_800x.jpg");
  });
});

/**
 * A collection page that renders an "add-on products" upsell block (identical
 * across sorts) BEFORE the real grid, mirroring hausofmode.de. `gridContainer`
 * lets us exercise both grid markers (data-section-type and #product-grid).
 */
function pageWithUpsellAboveGrid(
  upsell: string[],
  grid: string[],
  gridContainer: "data-section" | "id",
): string {
  const links = (handles: string[]) =>
    handles.map((h) => `<a href="/products/${h}">${h}</a>`).join("");
  const open =
    gridContainer === "data-section"
      ? '<div data-section-type="collection-grid">'
      : '<ul id="product-grid">';
  const close = gridContainer === "data-section" ? "</div>" : "</ul>";
  return `<html><body>
    <header><a href="/products/${grid[0]}">menu link to a product</a></header>
    <div class="add-on-products">${links(upsell)}</div>
    ${open}${links(grid)}${close}
  </body></html>`;
}

function fetchHtmlPage1(html: string) {
  const mock = vi.fn(async (input: string | URL) => {
    const u = new URL(input.toString());
    const page = Number(u.searchParams.get("page") ?? "1");
    const res = new Response(page === 1 ? html : "<html><body></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    Object.defineProperty(res, "url", { value: u.toString() });
    return res;
  });
  vi.stubGlobal("fetch", mock);
}

describe("extractListingItems — ranks the real grid, not menu/upsell links", () => {
  it.each(["data-section", "id"] as const)(
    "ignores an add-on-products upsell block above the grid (%s marker)",
    async (marker) => {
      fetchHtmlPage1(
        pageWithUpsellAboveGrid(["upsell-a", "upsell-b"], ["x", "y", "z"], marker),
      );
      const url = new URL("https://shop.example/collections/all?sort_by=best-selling");
      const result = await extractListingItems(url, "html", 100, 2);

      // Grid order wins; the upsell + header links never enter the ranking.
      expect(result.items.map((i) => i.handle)).toEqual(["x", "y", "z"]);
      expect(result.items.map((i) => i.handle)).not.toContain("upsell-a");
      expect(result.items[0]?.handle).toBe("x");
    },
  );

  it("yields different top items for different grid order (sorted vs default)", async () => {
    fetchHtmlPage1(
      pageWithUpsellAboveGrid(["upsell-a", "upsell-b"], ["best-1", "best-2", "best-3"], "data-section"),
    );
    const sorted = await extractListingItems(
      new URL("https://shop.example/collections/all?sort_by=best-selling"),
      "html",
      100,
      1,
    );

    fetchHtmlPage1(
      pageWithUpsellAboveGrid(["upsell-a", "upsell-b"], ["alpha", "beta", "gamma"], "data-section"),
    );
    const def = await extractListingItems(
      new URL("https://shop.example/collections/all"),
      "html",
      100,
      1,
    );

    expect(sorted.items[0]?.handle).toBe("best-1");
    expect(def.items[0]?.handle).toBe("alpha");
    expect(sorted.items[0]?.handle).not.toBe(def.items[0]?.handle);
  });
});

describe("extractListingItems — retries DIRECT when the proxied HTML fetch is blocked", () => {
  const ORIGINAL_PROXY = process.env.SCRAPE_PROXY_URL;
  afterEach(() => {
    if (ORIGINAL_PROXY === undefined) delete process.env.SCRAPE_PROXY_URL;
    else process.env.SCRAPE_PROXY_URL = ORIGINAL_PROXY;
  });

  it("recovers the sorted grid when the proxy IP is challenged (Cloudflare) but the origin IP isn't", async () => {
    // With a proxy configured, the first (proxied) attempt at page 1 is blocked;
    // the code must retry DIRECT and use that correctly-sorted grid — not silently
    // fall back to products.json's default order.
    process.env.SCRAPE_PROXY_URL = "http://user:pass@127.0.0.1:9";
    const sorted = ["best-seller", "second", "third"];
    let page1Attempts = 0;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const u = new URL(input.toString());
      // products.json (the unsorted fallback) returns the DEFAULT order — if the
      // direct retry didn't work, this is what we'd wrongly rank by.
      if (u.pathname.endsWith("/products.json")) {
        const products =
          Number(u.searchParams.get("page") ?? "1") === 1
            ? [{ id: 9, handle: "default-first", title: "Default First" }]
            : [];
        const res = jsonResponse({ products });
        Object.defineProperty(res, "url", { value: u.toString() });
        return res;
      }
      const page = Number(u.searchParams.get("page") ?? "1");
      if (page === 1) {
        page1Attempts += 1;
        // 1st hit = proxied attempt → Cloudflare 403 block; 2nd hit = direct retry → real grid.
        if (page1Attempts === 1) {
          const blocked = new Response("blocked", { status: 403, headers: { server: "cloudflare" } });
          Object.defineProperty(blocked, "url", { value: u.toString() });
          return blocked;
        }
        const res = new Response(collectionHtml(sorted), { status: 200, headers: { "content-type": "text/html" } });
        Object.defineProperty(res, "url", { value: u.toString() });
        return res;
      }
      const res = new Response("<html><body></body></html>", { status: 200, headers: { "content-type": "text/html" } });
      Object.defineProperty(res, "url", { value: u.toString() });
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);

    const url = new URL("https://shop.example/collections/all?sort_by=best-selling");
    const result = await extractListingItems(url, "auto", 100, 3);

    expect(page1Attempts).toBeGreaterThanOrEqual(2); // proxied block + direct retry
    expect(result.rawMetadata.orderReliable).toBe(true);
    expect(result.items[0]?.handle).toBe("best-seller");
    expect(result.items.map((i) => i.handle)).toEqual(sorted);
    expect(result.items.map((i) => i.handle)).not.toContain("default-first");
  });

  it("does NOT retry the blocked fetch when no proxy is configured (a direct retry would hit the same wall)", async () => {
    delete process.env.SCRAPE_PROXY_URL;
    let attempts = 0;
    const fetchMock = vi.fn(async (input: string | URL) => {
      attempts += 1;
      const res = new Response("blocked", { status: 403, headers: { server: "cloudflare" } });
      Object.defineProperty(res, "url", { value: input.toString() });
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCollectionPageHtml("https://shop.example/collections/all?sort_by=best-selling", "https://shop.example");

    expect(result.ok).toBe(false);
    expect(attempts).toBe(1); // blocked once, no direct retry without a proxy
  });

  it("DOES retry direct on a block when a proxy is configured, and surfaces the recovered HTML", async () => {
    process.env.SCRAPE_PROXY_URL = "http://user:pass@127.0.0.1:9";
    let attempts = 0;
    const fetchMock = vi.fn(async (input: string | URL) => {
      attempts += 1;
      const res =
        attempts === 1
          ? new Response("blocked", { status: 403, headers: { server: "cloudflare" } })
          : new Response("<html><body><ul class='grid'><li><a href='/products/x'>x</a></li></ul></body></html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            });
      Object.defineProperty(res, "url", { value: input.toString() });
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCollectionPageHtml("https://shop.example/collections/all?sort_by=best-selling", "https://shop.example");

    expect(attempts).toBe(2); // proxied block → direct retry
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.viaDirect).toBe(true);
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
