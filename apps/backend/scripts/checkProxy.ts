/**
 * Proxy health check. Run this FIRST whenever stores start reporting blocks:
 * a dead proxy makes every scrape run from this server's own datacenter IP,
 * which Shopify challenges far more aggressively than a residential exit.
 *
 *   cd apps/backend && npx tsx scripts/checkProxy.ts [https://someshop.com/collections/all]
 *
 * Prints (never any credentials): whether a proxy is configured, the raw CONNECT
 * response from the gateway (providers use non-standard codes — Decodo/Smartproxy
 * answers `612 auth fail <user>` for bad or expired credentials), the egress IP
 * seen through the proxy vs. direct, and optionally one live collection fetch.
 */
import "../src/env.js";
import net from "node:net";
import {
  fetchDirect,
  getProxyConfig,
  isProxyConfigured,
  isProxyRotating,
  proxyFetch,
  redactProxy,
  buildRealisticHeaders,
} from "../src/services/antiBlock.js";

const cfg = getProxyConfig();
console.log("=== proxy configuration ===");
console.log("configured:", isProxyConfigured(), "| rotating:", isProxyRotating());
console.log("server:", cfg?.server ?? "(none)", "| credentials:", cfg?.username ? "present" : "(none)");

/**
 * Raw CONNECT to the gateway, so provider-specific auth errors are visible.
 * Providers do not use standard codes: Decodo/Smartproxy replies `612 auth fail
 * <username>` when credentials are wrong, expired, or out of traffic.
 */
async function rawConnect(): Promise<string> {
  if (!cfg) return "(no proxy configured)";
  const [host, port] = cfg.server.replace(/^https?:\/\//, "").split(":");
  const auth = Buffer.from(`${cfg.username ?? ""}:${cfg.password ?? ""}`).toString("base64");
  return new Promise<string>((resolve) => {
    let received = "";
    const socket = net.createConnection({ host: host!, port: Number(port), timeout: 15_000 }, () => {
      socket.write(
        `CONNECT api.ipify.org:443 HTTP/1.1\r\nHost: api.ipify.org:443\r\n` +
          `Proxy-Authorization: Basic ${auth}\r\n\r\n`,
      );
    });
    const finish = (): void => {
      socket.destroy();
      const [head = "", ...rest] = received.split(/\r?\n\r?\n/);
      resolve(`${head.trim()}${rest.length ? `\n  body: ${maskIdentifiers(rest.join(" "))}` : ""}`);
    };
    // The reply can arrive across several packets; give it a moment to complete.
    const settle = setTimeout(finish, 750);
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    socket.once("error", (err) => {
      clearTimeout(settle);
      socket.destroy();
      resolve(`ERROR ${err.message}`);
    });
    socket.once("timeout", () => {
      clearTimeout(settle);
      socket.destroy();
      resolve("ERROR connect timeout");
    });
  });
}

/**
 * Keep short diagnostic words ("auth fail", "quota", "expired") but mask account
 * usernames and session tokens — this output gets pasted into support tickets.
 */
function maskIdentifiers(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (/^[a-z]{2,8}$/i.test(word) ? word : "***"))
    .join(" ");
}

console.log("\n=== CONNECT handshake (raw gateway reply) ===");
console.log(await rawConnect());

async function egress(fetcher: typeof proxyFetch): Promise<string> {
  try {
    const res = await fetcher("https://api.ipify.org?format=json", {});
    return ((await res.json()) as { ip?: string }).ip ?? "(unknown)";
  } catch (err) {
    return `ERROR: ${(err as Error).message}`;
  }
}

console.log("\n=== egress IP (must differ; identical means the proxy is bypassed) ===");
const direct = await egress(fetchDirect);
const proxied = await egress(proxyFetch);
console.log("DIRECT:", direct);
console.log("PROXY :", proxied);
console.log(
  direct === proxied
    ? `!! PROXY NOT IN USE — every scrape runs from ${direct}. Fix ${redactProxy(cfg?.server)} before debugging store blocks.`
    : "OK: traffic exits through the proxy.",
);

const target = process.argv[2];
if (target) {
  console.log(`\n=== live fetch of ${target} ===`);
  for (const [label, fetcher] of [["proxy", proxyFetch], ["direct", fetchDirect]] as const) {
    try {
      const res = await fetcher(target, { headers: buildRealisticHeaders(new URL(target).origin) });
      const body = await res.text();
      console.log(
        `${label}: HTTP ${res.status}`,
        "| cf-mitigated:", res.headers.get("cf-mitigated") ?? "-",
        "| bytes:", body.length,
        "| productLinks:", (body.match(/\/products\//g) ?? []).length,
      );
    } catch (err) {
      console.log(`${label}: ERROR ${(err as Error).message}`);
    }
  }
}
process.exit(0);
