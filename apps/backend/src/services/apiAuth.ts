import type { FastifyReply, FastifyRequest } from "fastify";
import { getDatabaseUrl } from "../db/postgres.js";
import {
  getActiveApiKeyByUid,
  getUserById,
  getUserIdForSession,
  touchApiKeyUsed,
} from "../db/accountRepository.js";
import { decryptSecret, hashApiKey, hashesEqual, hashSessionToken, parseApiKeyUid } from "./crypto.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("apiAuth");

export const SESSION_COOKIE = "seoscrape_session";

function configuredApiKey(): string | null {
  return process.env.API_KEY?.trim() || null;
}

/** Whether API-key auth is enforced. Open (dev) unless explicitly required. */
function requireApiKey(): boolean {
  return process.env.REQUIRE_API_KEY === "true" || Boolean(configuredApiKey());
}

function extractApiKey(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  const bearer = authorization?.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : null;
  const header = request.headers["x-api-key"];
  return bearer ?? (Array.isArray(header) ? header[0]! : header) ?? null;
}

function deny(reply: FastifyReply, code: string, message: string, status = 401): Promise<void> {
  return reply.status(status).send({ success: false, error: { code, message } }) as unknown as Promise<void>;
}

/**
 * Resolve a presented API key against the DB (per-account keys). Returns the
 * auth context on success, or null if the key is unknown/revoked. Only consulted
 * when a database is configured.
 */
async function resolveDbApiKey(apiKey: string): Promise<FastifyRequest["auth"] | null> {
  const uid = parseApiKeyUid(apiKey);
  if (!uid) return null;
  const row = await getActiveApiKeyByUid(uid);
  if (!row || !hashesEqual(row.keyHash, hashApiKey(apiKey))) return null;
  const user = await getUserById(row.userId, decryptSecret);
  if (!user) return null;
  // Best-effort "last used" stamp; never block the request on it.
  void touchApiKeyUsed(row.id).catch(() => {});
  return { userId: user.id, apiKeyId: row.id, proxyUrl: user.proxyUrl, isAdmin: user.role === "admin" };
}

/**
 * Pre-handler for scrape endpoints. Accepts the env `API_KEY` (admin backdoor)
 * or a valid per-account key. Stays OPEN when auth isn't configured (dev), and
 * still works env-key-only when no database is present.
 */
export async function requireApiKeyAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireApiKey()) {
    request.auth = { userId: null, apiKeyId: null, proxyUrl: null, isAdmin: true };
    return;
  }

  const apiKey = extractApiKey(request);
  if (!apiKey) {
    // Session fallback: allows logged-in dashboard users to scrape/track without copy-pasting API key.
    const headerToken = request.headers["x-session-token"];
    const token = request.cookies?.[SESSION_COOKIE] ?? (Array.isArray(headerToken) ? headerToken[0] : headerToken);
    if (token) {
      try {
        const userId = await getUserIdForSession(hashSessionToken(token));
        if (userId) {
          const user = await getUserById(userId, decryptSecret);
          if (user) {
            request.auth = { userId: user.id, apiKeyId: null, proxyUrl: user.proxyUrl, isAdmin: user.role === "admin" };
            return;
          }
        }
      } catch (err) {
        log.error("session lookup fallback failed", { message: (err as Error).message });
        return deny(reply, "AUTH_ERROR", "Could not verify fallback session.", 500);
      }
    }
    return deny(reply, "UNAUTHORIZED", "Missing API key or active session.");
  }

  // Env admin key (operator backdoor / pre-accounts deployments).
  const expected = configuredApiKey();
  if (expected && apiKey === expected) {
    request.auth = { userId: null, apiKeyId: null, proxyUrl: null, isAdmin: true };
    return;
  }

  if (getDatabaseUrl()) {
    try {
      const auth = await resolveDbApiKey(apiKey);
      if (auth) {
        request.auth = auth;
        return;
      }
    } catch (err) {
      log.error("api key lookup failed", { message: (err as Error).message });
      return deny(reply, "AUTH_ERROR", "Could not verify the API key.", 500);
    }
  }

  return deny(reply, "UNAUTHORIZED", "Invalid API key.");
}

/**
 * Pre-handler for dashboard endpoints — requires a valid login session. Accepts
 * the session token from the httpOnly cookie OR an `X-Session-Token` header. The
 * header path is what makes the dashboard work when the frontend and backend are
 * on different domains (cross-site cookies are blocked by Safari/ITP and, soon,
 * other browsers).
 */
export async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const headerToken = request.headers["x-session-token"];
  const token = request.cookies?.[SESSION_COOKIE] ?? (Array.isArray(headerToken) ? headerToken[0] : headerToken);
  if (!token) return deny(reply, "UNAUTHENTICATED", "Not signed in.");
  try {
    const userId = await getUserIdForSession(hashSessionToken(token));
    if (!userId) return deny(reply, "UNAUTHENTICATED", "Session expired or invalid.");
    const user = await getUserById(userId, decryptSecret);
    if (!user) return deny(reply, "UNAUTHENTICATED", "Account no longer exists.");
    request.auth = { userId: user.id, apiKeyId: null, proxyUrl: user.proxyUrl, isAdmin: user.role === "admin" };
  } catch (err) {
    log.error("session lookup failed", { message: (err as Error).message });
    return deny(reply, "AUTH_ERROR", "Could not verify the session.", 500);
  }
}

/**
 * Companion guard for scrape-style auth: run AFTER {@link requireApiKeyAuth} to
 * require admin privileges. Lets the env `API_KEY` backdoor and admin accounts
 * through (both resolve `isAdmin: true`) while rejecting regular API-key/session
 * holders with 403. Used to gate operator maintenance endpoints that may be
 * called by scripts with the env key rather than a browser session.
 */
export async function requireApiAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (reply.sent) return; // requireApiKeyAuth already denied the request
  if (!request.auth?.isAdmin) {
    return deny(reply, "FORBIDDEN", "Admin access required.", 403);
  }
}

/** Pre-handler chain helper: require an authenticated ADMIN session. */
export async function requireAdminSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireSession(request, reply);
  if (reply.sent) return;
  if (!request.auth?.isAdmin) {
    return deny(reply, "FORBIDDEN", "Admin access required.", 403);
  }
}
