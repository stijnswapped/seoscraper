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

function collectionPixelsHtml(handles: string[]): string {
  const variants = handles.map((handle, index) => ({
    price: { amount: 19.95 + index, currencyCode: "EUR" },
    product: {
      id: String(1000 + index),
      title: `${handle} title`,
      url: `/products/${handle}`,
    },
    id: String(2000 + index),
    image: { src: `//cdn.shop.example/${handle}.jpg` },
    title: "Default",
  }));
  const dataEvents = JSON.stringify([["page_viewed", {}], ["collection_viewed", { collection: { title: "Produits", productVariants: variants } }]]);
  return `<html><body>
    <script data-page-type="collection" data-events="${dataEvents.replace(/"/g, "&quot;")}"></script>
  </body></html>`;
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

describe("extractListingItems, plain-fetch HTML tier (auto)", () => {
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

  it("falls back to Shopify collection_viewed pixel data when the rendered page has no product anchors", async () => {
    const order = ["best-1", "best-2", "best-3"];
    fetchHtmlPage1(collectionPixelsHtml(order));

    const result = await extractListingItems(
      new URL("https://shop.example/collections/all?sort_by=best-selling"),
      "html",
      100,
      1,
    );

    expect(result.items.map((i) => i.handle)).toEqual(order);
    expect(result.items.map((i) => i.title)).toEqual(order.map((handle) => `${handle} title`));
    expect(result.items[0]?.imageUrl).toBe("https://cdn.shop.example/best-1.jpg");
  });

  it("prefers the canonical products.json title over an SEO-suffixed HTML title", async () => {
    // HTML exposes "H.D Balboa Shorts - Handsome Dans" (store-name suffix);
    // products.json has the clean canonical title, which must win.
    const html = `<html><body><ul id="product-grid">
      <li class="card"><a href="/products/balboa" aria-label="H.D Balboa Shorts - Handsome Dans"><img src="/b.jpg"></a></li>
    </ul></body></html>`;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const u = new URL(input.toString());
      if (u.pathname.endsWith("/products.json")) {
        const products =
          Number(u.searchParams.get("page") ?? "1") === 1
            ? [{ id: 1, handle: "balboa", title: "H.D Balboa Shorts" }]
            : [];
        const res = jsonResponse({ products });
        Object.defineProperty(res, "url", { value: u.toString() });
        return res;
      }
      const page = Number(u.searchParams.get("page") ?? "1");
      const res = new Response(page === 1 ? html : "<html><body></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(res, "url", { value: u.toString() });
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractListingItems(
      new URL("https://shop.example/collections/all?sort_by=best-selling"),
      "auto",
      100,
      1,
    );
    expect(result.items[0]?.title).toBe("H.D Balboa Shorts");
    // titleSeo keeps the raw storefront/SEO-flavored title for the toggle.
    expect(result.items[0]?.titleSeo).toBe("H.D Balboa Shorts - Handsome Dans");
  });

  it("populates titleSeo from the product title when the grid has no distinct title", async () => {
    // products.json-enriched item whose HTML grid title equals the canonical one:
    // titleSeo must still be present (falls back to the product title) so the
    // toggle never yields an empty value.
    const html = `<html><body><ul id="product-grid">
      <li class="card"><a href="/products/p1"><img src="/p1.jpg"></a></li>
    </ul></body></html>`;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const u = new URL(input.toString());
      if (u.pathname.endsWith("/products.json")) {
        const products =
          Number(u.searchParams.get("page") ?? "1") === 1
            ? [{ id: 1, handle: "p1", title: "Linen Shirt" }]
            : [];
        const res = jsonResponse({ products });
        Object.defineProperty(res, "url", { value: u.toString() });
        return res;
      }
      const page = Number(u.searchParams.get("page") ?? "1");
      const res = new Response(page === 1 ? html : "<html><body></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(res, "url", { value: u.toString() });
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractListingItems(
      new URL("https://shop.example/collections/all?sort_by=best-selling"),
      "auto",
      100,
      1,
    );
    expect(result.items[0]?.title).toBe("Linen Shirt");
    expect(result.items[0]?.titleSeo).toBe("Linen Shirt");
  });

  it("enriches a best-seller that lives on a later products.json page (full index)", async () => {
    // The best-seller's handle is NOT among the first products.json page in default
    // order — it's on page 2. The enrichment index must page past maxProducts to
    // find it; otherwise productId/canonical title silently never land.
    const htmlGrid = `<ul id="product-grid"><li class="card"><a href="/products/target"><img src="/t.jpg"></a></li></ul>`;
    const page1 = Array.from({ length: 250 }, (_, i) => ({ id: 1000 + i, handle: `filler-${i}`, title: `Filler ${i}` }));
    const page2 = [{ id: 9999, handle: "target", title: "Canonical Target Title" }];
    const fetchMock = vi.fn(async (input: string | URL) => {
      const u = new URL(input.toString());
      if (u.pathname.endsWith("/products.json")) {
        const page = Number(u.searchParams.get("page") ?? "1");
        const products = page === 1 ? page1 : page === 2 ? page2 : [];
        const res = jsonResponse({ products });
        Object.defineProperty(res, "url", { value: u.toString() });
        return res;
      }
      const page = Number(u.searchParams.get("page") ?? "1");
      const res = new Response(page === 1 ? `<html><body>${htmlGrid}</body></html>` : "<html><body></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(res, "url", { value: u.toString() });
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);

    // maxProducts=10 would have stopped the old index inside page 1, never reaching `target`.
    const result = await extractListingItems(
      new URL("https://shop.example/collections/all?sort_by=best-selling"),
      "auto",
      10,
      5,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.handle).toBe("target");
    expect(result.items[0]?.title).toBe("Canonical Target Title");
    expect(result.items[0]?.productId).toBe("9999");
    expect(result.items[0]?.source).toBe("both");
  });

  it("decodes a percent-encoded handle so it stays clean and matches products.json", async () => {
    // boutique-elegance: grid href is /products/akrisna%E2%84%A2-bra, products.json
    // reports the decoded handle "akrisna™-bra". The decoded form must be the key
    // (so they match + enrich), while the url field stays percent-encoded.
    const html = `<html><body><ul id="product-grid">
      <li class="card"><a href="/products/akrisna%E2%84%A2-bra"><img src="/a.jpg"></a></li>
    </ul></body></html>`;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const u = new URL(input.toString());
      if (u.pathname.endsWith("/products.json")) {
        const products =
          Number(u.searchParams.get("page") ?? "1") === 1
            ? [{ id: 55, handle: "akrisna™-bra", title: "Akrisna Bra" }]
            : [];
        const res = jsonResponse({ products });
        Object.defineProperty(res, "url", { value: u.toString() });
        return res;
      }
      const page = Number(u.searchParams.get("page") ?? "1");
      const res = new Response(page === 1 ? html : "<html><body></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(res, "url", { value: u.toString() });
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractListingItems(
      new URL("https://shop.example/collections/all?sort_by=best-selling"),
      "auto",
      100,
      1,
    );
    expect(result.items[0]?.handle).toBe("akrisna™-bra");
    expect(result.items[0]?.productKey).toBe("handle:akrisna™-bra");
    expect(result.items[0]?.url).toContain("akrisna%E2%84%A2-bra"); // url stays encoded
    expect(result.items[0]?.title).toBe("Akrisna Bra"); // enrichment matched on the decoded handle
    expect(result.items[0]?.productId).toBe("55");
    expect(result.items[0]?.source).toBe("both");
  });

  it("strips the store-name suffix from an HTML-only title (og:site_name)", async () => {
    const html = `<html><head>
        <meta property="og:site_name" content="Handsome Dans">
      </head><body><ul id="product-grid">
        <li class="card"><a href="/products/balboa" aria-label="H.D Balboa Shorts - Handsome Dans"><img src="/b.jpg"></a></li>
        <li class="card"><a href="/products/eden" aria-label="H.D Eden Shorts | Handsome Dans"><img src="/e.jpg"></a></li>
      </ul></body></html>`;
    fetchHtmlPage1(html);

    const result = await extractListingItems(
      new URL("https://shop.example/collections/all?sort_by=best-selling"),
      "html",
      100,
      1,
    );
    expect(result.items.map((i) => i.title)).toEqual(["H.D Balboa Shorts", "H.D Eden Shorts"]);
  });

  it("does NOT strip a dash that is part of the real product name", async () => {
    const html = `<html><head><meta property="og:site_name" content="Handsome Dans"></head>
      <body><ul id="product-grid">
        <li class="card"><a href="/products/tee" aria-label="Classic Tee - Black"><img src="/t.jpg"></a></li>
      </ul></body></html>`;
    fetchHtmlPage1(html);

    const result = await extractListingItems(
      new URL("https://shop.example/collections/all?sort_by=best-selling"),
      "html",
      100,
      1,
    );
    expect(result.items[0]?.title).toBe("Classic Tee - Black");
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

  it("canonicalizes collection-scoped grid links to /products/<handle>", async () => {
    // Some themes (handsomedans, arlento, …) render product links scoped under
    // the collection: /collections/all/products/<handle>. The canonical product
    // URL is /products/<handle>; the collection prefix must be stripped.
    const html = `<html><body><ul class="grid">
      <li class="card"><a href="/collections/all/products/balboa"><img src="/b.jpg"><span>Balboa</span></a></li>
      <li class="card"><a href="/collections/best-sellers/products/eden/"><img src="/e.jpg"><span>Eden</span></a></li>
    </ul></body></html>`;
    fetchHtmlPage1(html);

    const result = await extractListingItems(
      new URL("https://shop.example/collections/all?sort_by=best-selling"),
      "html",
      100,
      1,
    );
    expect(result.items.map((i) => i.url)).toEqual([
      "https://shop.example/products/balboa",
      "https://shop.example/products/eden",
    ]);
    expect(result.items.map((i) => i.handle)).toEqual(["balboa", "eden"]);
  });

  it("preserves a locale prefix while stripping the collection scope", async () => {
    // deloxusa-style: /fr-fr/collections/all/products/<handle> → /fr-fr/products/<handle>.
    const html = `<html><body><ul class="grid">
      <li class="card"><a href="/fr-fr/collections/all/products/hoodie"><img src="/h.jpg"><span>Hoodie</span></a></li>
    </ul></body></html>`;
    fetchHtmlPage1(html);

    const result = await extractListingItems(
      new URL("https://shop.example/fr-fr/collections/all?sort_by=best-selling"),
      "html",
      100,
      1,
    );
    expect(result.items[0]?.url).toBe("https://shop.example/fr-fr/products/hoodie");
    expect(result.items[0]?.handle).toBe("hoodie");
  });

  it("keys identity on handle even when products.json enrichment supplies a productId", async () => {
    // The productId must NOT be promoted into productKey: a product that gains or
    // loses its id between runs (flaky/blocked products.json) would otherwise flip
    // identity and show up as both `missing` and `new`. Key stays handle:<handle>.
    const html = `<html><body><ul id="product-grid">
      <li class="card"><a href="/products/balboa"><img src="/b.jpg"><span>Balboa</span></a></li>
    </ul></body></html>`;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const u = new URL(input.toString());
      if (u.pathname.endsWith("/products.json")) {
        const products =
          Number(u.searchParams.get("page") ?? "1") === 1
            ? [{ id: 99887766, handle: "balboa", title: "H.D Balboa Shorts" }]
            : [];
        const res = jsonResponse({ products });
        Object.defineProperty(res, "url", { value: u.toString() });
        return res;
      }
      const page = Number(u.searchParams.get("page") ?? "1");
      const res = new Response(page === 1 ? html : "<html><body></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(res, "url", { value: u.toString() });
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractListingItems(
      new URL("https://shop.example/collections/all?sort_by=best-selling"),
      "auto",
      100,
      1,
    );
    expect(result.items[0]?.productKey).toBe("handle:balboa");
    expect(result.items[0]?.productId).toBe("99887766"); // id kept as an attribute
    expect(result.items[0]?.source).toBe("both");
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

describe("extractListingItems, ranks the real grid, not menu/upsell links", () => {
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

  it("ranks a grid wrapped in a collection 'filters-drawer' container (sendowear theme)", async () => {
    // The whole product grid lives inside `collection collection--filters-drawer`.
    // A bare `[class*="drawer"]` exclusion wrongly dropped it, leaving 0 products.
    const order = ["emmie", "elena", "silas"];
    const links = order.map((h) => `<a href="/products/${h}">${h}</a>`).join("");
    const html = `<html><body>
      <header><a href="/products/${order[0]}">menu link</a></header>
      <div class="collection collection--filters-drawer">${links}</div>
    </body></html>`;
    fetchHtmlPage1(html);

    const result = await extractListingItems(
      new URL("https://shop.example/collections/all?sort_by=best-selling"),
      "html",
      100,
      1,
    );
    expect(result.items.map((i) => i.handle)).toEqual(order);
    expect(result.items[0]?.handle).toBe("emmie");
  });

  it("still excludes a real cart drawer's product links", async () => {
    const html = `<html><body>
      <div class="drawer cart-drawer"><a href="/products/in-cart-item">in cart</a></div>
      <ul id="product-grid"><a href="/products/g1">g1</a><a href="/products/g2">g2</a></ul>
    </body></html>`;
    fetchHtmlPage1(html);

    const result = await extractListingItems(
      new URL("https://shop.example/collections/all?sort_by=best-selling"),
      "html",
      100,
      1,
    );
    expect(result.items.map((i) => i.handle)).toEqual(["g1", "g2"]);
    expect(result.items.map((i) => i.handle)).not.toContain("in-cart-item");
  });

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

describe("extractListingItems, retries DIRECT when the proxied HTML fetch is blocked", () => {
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

describe("extractListingItems, follows safe collection redirects (locale / www)", () => {
  it("follows a locale-prefix redirect (e.g. /en-us) and ranks the real sorted grid", async () => {
    const order = ["best-1", "second-2", "third-3"];
    const fetchMock = vi.fn(async (input: string | URL) => {
      const u = new URL(input.toString());
      // products.json: also locale-redirects; once localized it returns a
      // DEFAULT-order product that must NOT win the ranking.
      if (u.pathname.endsWith("/products.json")) {
        if (!u.pathname.startsWith("/en-us")) {
          const r = new Response(null, {
            status: 302,
            headers: { location: `https://shop.example/en-us${u.pathname}${u.search}` },
          });
          Object.defineProperty(r, "url", { value: u.toString() });
          return r;
        }
        const products =
          Number(u.searchParams.get("page") ?? "1") === 1
            ? [{ id: 1, handle: "alpha-default", title: "Alpha Default" }]
            : [];
        const res = jsonResponse({ products });
        Object.defineProperty(res, "url", { value: u.toString() });
        return res;
      }
      // HTML: the non-localized collection 302s to /en-us (same listing).
      if (!u.pathname.startsWith("/en-us")) {
        const r = new Response("redirecting", {
          status: 302,
          headers: { location: `https://shop.example/en-us${u.pathname}${u.search}` },
        });
        Object.defineProperty(r, "url", { value: u.toString() });
        return r;
      }
      const page = Number(u.searchParams.get("page") ?? "1");
      const res = new Response(page === 1 ? collectionHtml(order) : "<html><body></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(res, "url", { value: u.toString() });
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);

    const url = new URL("https://shop.example/collections/all?sort_by=best-selling");
    const result = await extractListingItems(url, "auto", 100, 2);

    expect(result.items.map((i) => i.handle).slice(0, 3)).toEqual(order);
    expect(result.items[0]?.handle).toBe("best-1");
    expect(result.rawMetadata.orderReliable).toBe(true);
    expect(result.items.map((i) => i.handle)).not.toContain("alpha-default");
  });

  it("does NOT follow a redirect to a different collection handle", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const u = new URL(input.toString());
      if (u.pathname.endsWith("/products.json")) {
        const res = jsonResponse({ products: [] });
        Object.defineProperty(res, "url", { value: u.toString() });
        return res;
      }
      // /collections/all 301s to a DIFFERENT collection — must be refused.
      const r = new Response("moved", {
        status: 301,
        headers: { location: "https://shop.example/collections/sale?sort_by=best-selling" },
      });
      Object.defineProperty(r, "url", { value: u.toString() });
      return r;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCollectionPageHtml(
      "https://shop.example/collections/all?sort_by=best-selling",
      "https://shop.example",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning).toContain("different collection");
  });
});

describe("extractListingItems, excludes cart add-ons / gift cards from ranks", () => {
  it("drops shipping-protection and gift-card handles from the grid", async () => {
    fetchHtmlPage1(collectionHtml(["shipping-protection", "real-product-1", "gift-card", "real-product-2"]));
    const url = new URL("https://shop.example/collections/all?sort_by=best-selling");
    const result = await extractListingItems(url, "html", 100, 1);

    expect(result.items.map((i) => i.handle)).toEqual(["real-product-1", "real-product-2"]);
    expect(result.items[0]?.handle).toBe("real-product-1");
  });
});

describe("extractListingItems, shopify_json fallback warns about lost sort order", () => {
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
