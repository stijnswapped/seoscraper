import { describe, it, expect } from "vitest";
import { extractMetadata } from "../src/services/metadataExtractor.js";
import { extractProduct } from "../src/services/productExtractor.js";

describe("extractMetadata & extractProduct Fallbacks", () => {
  const finalUrl = "https://shop.example/products/blue-jeans";

  it("extracts SEO title with highest priority (<title> tag)", () => {
    const html = `
      <html>
        <head>
          <title>Title Tag Value</title>
          <meta property="og:title" content="OG Title Value" />
          <meta name="twitter:title" content="Twitter Title Value" />
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Product",
              "name": "JSON-LD Product Name"
            }
          </script>
        </head>
        <body>
          <h1>Heading H1 Value</h1>
        </body>
      </html>
    `;
    const meta = extractMetadata(html, finalUrl);
    expect(meta.seo.title.value).toBe("Title Tag Value");
    expect(meta.seo.title.source).toBe("title_tag");
  });

  it("falls back to og:title when <title> is missing", () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="OG Title Value" />
          <meta name="twitter:title" content="Twitter Title Value" />
        </head>
      </html>
    `;
    const meta = extractMetadata(html, finalUrl);
    expect(meta.seo.title.value).toBe("OG Title Value");
    expect(meta.seo.title.source).toBe("og:title");
  });

  it("falls back to twitter:title when og:title is missing", () => {
    const html = `
      <html>
        <head>
          <meta name="twitter:title" content="Twitter Title Value" />
        </head>
      </html>
    `;
    const meta = extractMetadata(html, finalUrl);
    expect(meta.seo.title.value).toBe("Twitter Title Value");
    expect(meta.seo.title.source).toBe("twitter:title");
  });

  it("falls back to JSON-LD Product name when meta titles are missing", () => {
    const html = `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Product",
              "name": "JSON-LD Product Name"
            }
          </script>
        </head>
      </html>
    `;
    const meta = extractMetadata(html, finalUrl);
    expect(meta.seo.title.value).toBe("JSON-LD Product Name");
    expect(meta.seo.title.source).toBe("jsonld:Product.name");
  });

  it("falls back to H1 when all else is missing", () => {
    const html = `
      <html>
        <body>
          <h1>Heading H1 Value</h1>
        </body>
      </html>
    `;
    const meta = extractMetadata(html, finalUrl);
    expect(meta.seo.title.value).toBe("Heading H1 Value");
    expect(meta.seo.title.source).toBe("h1");
  });

  it("extracts Product title with JSON-LD taking priority", () => {
    const html = `
      <html>
        <head>
          <title>SEO Title</title>
          <meta property="og:title" content="OG Product Title" />
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Product",
              "name": "JSON-LD Product Title"
            }
          </script>
        </head>
        <body>
          <h1>DOM H1 Title</h1>
        </body>
      </html>
    `;
    const meta = extractMetadata(html, finalUrl);
    const prod = extractProduct(meta);
    expect(prod.title.value).toBe("JSON-LD Product Title");
    expect(prod.title.source).toBe("jsonld:Product.name");
  });

  it("falls back to og:title for Product title if JSON-LD is missing", () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="OG Product Title" />
        </head>
        <body>
          <h1>DOM H1 Title</h1>
        </body>
      </html>
    `;
    const meta = extractMetadata(html, finalUrl);
    const prod = extractProduct(meta);
    expect(prod.title.value).toBe("OG Product Title");
    expect(prod.title.source).toBe("og:title");
  });

  it("falls back to H1 for Product title when metadata is missing", () => {
    const html = `
      <html>
        <body>
          <h1>DOM H1 Title</h1>
        </body>
      </html>
    `;
    const meta = extractMetadata(html, finalUrl);
    const prod = extractProduct(meta);
    expect(prod.title.value).toBe("DOM H1 Title");
    expect(prod.title.source).toBe("h1");
  });

  it("falls back to guessing largest heading for Product title if no H1", () => {
    const html = `
      <html>
        <body>
          <h2>Medium heading</h2>
          <div role="heading" aria-level="1">Very Long Prominent Guessed Product Title Heading</div>
        </body>
      </html>
    `;
    const meta = extractMetadata(html, finalUrl);
    const prod = extractProduct(meta);
    expect(prod.title.value).toBe("Very Long Prominent Guessed Product Title Heading");
    expect(prod.title.source).toBe("dom_heading");
  });

  it("extracts description with labels in DOM (heuristic)", () => {
    const html = `
      <html>
        <body>
          <h3>Omschrijving</h3>
          <p>Dit is een prachtige blauwe spijkerbroek van topkwaliteit katoen.</p>
        </body>
      </html>
    `;
    const meta = extractMetadata(html, finalUrl);
    const prod = extractProduct(meta);
    expect(prod.description.value).toContain("Dit is een prachtige blauwe spijkerbroek");
    expect(prod.description.source).toBe("dom_label_heuristic");
  });

  it("resolves canonical relative links and warns on path differences", () => {
    const html = `
      <html>
        <head>
          <link rel="canonical" href="/products/different-jeans" />
        </head>
      </html>
    `;
    const meta = extractMetadata(html, finalUrl);
    expect(meta.seo.canonicalUrl.value).toBe("https://shop.example/products/different-jeans");
    expect(meta.seo.canonicalUrl.warnings).toContain("Canonical path differs from the loaded page path.");
  });

  it("correctly parses JSON-LD graphs and flattens them", () => {
    const html = `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "Product",
                  "name": "Graph Product"
                },
                {
                  "@type": "BreadcrumbList",
                  "itemListElement": []
                }
              ]
            }
          </script>
        </head>
      </html>
    `;
    const meta = extractMetadata(html, finalUrl);
    const prod = extractProduct(meta);
    expect(prod.title.value).toBe("Graph Product");
    expect(prod.structuredData).toHaveLength(2);
  });
});
