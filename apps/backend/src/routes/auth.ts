import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireSession, requireAdminSession, SESSION_COOKIE } from "../services/apiAuth.js";
import {
  createSession,
  createUser,
  getUserById,
  getUserWithPasswordByEmail,
  insertApiKey,
  listApiKeys,
  listUsers,
  revokeApiKey,
  revokeSession,
  setUserProxyEncrypted,
  getUsageDaily,
  getUsageEvents,
} from "../db/accountRepository.js";
import {
  decryptSecret,
  encryptSecret,
  generateApiKey,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from "../services/crypto.js";
import { normalizeProxyInput, validateProxyOverride } from "../services/antiBlock.js";
import { getDatabaseUrl } from "../db/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("auth");

const SESSION_TTL_DAYS = 7;

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "password must be at least 8 characters"),
  role: z.enum(["user", "admin"]).optional(),
});

const apiKeySchema = z.object({ label: z.string().trim().max(120).optional() });

const proxySchema = z.object({
  // null/empty clears the stored proxy (fall back to the server's env proxy).
  proxy: z.string().trim().nullable().optional(),
});

function bad(reply: FastifyReply, code: string, message: string, status = 400): Promise<void> {
  return reply.status(status).send({ success: false, error: { code, message } }) as unknown as Promise<void>;
}

const clampDays = (v: string | undefined): number => Math.min(Math.max(Number(v) || 30, 1), 365);
const clampLimit = (v: string | undefined): number => Math.min(Math.max(Number(v) || 50, 1), 500);

