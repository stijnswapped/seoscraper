import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildRealisticHeaders,
  isBlockedResponse,
  isProxyHealthy,
  markProxyBroken,
  proxyDegradationReason,
  resetProxyHealth,
  getProxyConfig,
  getProxyUrl,
  isProxyConfigured,
  isProxyRotating,
  normalizeProxyInput,
  redactProxy,
  runWithProxy,
  validateProxyOverride,
} from "../src/services/antiBlock.js";

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

  it("flags any response carrying a cf-mitigated header, whatever the status", () => {
    // drune.de answers 429 with cf-mitigated: challenge; other shops use 200/500.
    expect(isBlockedResponse(429, "", "cloudflare", "challenge")).toBe(true);
    expect(isBlockedResponse(200, "<html>real grid</html>", "cloudflare", "challenge")).toBe(true);
    expect(isBlockedResponse(500, "", "cloudflare", "challenge")).toBe(true);
    // Absent/empty header must not flag an otherwise fine page.
    expect(isBlockedResponse(200, "<html>real grid</html>", "cloudflare", null)).toBe(false);
    expect(isBlockedResponse(200, "<html>real grid</html>", "cloudflare", "")).toBe(false);
  });

  it("flags Shopify's own bot interstitial by its body text", () => {
    expect(isBlockedResponse(200, "<title>Verifying your connection...</title>", "cloudflare")).toBe(true);
    expect(
      isBlockedResponse(200, "<h1>Your connection needs to be verified before you can proceed</h1>", null),
    ).toBe(true);
    expect(isBlockedResponse(200, "<span>Enable JavaScript and cookies to continue</span>", null)).toBe(true);
  });

  it("treats a plain HTTP 500 as NOT blocked (that is the store failing, not a challenge)", () => {
    expect(isBlockedResponse(500, "<title>Something went wrong</title>", "cloudflare")).toBe(false);
  });
});

describe("markProxyBroken", () => {
  it("disables a proxy and reports why", async () => {
    process.env.SCRAPE_PROXY_URL = "http://user:pass@some.proxy:3120";
    resetProxyHealth();
    await runWithProxy(null, async () => {
      expect(isProxyHealthy()).toBe(true);
      markProxyBroken("proxyFetch", "auth fail");
      expect(isProxyHealthy()).toBe(false);
      expect(proxyDegradationReason()).toContain("auth fail");
    });
    resetProxyHealth();
  });

  it("disables a ROTATING pool too — a fresh exit IP cannot fix bad credentials", async () => {
    // PROXY_ROTATING is read once at module load, so load a fresh module copy.
    process.env.PROXY_ROTATING = "true";
    process.env.SCRAPE_PROXY_URL = "http://user:pass@rotating.proxy:3120";
    vi.resetModules();
    const mod = await import("../src/services/antiBlock.js");
    try {
      await mod.runWithProxy(null, async () => {
        expect(mod.isProxyRotating()).toBe(true);
        expect(mod.isProxyHealthy()).toBe(true);
        // A merely blocked exit IP must NOT disable a rotating pool…
        mod.markProxyUnhealthy("browser navigation", "challenged exit");
        expect(mod.isProxyHealthy()).toBe(true);
        // …but a broken gateway (rejected credentials) must.
        mod.markProxyBroken("proxyFetch", "auth fail smart-user");
        expect(mod.isProxyHealthy()).toBe(false);
        expect(mod.proxyDegradationReason()).toContain("auth fail");
      });
    } finally {
      delete process.env.PROXY_ROTATING;
      mod.resetProxyHealth();
      vi.resetModules();
    }
  });

  it("reports no degradation when no proxy is configured", async () => {
    resetProxyHealth();
    await runWithProxy(null, async () => {
      expect(proxyDegradationReason()).toBeNull();
    });
  });
});

