import { describe, it, expect } from "vitest";
import { load } from "cheerio";
import { findNextPageUrl, resolveMaxPages } from "../src/services/pagination.js";
import { sitesConfig } from "../../../config/sites.config.js";

const BASE = "https://shop.example/collections/all";

describe("findNextPageUrl", () => {
  it("uses <link rel=next>", () => {
    const $ = load(`<html><head><link rel="next" href="/collections/all?page=2"></head><body></body></html>`);
    expect(findNextPageUrl($, BASE, new Set())).toBe("https://shop.example/collections/all?page=2");
  });

  it("prefers a pagination link pointing at page = current + 1", () => {
    const $ = load(`
      <div class="pagination">
        <a href="?page=1">1</a>
        <a href="?page=2">2</a>
        <a href="?page=3">3</a>
      </div>`);
    expect(findNextPageUrl($, BASE, new Set())).toBe("https://shop.example/collections/all?page=2");
  });

  it("finds the next page when already on page 2", () => {
    const $ = load(`<nav aria-label="Pagination"><a href="?page=2">2</a><a href="?page=3">3</a></nav>`);
    expect(findNextPageUrl($, `${BASE}?page=2`, new Set())).toBe("https://shop.example/collections/all?page=3");
  });

  it("returns null when there is no pagination", () => {
    const $ = load(`<div><a href="/products/a">A</a><a href="/products/b">B</a></div>`);
    expect(findNextPageUrl($, BASE, new Set())).toBeNull();
  });

  it("does not treat broad nav containers as pagination", () => {
    const $ = load(`
      <nav aria-label="Pagination">
        <a href="/">Accueil</a>
        <a href="/collections">Femmes</a>
        <a href="/search">Rechercher</a>
      </nav>`);
    expect(findNextPageUrl($, BASE, new Set())).toBeNull();
  });

  it("still accepts an explicit next control inside a pagination container", () => {
    const $ = load(`
      <nav aria-label="Pagination">
        <a href="?page=1">1</a>
        <a href="?page=2" aria-label="Next page">Suivant</a>
      </nav>`);
    expect(findNextPageUrl($, BASE, new Set())).toBe("https://shop.example/collections/all?page=2");
  });

  it("skips already-visited URLs", () => {
    const $ = load(`<a rel="next" href="/collections/all?page=2">next</a>`);
    const visited = new Set(["https://shop.example/collections/all?page=2"]);
    expect(findNextPageUrl($, BASE, visited)).toBeNull();
  });

  it("ignores cross-origin next links", () => {
    const $ = load(`<a rel="next" href="https://evil.example/collections/all?page=2">next</a>`);
    expect(findNextPageUrl($, BASE, new Set())).toBeNull();
  });
});

describe("resolveMaxPages", () => {
  it("falls back to the configured default when missing/invalid", () => {
    expect(resolveMaxPages(undefined)).toBe(sitesConfig.collections.maxPages);
    expect(resolveMaxPages(0)).toBe(sitesConfig.collections.maxPages);
    expect(resolveMaxPages(-5)).toBe(sitesConfig.collections.maxPages);
  });

  it("passes through a valid request value", () => {
    expect(resolveMaxPages(3)).toBe(3);
  });

  it("clamps to the configured ceiling", () => {
    expect(resolveMaxPages(99999)).toBe(sitesConfig.collections.maxPagesCeiling);
  });
});
