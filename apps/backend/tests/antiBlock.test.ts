import { describe, it, expect, afterEach } from "vitest";
import { buildRealisticHeaders, isBlockedResponse, getProxyConfig, getProxyUrl } from "../src/services/antiBlock.js";

const PROXY_ENV = ["SCRAPE_PROXY_URL", "HTTPS_PROXY", "HTTP_PROXY", "SCRAPE_PROXY_USERNAME", "SCRAPE_PROXY_PASSWORD"];

afterEach(() => {
  for (const key of PROXY_ENV) delete process.env[key];
});

describe("isBlockedResponse", () => {
  it("flags Cloudflare status codes", () => {
    expect(isBlockedResponse(403, "", null)).toBe(true);
    expect(isBlockedResponse(429, "", null)).toBe(true);
    expect(isBlockedResponse(503, "", null)).toBe(true);
    expect(isBlockedResponse(521, "", null)).toBe(true);
  });

  it("flags challenge-page markers on a 200", () => {
    expect(isBlockedResponse(200, "<title>Just a moment...</title>", "cloudflare")).toBe(true);
    expect(isBlockedResponse(200, "<div id='cf-challenge'></div>", null)).toBe(true);
    expect(isBlockedResponse(200, "<script src='/cdn-cgi/challenge-platform/x'></script>", null)).toBe(true);
  });

  it("passes a normal product page", () => {
    expect(isBlockedResponse(200, "<html><body><a href='/products/x'>X</a></body></html>", "nginx")).toBe(false);
  });
});

describe("buildRealisticHeaders", () => {
  it("includes Chrome client hints and a user-agent", () => {
    const h = buildRealisticHeaders();
    expect(h["user-agent"]).toContain("Chrome");
    expect(h["sec-ch-ua"]).toContain("Google Chrome");
    expect(h["sec-fetch-site"]).toBe("none");
    expect(h.referer).toBeUndefined();
  });

  it("sets a referer and same-origin sec-fetch-site when given an origin", () => {
    const h = buildRealisticHeaders("https://shop.example");
    expect(h.referer).toBe("https://shop.example");
    expect(h["sec-fetch-site"]).toBe("same-origin");
  });
});

describe("getProxyConfig / getProxyUrl", () => {
  it("returns null when no proxy env is set", () => {
    expect(getProxyConfig()).toBeNull();
    expect(getProxyUrl()).toBeNull();
  });

  it("parses inline credentials and splits server from auth", () => {
    process.env.SCRAPE_PROXY_URL = "http://user:pass@proxy.example:8080";
    expect(getProxyConfig()).toEqual({ server: "http://proxy.example:8080", username: "user", password: "pass" });
    expect(getProxyUrl()).toBe("http://user:pass@proxy.example:8080");
  });

  it("handles a Smartproxy-style username and a password with special chars", () => {
    process.env.SCRAPE_PROXY_URL = "http://smart-user_area-NL:p@ss/w0rd@gate.smartproxy.net:3120";
    expect(getProxyConfig()).toEqual({
      server: "http://gate.smartproxy.net:3120",
      username: "smart-user_area-NL",
      password: "p@ss/w0rd",
    });
    // creds are percent-encoded in the proxy URI so undici parses them correctly
    expect(getProxyUrl()).toBe("http://smart-user_area-NL:p%40ss%2Fw0rd@gate.smartproxy.net:3120");
  });

  it("tolerates a scheme-less value (user:pass@host:port)", () => {
    process.env.SCRAPE_PROXY_URL = "Y6dvEhgZlGbEKXN:Tg8DQP2vBvkNLdV@51.194.96.103:41853";
    expect(getProxyConfig()).toEqual({
      server: "http://51.194.96.103:41853",
      username: "Y6dvEhgZlGbEKXN",
      password: "Tg8DQP2vBvkNLdV",
    });
  });

  it("supports split username/password env vars", () => {
    process.env.SCRAPE_PROXY_URL = "http://proxy.example:8080";
    process.env.SCRAPE_PROXY_USERNAME = "u";
    process.env.SCRAPE_PROXY_PASSWORD = "p";
    expect(getProxyConfig()).toEqual({ server: "http://proxy.example:8080", username: "u", password: "p" });
  });
});
