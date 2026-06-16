import type { FastifyRequest } from "fastify";

/**
 * Rate-limit configuration (shared by the global registration and per-route
 * overrides). Limits are env-tunable so they can be adjusted on Railway without
 * a code change. All windows are 1 minute.
 *
 *   RATE_LIMIT_GLOBAL_MAX  default 600  — backstop for every endpoint
 *   RATE_LIMIT_LOGIN_MAX   default 10   — brute-force guard on /api/auth/login
 *   RATE_LIMIT_SCRAPE_MAX  default 120  — runaway-loop guard on the scrape endpoints
 */
function num(envName: string, fallback: number): number {
  const v = Number(process.env[envName]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Key requests by credential first, IP last — so each API key / session is
 * limited independently (one customer can't exhaust another's budget) while
 * anonymous traffic is bucketed per IP. Runs at onRequest, before auth resolves,
 * so it reads the raw headers rather than request.auth.
 */
export function rateKey(req: FastifyRequest): string {
  const authz = req.headers.authorization;
  const bearer = authz?.toLowerCase().startsWith("bearer ") ? authz.slice(7).trim() : null;
  const apiKeyHeader = req.headers["x-api-key"];
  const apiKey = bearer ?? (Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader);
  const sessionHeader = req.headers["x-session-token"];
  const session = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
  return apiKey || session || req.ip;
}

export const globalRateLimit = {
  global: true,
  max: num("RATE_LIMIT_GLOBAL_MAX", 600),
  timeWindow: "1 minute",
  keyGenerator: rateKey,
};

/** Strict cap for the unauthenticated login endpoint. */
export const loginRateLimit = { max: num("RATE_LIMIT_LOGIN_MAX", 10), timeWindow: "1 minute" } as const;

/** Generous cap for the expensive scrape/track endpoints — high enough for real
 *  bursts, low enough to stop a runaway loop hammering the single instance. */
export const scrapeRateLimit = { max: num("RATE_LIMIT_SCRAPE_MAX", 120), timeWindow: "1 minute" } as const;
