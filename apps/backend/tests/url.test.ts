import { describe, it, expect } from "vitest";
import {
  validateAndNormalizeUrl,
  isPrivateHost,
  assertDomainAllowed,
  normalizeImageUrl,
  parseSrcset,
  stripLocalePrefix,
  safeCollectionRedirectTarget,
} from "../src/utils/url.js";
import { CheckError } from "../src/types/productCheck.js";

describe("validateAndNormalizeUrl", () => {
  it("accepts http and https", () => {
    expect(validateAndNormalizeUrl("https://shop.example/p/1").hostname).toBe("shop.example");
    expect(validateAndNormalizeUrl("http://shop.example").hostname).toBe("shop.example");
  });

  it("rejects non-URLs", () => {
    expect(() => validateAndNormalizeUrl("not a url")).toThrow(CheckError);
  });

  it("rejects non-http protocols", () => {
    expect(() => validateAndNormalizeUrl("ftp://shop.example")).toThrow(CheckError);
    expect(() => validateAndNormalizeUrl("file:///etc/passwd")).toThrow(CheckError);
  });

  it("lowercases the hostname", () => {
    expect(validateAndNormalizeUrl("https://SHOP.Example/P").hostname).toBe("shop.example");
  });
});

describe("isPrivateHost", () => {
  it("flags loopback and private ranges", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("10.1.2.3")).toBe(true);
    expect(isPrivateHost("192.168.0.5")).toBe(true);
    expect(isPrivateHost("172.16.5.5")).toBe(true);
    expect(isPrivateHost("169.254.1.1")).toBe(true);
    expect(isPrivateHost("printer.local")).toBe(true);
  });

  it("allows public hosts", () => {
    expect(isPrivateHost("shop.example.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
  });
});

describe("assertDomainAllowed", () => {
  // Config ships with allowAllDomains: true (testing mode).
  it("allows any public domain in allow-all mode", () => {
    expect(() => assertDomainAllowed("anything.example.org")).not.toThrow();
  });

  it("always rejects private hosts even in allow-all mode", () => {
    expect(() => assertDomainAllowed("localhost")).toThrow(CheckError);
    expect(() => assertDomainAllowed("10.0.0.1")).toThrow(CheckError);
  });
});

describe("normalizeImageUrl", () => {
  const base = "https://shop.example/products/dress";

  it("resolves relative URLs", () => {
    expect(normalizeImageUrl("/img/a.jpg", base)).toBe("https://shop.example/img/a.jpg");
    expect(normalizeImageUrl("../x.jpg", base)).toBe("https://shop.example/x.jpg");
  });

  it("strips tracking params but keeps variant params", () => {
    const out = normalizeImageUrl(
      "https://cdn.example/a.jpg?utm_source=fb&fbclid=123&w=800&v=2",
      base,
    );
    expect(out).toContain("w=800");
    expect(out).toContain("v=2");
    expect(out).not.toContain("utm_source");
    expect(out).not.toContain("fbclid");
  });

  it("rejects data and blob URLs", () => {
    expect(normalizeImageUrl("data:image/png;base64,xxxx", base)).toBeNull();
    expect(normalizeImageUrl("blob:https://x/y", base)).toBeNull();
  });
});

describe("parseSrcset", () => {
  it("extracts URLs and drops descriptors", () => {
    const urls = parseSrcset("a.jpg 1x, b.jpg 2x, c.jpg 800w");
    expect(urls).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  });
});

describe("stripLocalePrefix", () => {
  it("removes a {lang} or {lang}-{region} leading segment", () => {
    expect(stripLocalePrefix("/en-us/collections/all")).toBe("/collections/all");
    expect(stripLocalePrefix("/fr-fr/collections/all")).toBe("/collections/all");
    expect(stripLocalePrefix("/nl/products/x")).toBe("/products/x");
  });
  it("leaves non-locale paths unchanged", () => {
    expect(stripLocalePrefix("/collections/all")).toBe("/collections/all");
    // 'co' is two letters but the real first segment is 'collections' here.
    expect(stripLocalePrefix("/products/handle")).toBe("/products/handle");
  });
});

describe("safeCollectionRedirectTarget", () => {
  const req = "https://shop.example/collections/all?sort_by=best-selling";

  it("follows a locale-prefixed copy of the same collection (preserving sort)", () => {
    expect(safeCollectionRedirectTarget(req, "https://shop.example/en-us/collections/all?sort_by=best-selling")).toBe(
      "https://shop.example/en-us/collections/all?sort_by=best-selling",
    );
  });

  it("follows a www. canonicalization of the same collection", () => {
    expect(safeCollectionRedirectTarget(req, "https://www.shop.example/collections/all?sort_by=best-selling")).toBe(
      "https://www.shop.example/collections/all?sort_by=best-selling",
    );
  });

  it("re-applies a dropped sort_by on the redirect target", () => {
    expect(safeCollectionRedirectTarget(req, "https://www.shop.example/collections/all")).toBe(
      "https://www.shop.example/collections/all?sort_by=best-selling",
    );
  });

  it("re-applies sort on a locale + dropped-sort redirect (e.g. vitellimoda/www markets)", () => {
    expect(safeCollectionRedirectTarget(req, "https://shop.example/fr-fr/collections/all")).toBe(
      "https://shop.example/fr-fr/collections/all?sort_by=best-selling",
    );
  });

  it("follows the products.json variant of the same collection", () => {
    const jsonReq = "https://shop.example/collections/all/products.json?limit=250&page=1";
    expect(safeCollectionRedirectTarget(jsonReq, "https://shop.example/en-us/collections/all/products.json?limit=250&page=1")).toBe(
      "https://shop.example/en-us/collections/all/products.json?limit=250&page=1",
    );
  });

  it("rejects a redirect to a DIFFERENT collection handle", () => {
    expect(safeCollectionRedirectTarget(req, "https://shop.example/collections/sale?sort_by=best-selling")).toBeNull();
  });

  it("rejects a redirect to a different host/domain", () => {
    expect(safeCollectionRedirectTarget(req, "https://other-shop.com/collections/all?sort_by=best-selling")).toBeNull();
  });

  it("rejects a redirect away from the collection (e.g. home or search)", () => {
    expect(safeCollectionRedirectTarget(req, "https://shop.example/")).toBeNull();
    expect(safeCollectionRedirectTarget(req, "https://shop.example/search?q=Produits")).toBeNull();
  });

  it("rejects non-http(s) targets", () => {
    expect(safeCollectionRedirectTarget(req, "javascript:void(0)")).toBeNull();
  });
});
