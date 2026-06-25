import { describe, it, expect } from "vitest";
import { extractMetadata } from "../src/services/metadataExtractor.js";
import { extractProduct } from "../src/services/productExtractor.js";
import { discoverImages } from "../src/services/imageDiscovery.js";

const URL = "https://www.shop.example/products/klarissa";

describe("product title vs page title", () => {
  it("prefers the <h1> when og:title just echoes the page <title>", () => {
    const html = `<html><head>
      <title>Elegante Kanten Jurk - Aocadia</title>
      <meta property="og:title" content="Elegante Kanten Jurk - Aocadia">
    </head><body><h1>Klarissa | Elegante Kanten Jurk Dames</h1></body></html>`;
    const meta = extractMetadata(html, URL);
    const product = extractProduct(meta);
    expect(meta.seo.title.value).toBe("Elegante Kanten Jurk - Aocadia");
    expect(product.title.value).toBe("Klarissa | Elegante Kanten Jurk Dames");
    expect(product.title.source).toBe("h1");
  });

  it("keeps og:title when it differs from the page title", () => {
    const html = `<html><head>
      <title>Klarissa | Buy now - Aocadia</title>
      <meta property="og:title" content="Klarissa Lace Dress">
    </head><body><h1>Some generic heading</h1></body></html>`;
    const meta = extractMetadata(html, URL);
    const product = extractProduct(meta);
    expect(product.title.value).toBe("Klarissa Lace Dress");
    expect(product.title.source).toBe("og:title");
  });

  it("still prefers JSON-LD Product.name above all", () => {
    const html = `<html><head>
      <title>SEO - Brand</title>
      <meta property="og:title" content="OG distinct">
      <script type="application/ld+json">{"@type":"Product","name":"LD Name"}</script>
    </head><body><h1>H1 Name</h1></body></html>`;
    const meta = extractMetadata(html, URL);
    expect(extractProduct(meta).title.value).toBe("LD Name");
  });

  it("falls back to JSON-LD ProductGroup.name when Product is absent", () => {
    const html = `<html><head>
      <title>SEO - Brand</title>
      <script type="application/ld+json">{"@type":"ProductGroup","name":"Group Name","description":"Group Desc"}</script>
    </head><body></body></html>`;
    const meta = extractMetadata(html, URL);
    const product = extractProduct(meta);
    expect(product.title.value).toBe("Group Name");
    expect(product.title.source).toBe("jsonld:Product.name");
    expect(product.description.value).toBe("Group Desc");
    expect(product.structuredData).toHaveLength(1);
  });
});

describe("image discovery placeholder filtering", () => {
  it("skips unrendered template placeholders like <IMAGE_URL>", () => {
    const html = `<html><head>
      <meta property="og:image" content="https://cdn.example/real-main.jpg">
    </head><body><main>
      <img src="<IMAGE_URL>">
      <img src="{{ product.image }}">
      <img src="https://cdn.example/real-gallery.jpg">
    </main></body></html>`;
    const meta = extractMetadata(html, URL);
    const imgs = discoverImages(meta, URL).map((i) => i.normalizedUrl);
    expect(imgs.some((u) => u.includes("IMAGE_URL"))).toBe(false);
    expect(imgs.some((u) => u.includes("%7B") || u.includes("{{"))).toBe(false);
    expect(imgs).toContain("https://cdn.example/real-main.jpg");
    expect(imgs).toContain("https://cdn.example/real-gallery.jpg");
  });
});
