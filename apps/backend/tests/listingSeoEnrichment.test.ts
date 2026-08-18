import { describe, it, expect, vi, afterEach } from "vitest";
import { enrichListingItemsWithSeo } from "../src/services/listingSeoEnrichment.js";
import type { ListingRankItem } from "../src/types/productCheck.js";

function item(handle: string): ListingRankItem {
  return {
    rank: 1,
    productKey: `handle:${handle}`,
    url: `https://shop.example/products/${handle}`,
    handle,
    title: `${handle} grid title`,
    source: "html",
  };
}

function productPageHtml(opts: { title: string; description?: string; canonical?: string }): string {
  return `<html><head>
    <title>${opts.title}</title>
    ${opts.description ? `<meta name="description" content="${opts.description}">` : ""}
    ${opts.canonical ? `<link rel="canonical" href="${opts.canonical}">` : ""}
    <meta property="og:title" content="OG ${opts.title}">
  </head><body><h1>${opts.title}</h1></body></html>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("enrichListingItemsWithSeo", () => {
  it("replaces titleSeo with the REAL page SEO title (from <title>), leaving title intact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = new URL(input.toString());
        const handle = u.pathname.split("/").pop() ?? "";
        const html = productPageHtml({ title: `SEO title for ${handle}` });
        const res = new Response(html, { status: 200, headers: { "content-type": "text/html" } });
        Object.defineProperty(res, "url", { value: u.toString() });
        return res;
      }),
    );

    const items = [item("alpha"), item("beta")];
    const result = await enrichListingItemsWithSeo(items);

    expect(result).toEqual({ enriched: 2, failed: 0, warnings: [] });
    // titleSeo is now the authoritative page title; the product title is untouched.
    expect(items[0]?.titleSeo).toBe("SEO title for alpha");
    expect(items[0]?.title).toBe("alpha grid title");
    expect(items[1]?.titleSeo).toBe("SEO title for beta");
  });

  it("isolates failures: a product whose page can't be fetched keeps its grid titleSeo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = new URL(input.toString());
        if (u.pathname.endsWith("/beta")) {
          return new Response("blocked", { status: 503 });
        }
        const res = new Response(productPageHtml({ title: `SEO title for alpha` }), {
          status: 200,
          headers: { "content-type": "text/html" },
        });
        Object.defineProperty(res, "url", { value: u.toString() });
        return res;
      }),
    );

    const items = [item("alpha"), { ...item("beta"), titleSeo: "beta grid title" }];
    const result = await enrichListingItemsWithSeo(items);

    expect(result).toEqual({ enriched: 1, failed: 1, warnings: [] });
    expect(items[0]?.titleSeo).toBe("SEO title for alpha");
    // beta's page failed → keep whatever grid title it already had.
    expect(items[1]?.titleSeo).toBe("beta grid title");
  });
});

describe("enrichListingItemsWithSeo, reports store-side SEO title bugs", () => {
  it("returns ONE warning when every product page's <title> is just the store name", async () => {
    const page = (ogTitle: string) => `
      <html><head>
        <title>Moda Poznań</title>
        <meta property="og:site_name" content="Moda Poznan" />
        <meta property="og:title" content="${ogTitle}" />
      </head></html>`;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      const res = new Response(page(url.endsWith("alpha") ? "Alpha Dress" : "Beta Coat"), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(res, "url", { value: url });
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);

    const items: ListingRankItem[] = [
      { rank: 1, productKey: "handle:alpha", url: "https://modapoznan.com/products/alpha", handle: "alpha", source: "html" },
      { rank: 2, productKey: "handle:beta", url: "https://modapoznan.com/products/beta", handle: "beta", source: "html" },
    ];
    const result = await enrichListingItemsWithSeo(items);

    expect(items.map((i) => i.titleSeo)).toEqual(["Alpha Dress", "Beta Coat"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("only the store name");
  });
});
