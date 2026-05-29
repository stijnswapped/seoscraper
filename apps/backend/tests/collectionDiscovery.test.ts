import { describe, expect, it } from "vitest";
import { extractMetadata } from "../src/services/metadataExtractor.js";
import { discoverCollectionProducts } from "../src/services/collectionDiscovery.js";

describe("discoverCollectionProducts", () => {
  it("detects Shopify collection pages and extracts visible product links in order", () => {
    const finalUrl = "https://shop.example/collections/all?sort_by=best-selling";
    const html = `
      <html>
        <body>
          <main>
            <a href="/products/red-dress?variant=1">Red Dress</a>
            <a href="https://shop.example/products/blue-shirt#reviews">Blue Shirt</a>
            <a href="/products/red-dress?variant=2">Red Dress duplicate</a>
            <a href="https://other.example/products/not-this-domain">External Product</a>
            <a href="/collections/all?page=2">Next</a>
          </main>
        </body>
      </html>
    `;

    const meta = extractMetadata(html, finalUrl);
    const result = discoverCollectionProducts(meta, finalUrl, 20);

    expect(result.isCollection).toBe(true);
    expect(result.productUrls).toEqual([
      "https://shop.example/products/red-dress",
      "https://shop.example/products/blue-shirt",
    ]);
  });

  it("does not classify a product page with related product links as a collection", () => {
    const finalUrl = "https://shop.example/products/red-dress";
    const html = `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Product",
              "name": "Red Dress"
            }
          </script>
        </head>
        <body>
          <a href="/products/blue-shirt">Blue Shirt</a>
          <a href="/products/green-hat">Green Hat</a>
        </body>
      </html>
    `;

    const meta = extractMetadata(html, finalUrl);
    const result = discoverCollectionProducts(meta, finalUrl, 20);

    expect(result.isCollection).toBe(false);
    expect(result.productUrls).toEqual([
      "https://shop.example/products/blue-shirt",
      "https://shop.example/products/green-hat",
    ]);
  });

  it("honors the configured maximum product count", () => {
    const finalUrl = "https://shop.example/collections/all";
    const html = `
      <html>
        <body>
          <a href="/products/one">One</a>
          <a href="/products/two">Two</a>
          <a href="/products/three">Three</a>
        </body>
      </html>
    `;

    const meta = extractMetadata(html, finalUrl);
    const result = discoverCollectionProducts(meta, finalUrl, 2);

    expect(result.productUrls).toEqual([
      "https://shop.example/products/one",
      "https://shop.example/products/two",
    ]);
  });
});
