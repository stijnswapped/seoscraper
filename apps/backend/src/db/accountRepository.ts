import { randomUUID } from "node:crypto";
import { query } from "./postgres.js";

export interface UserRecord {
  id: string;
  email: string;
  role: "user" | "admin";
  /** Decrypted proxy URL, or null. Callers must NOT log this. */
  proxyUrl: string | null;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: "user" | "admin";
  proxy_url_encrypted: string | null;
  created_at: Date;
}

export interface ApiKeyRecord {
  id: string;
  userId: string;
  uid: string;
  keyPrefix: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface ApiKeyRow {
  id: string;
  user_id: string;
  uid: string;
  key_hash: string;
  key_prefix: string;
  label: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

// --- Users ------------------------------------------------------------------

export async function createUser(input: {
  email: string;
  passwordHash: string;
  role?: "user" | "admin";
}): Promise<string> {
  const id = randomUUID();
  await query(
    `insert into users (id, email, password_hash, role) values ($1, $2, $3, $4)`,
    [id, input.email.toLowerCase().trim(), input.passwordHash, input.role ?? "user"],
  );
  return id;
}

function rowToUser(row: UserRow, decrypt: (v: string | null) => string | null): UserRecord {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    proxyUrl: decrypt(row.proxy_url_encrypted),
    createdAt: row.created_at.toISOString(),
  };
}

/** Look up a user by email, returning the row INCLUDING the password hash (login only). */
export async function getUserWithPasswordByEmail(
  email: string,
): Promise<{ user: Omit<UserRow, "password_hash">; passwordHash: string } | null> {
  const res = await query<UserRow>(`select * from users where email = $1`, [email.toLowerCase().trim()]);
  const row = res.rows[0];
  if (!row) return null;
  const { password_hash, ...rest } = row;
  return { user: rest, passwordHash: password_hash };
}

export async function getUserById(
  id: string,
  decrypt: (v: string | null) => string | null,
): Promise<UserRecord | null> {
  const res = await query<UserRow>(`select * from users where id = $1`, [id]);
  return res.rows[0] ? rowToUser(res.rows[0], decrypt) : null;
}

export async function setUserProxyEncrypted(userId: string, proxyUrlEncrypted: string | null): Promise<void> {
  await query(`update users set proxy_url_encrypted = $2 where id = $1`, [userId, proxyUrlEncrypted]);
}

// --- API keys ---------------------------------------------------------------

export async function insertApiKey(input: {
  userId: string;
  uid: string;
  keyHash: string;
  keyPrefix: string;
  label?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await query(
    `insert into api_keys (id, user_id, uid, key_hash, key_prefix, label) values ($1, $2, $3, $4, $5, $6)`,
    [id, input.userId, input.uid, input.keyHash, input.keyPrefix, input.label ?? null],
  );
  return id;
}

/** Active (non-revoked) key row for a uid, including its hash for verification. */
export async function getActiveApiKeyByUid(
  uid: string,
): Promise<{ id: string; userId: string; keyHash: string } | null> {
  const res = await query<ApiKeyRow>(
    `select * from api_keys where uid = $1 and revoked_at is null`,
    [uid],
  );
  const row = res.rows[0];
  return row ? { id: row.id, userId: row.user_id, keyHash: row.key_hash } : null;
}

export async function touchApiKeyUsed(id: string): Promise<void> {
  await query(`update api_keys set last_used_at = now() where id = $1`, [id]);
}

export async function listApiKeys(userId: string): Promise<ApiKeyRecord[]> {
  const res = await query<ApiKeyRow>(
    `select * from api_keys where user_id = $1 order by created_at desc`,
    [userId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    uid: r.uid,
    keyPrefix: r.key_prefix,
    label: r.label,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    revokedAt: r.revoked_at?.toISOString() ?? null,
  }));
}

export async function revokeApiKey(userId: string, id: string): Promise<boolean> {
  const res = await query(
    `update api_keys set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null`,
    [id, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

// --- Sessions ---------------------------------------------------------------

export async function createSession(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  await query(
    `insert into sessions (id, user_id, token_hash, expires_at) values ($1, $2, $3, $4)`,
    [randomUUID(), input.userId, input.tokenHash, input.expiresAt],
  );
}

/** Resolve a (live, non-expired, non-revoked) session token to its user id. */
export async function getUserIdForSession(tokenHash: string): Promise<string | null> {
  const res = await query<{ user_id: string }>(
    `select user_id from sessions
       where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [tokenHash],
  );
  return res.rows[0]?.user_id ?? null;
}

export async function revokeSession(tokenHash: string): Promise<void> {
  await query(`update sessions set revoked_at = now() where token_hash = $1`, [tokenHash]);
}

// --- Usage ------------------------------------------------------------------

export async function recordUsageEvent(input: {
  userId: string | null;
  apiKeyId: string | null;
  endpoint: string;
  status: number | null;
  ok: boolean;
  durationMs: number;
  usedProxy: string;
  units?: number;
  billable?: boolean;
}): Promise<void> {
  await query(
    `insert into usage_events (user_id, api_key_id, endpoint, status, ok, duration_ms, used_proxy, units, billable)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.userId,
      input.apiKeyId,
      input.endpoint,
      input.status,
      input.ok,
      input.durationMs,
      input.usedProxy,
      input.units ?? 1,
      input.billable ?? true,
    ],
  );
}

export interface AdminUserRecord {
  id: string;
  email: string;
  role: "user" | "admin";
  hasProxy: boolean;
  createdAt: string;
  planCode: string;
  billingStatus: string;
  manualPlanCode: string | null;
  manualUnlimited: boolean;
}

/** All accounts, for the admin user picker. */
export async function listUsers(): Promise<AdminUserRecord[]> {
  const res = await query<{
    id: string;
    email: string;
    role: "user" | "admin";
    has_proxy: boolean;
    created_at: Date;
    plan_code: string | null;
    billing_status: string | null;
    manual_plan_code: string | null;
    manual_unlimited: boolean | null;
  }>(
    `select u.id,
            u.email,
            u.role,
            (u.proxy_url_encrypted is not null) as has_proxy,
            u.created_at,
            b.plan_code,
            b.billing_status,
            b.manual_plan_code,
            b.manual_unlimited
       from users u
       left join billing_entitlements b on b.user_id = u.id
      order by u.created_at`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    hasProxy: r.has_proxy,
    createdAt: r.created_at.toISOString(),
    planCode: r.plan_code ?? "free",
    billingStatus: r.billing_status ?? "free",
    manualPlanCode: r.manual_plan_code,
    manualUnlimited: r.manual_unlimited ?? false,
  }));
}

export interface UsageEvent {
  ts: string;
  endpoint: string;
  status: number | null;
  ok: boolean;
  durationMs: number | null;
  usedProxy: string | null;
}

/** Recent raw usage events for a user (the "logs" view), newest first. */
export async function getUsageEvents(userId: string, days: number, limit: number): Promise<UsageEvent[]> {
  const res = await query<{
    ts: Date;
    endpoint: string;
    status: number | null;
    ok: boolean;
    duration_ms: number | null;
    used_proxy: string | null;
  }>(
    `select ts, endpoint, status, ok, duration_ms, used_proxy
       from usage_events
      where user_id = $1 and ts > now() - ($2 || ' days')::interval
      order by ts desc limit $3`,
    [userId, String(days), limit],
  );
  return res.rows.map((r) => ({
    ts: r.ts.toISOString(),
    endpoint: r.endpoint,
    status: r.status,
    ok: r.ok,
    durationMs: r.duration_ms,
    usedProxy: r.used_proxy,
  }));
}

// --- Invites ----------------------------------------------------------------

export interface InviteRecord {
  id: string;
  email: string | null;
  role: "user" | "admin";
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  status: "pending" | "used" | "expired";
}

export async function createInvite(input: {
  tokenHash: string;
  email: string | null;
  role: "user" | "admin";
  createdBy: string | null;
  expiresAt: Date;
}): Promise<string> {
  const id = randomUUID();
  await query(
    `insert into invites (id, token_hash, email, role, created_by, expires_at)
       values ($1, $2, $3, $4, $5, $6)`,
    [id, input.tokenHash, input.email, input.role, input.createdBy, input.expiresAt],
  );
  return id;
}

/** A still-usable invite (not used, not expired) for this token hash, or null. */
export async function getValidInviteByTokenHash(
  tokenHash: string,
): Promise<{ id: string; email: string | null; role: "user" | "admin" } | null> {
  const res = await query<{ id: string; email: string | null; role: "user" | "admin" }>(
    `select id, email, role from invites
       where token_hash = $1 and used_at is null and expires_at > now()`,
    [tokenHash],
  );
  return res.rows[0] ?? null;
}

/** Atomically consume an invite. Returns false if it was already used. */
export async function markInviteUsed(id: string, userId: string): Promise<boolean> {
  const res = await query(
    `update invites set used_at = now(), used_user_id = $2 where id = $1 and used_at is null`,
    [id, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listInvites(): Promise<InviteRecord[]> {
  const res = await query<{
    id: string;
    email: string | null;
    role: "user" | "admin";
    created_at: Date;
    expires_at: Date;
    used_at: Date | null;
  }>(`select id, email, role, created_at, expires_at, used_at from invites order by created_at desc`);
  const now = Date.now();
  return res.rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    usedAt: r.used_at?.toISOString() ?? null,
    status: r.used_at ? "used" : r.expires_at.getTime() < now ? "expired" : "pending",
  }));
}

/** Delete a still-pending invite (used invites are kept as a record). */
export async function revokeInvite(id: string): Promise<boolean> {
  const res = await query(`delete from invites where id = $1 and used_at is null`, [id]);
  return (res.rowCount ?? 0) > 0;
}

export interface UsageDailyPoint {
  day: string;
  total: number;
  ok: number;
  failed: number;
}

/** Per-day usage counts for the last `days` days, for the dashboard graphs. */
export async function getUsageDaily(userId: string, days: number): Promise<UsageDailyPoint[]> {
  const res = await query<{ day: Date; total: string; ok: string; failed: string }>(
    `select date_trunc('day', ts) as day,
            count(*)::text as total,
            count(*) filter (where ok)::text as ok,
            count(*) filter (where not ok)::text as failed
       from usage_events
      where user_id = $1 and ts > now() - ($2 || ' days')::interval
      group by 1 order by 1`,
    [userId, String(days)],
  );
  return res.rows.map((r) => ({
    day: r.day.toISOString().slice(0, 10),
    total: Number(r.total),
    ok: Number(r.ok),
    failed: Number(r.failed),
  }));
}