function setSessionCookie(reply: FastifyReply, token: string): void {
  const secure = process.env.COOKIE_SECURE !== "false"; // secure by default
  // Cross-site (frontend domain ≠ backend domain) needs SameSite=None; Secure.
  const sameSite = (process.env.COOKIE_SAMESITE as "none" | "lax" | "strict") || "none";
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite,
    path: "/",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export function registerAuthRoutes(app: FastifyInstance): void {
  // Guard the whole accounts feature behind a configured database.
  const dbRequired = (reply: FastifyReply): boolean => {
    if (!getDatabaseUrl()) {
      void bad(reply, "NOT_CONFIGURED", "Accounts require a database (DATABASE_URL).", 503);
      return true;
    }
    return false;
  };

  app.post("/api/auth/login", async (request, reply) => {
    if (dbRequired(reply)) return;
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return bad(reply, "INVALID_BODY", parsed.error.issues[0]?.message ?? "Invalid body.");

    const found = await getUserWithPasswordByEmail(parsed.data.email);
    // Same response whether the email is unknown or the password is wrong.
    if (!found || !verifyPassword(parsed.data.password, found.passwordHash)) {
      return bad(reply, "INVALID_CREDENTIALS", "Invalid email or password.", 401);
    }

    const { token, tokenHash } = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    await createSession({ userId: found.user.id, tokenHash, expiresAt });
    setSessionCookie(reply, token);
    // Also return the token so a cross-domain frontend can send it as an
    // X-Session-Token header (third-party cookies are blocked in Safari/ITP).
    return reply.send({
      success: true,
      token,
      user: { id: found.user.id, email: found.user.email, role: found.user.role },
    });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (token) await revokeSession(hashSessionToken(token)).catch(() => {});
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.send({ success: true });
  });

  app.get("/api/auth/me", { preHandler: requireSession }, async (request, reply) => {
    const user = await getUserById(request.auth!.userId!, decryptSecret);
    if (!user) return bad(reply, "NOT_FOUND", "Account not found.", 404);
    return reply.send({
      success: true,
      user: { id: user.id, email: user.email, role: user.role, hasProxy: Boolean(user.proxyUrl) },
    });
  });

  // --- API keys -------------------------------------------------------------

  app.get("/api/account/api-keys", { preHandler: requireSession }, async (request, reply) => {
    const keys = await listApiKeys(request.auth!.userId!);
    // Never expose hashes; prefixes only.
    return reply.send({
      success: true,
      keys: keys.map((k) => ({
        id: k.id,
        keyPrefix: k.keyPrefix,
        label: k.label,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
      })),
    });
  });

  app.post("/api/account/api-keys", { preHandler: requireSession }, async (request, reply) => {
    const parsed = apiKeySchema.safeParse(request.body ?? {});
    if (!parsed.success) return bad(reply, "INVALID_BODY", "Invalid label.");
    const user = await getUserById(request.auth!.userId!, decryptSecret);
    if (!user) return bad(reply, "NOT_FOUND", "Account not found.", 404);

    const generated = generateApiKey(user.email, new Date().toISOString());
    await insertApiKey({
      userId: user.id,
      uid: generated.uid,
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
      label: parsed.data.label ?? null,
    });
    // The plaintext key is returned exactly once and never stored.
    return reply.send({ success: true, key: generated.key, keyPrefix: generated.keyPrefix });
  });

  app.delete("/api/account/api-keys/:id", { preHandler: requireSession }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const ok = await revokeApiKey(request.auth!.userId!, id);
    if (!ok) return bad(reply, "NOT_FOUND", "Key not found or already revoked.", 404);
    return reply.send({ success: true });
  });

  // --- Proxy ----------------------------------------------------------------

  app.put("/api/account/proxy", { preHandler: requireSession }, async (request, reply) => {
    const parsed = proxySchema.safeParse(request.body ?? {});
    if (!parsed.success) return bad(reply, "INVALID_BODY", "Invalid body.");
    const raw = parsed.data.proxy?.trim();
    if (!raw) {
      await setUserProxyEncrypted(request.auth!.userId!, null);
      return reply.send({ success: true, hasProxy: false });
    }
    const err = validateProxyOverride(raw);
    if (err) return bad(reply, "INVALID_PROXY", err);
    // Store the normalized URL (curl command → clean http://user:pass@host:port).
    await setUserProxyEncrypted(request.auth!.userId!, encryptSecret(normalizeProxyInput(raw)));
    return reply.send({ success: true, hasProxy: true });
  });

  // --- Usage ----------------------------------------------------------------

  app.get("/api/account/usage", { preHandler: requireSession }, async (request, reply) => {
    const days = clampDays((request.query as { days?: string }).days);
    const daily = await getUsageDaily(request.auth!.userId!, days);
    return reply.send({ success: true, days, daily });
  });

  // Your own recent activity log.
  app.get("/api/account/events", { preHandler: requireSession }, async (request, reply) => {
    const q = request.query as { days?: string; limit?: string };
    const days = clampDays(q.days);
    const events = await getUsageEvents(request.auth!.userId!, days, clampLimit(q.limit));
    return reply.send({ success: true, days, events });
  });

  // --- Admin: inspect users + invite (no open signup) -----------------------

  app.get("/api/admin/users", { preHandler: requireAdminSession }, async (_request, reply) => {
    return reply.send({ success: true, users: await listUsers() });
  });

  app.get("/api/admin/users/:id/usage", { preHandler: requireAdminSession }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const days = clampDays((request.query as { days?: string }).days);
    return reply.send({ success: true, days, daily: await getUsageDaily(id, days) });
  });

  app.get("/api/admin/users/:id/events", { preHandler: requireAdminSession }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const q = request.query as { days?: string; limit?: string };
    const days = clampDays(q.days);
    return reply.send({ success: true, days, events: await getUsageEvents(id, days, clampLimit(q.limit)) });
  });

  app.post("/api/admin/users", { preHandler: requireAdminSession }, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) return bad(reply, "INVALID_BODY", parsed.error.issues[0]?.message ?? "Invalid body.");
    try {
      const id = await createUser({
        email: parsed.data.email,
        passwordHash: hashPassword(parsed.data.password),
        role: parsed.data.role ?? "user",
      });
      log.info("user created", { id, email: parsed.data.email, role: parsed.data.role ?? "user" });
      return reply.send({ success: true, user: { id, email: parsed.data.email.toLowerCase(), role: parsed.data.role ?? "user" } });
    } catch (err) {
      if (/unique/i.test((err as Error).message)) return bad(reply, "EMAIL_TAKEN", "That email already has an account.", 409);
      throw err;
    }
  });
}