describe("buildRealisticHeaders", () => {
  it("includes the high-entropy client hints Cloudflare asks for in critical-ch", () => {
    const h = buildRealisticHeaders();
    for (const key of [
      "sec-ch-ua-arch",
      "sec-ch-ua-bitness",
      "sec-ch-ua-full-version",
      "sec-ch-ua-full-version-list",
      "sec-ch-ua-model",
      "sec-ch-ua-platform-version",
    ]) {
      expect(h[key], key).toBeDefined();
    }
  });

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

describe("runWithProxy (per-request override)", () => {
  it("a request proxy overrides the env proxy inside the scope", async () => {
    process.env.SCRAPE_PROXY_URL = "http://env-user:env-pass@env.proxy:8080";
    await runWithProxy("http://cust:secret@customer.proxy:9000", async () => {
      expect(getProxyConfig()).toEqual({ server: "http://customer.proxy:9000", username: "cust", password: "secret" });
      expect(isProxyConfigured()).toBe(true);
    });
    // Outside the scope, the env proxy is back.
    expect(getProxyConfig()).toEqual({ server: "http://env.proxy:8080", username: "env-user", password: "env-pass" });
  });

  it("falls back to the env proxy when override is null/empty", async () => {
    process.env.SCRAPE_PROXY_URL = "http://env.proxy:8080";
    await runWithProxy(null, async () => {
      expect(getProxyConfig()).toEqual({ server: "http://env.proxy:8080" });
    });
  });

  it("a customer proxy is treated as static even when PROXY_ROTATING is set for env", async () => {
    // (PROXY_ROTATING is read at module load; this asserts the request path is
    // static regardless — a customer proxy never claims to rotate.)
    await runWithProxy("http://cust@customer.proxy:9000", async () => {
      expect(isProxyRotating()).toBe(false);
    });
  });

  it("ignores an unparseable request proxy (no host) and goes direct", async () => {
    await runWithProxy("http://", async () => {
      expect(getProxyConfig()).toBeNull();
      expect(isProxyConfigured()).toBe(false);
    });
  });
});

describe("normalizeProxyInput", () => {
  it("extracts the proxy from a Smartproxy curl command and adds a scheme", () => {
    const curl = "curl -x smart-stijnsusername:password@proxy.smartproxy.net:3120 https://api.ip.cc";
    expect(normalizeProxyInput(curl)).toBe("http://smart-stijnsusername:password@proxy.smartproxy.net:3120");
  });

  it("adds a scheme to a bare host:port and leaves a full URL intact", () => {
    expect(normalizeProxyInput("gate.smartproxy.net:3120")).toBe("http://gate.smartproxy.net:3120");
    expect(normalizeProxyInput("http://user:pass@host:8080")).toBe("http://user:pass@host:8080");
  });
});

describe("validateProxyOverride", () => {
  it("accepts a URL, a scheme-less host:port, and a curl command", () => {
    expect(validateProxyOverride("http://user:pass@gate.smartproxy.net:3120")).toBeNull();
    expect(validateProxyOverride("gate.smartproxy.net:3120")).toBeNull();
    expect(validateProxyOverride("curl -x u:p@proxy.smartproxy.net:3120 https://api.ip.cc")).toBeNull();
  });

  it("rejects a missing port or empty value", () => {
    expect(validateProxyOverride("http://gate.smartproxy.net")).toMatch(/port/);
    expect(validateProxyOverride("   ")).toBeTruthy();
  });

  it("rejects loopback and private CONNECT targets (SSRF guard)", () => {
    for (const host of ["http://127.0.0.1:8080", "http://localhost:8080", "http://10.0.0.5:3128", "http://192.168.1.1:8080", "http://172.16.0.1:8080"]) {
      expect(validateProxyOverride(host)).toMatch(/loopback or private/);
    }
  });
});

describe("redactProxy", () => {
  it("masks credentials but keeps the host visible", () => {
    expect(redactProxy("http://user:pass@gate.smartproxy.net:3120")).toBe("http://***@gate.smartproxy.net:3120");
    expect(redactProxy("user:pass@51.194.96.103:41853")).toBe("***@51.194.96.103:41853");
  });

  it("handles a credential-less or empty value", () => {
    expect(redactProxy("http://gate.smartproxy.net:3120")).toBe("http://gate.smartproxy.net:3120");
    expect(redactProxy(null)).toBe("(none)");
  });
});
