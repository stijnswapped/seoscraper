/**
 * Crypto primitives for accounts: password hashing, secret encryption at rest,
 * API-key generation/verification, and session tokens. Uses only Node's built-in
 * `crypto` (scrypt + AES-256-GCM + HMAC) — no native deps.
 */
import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { createLogger } from "../utils/logger.js";

const log = createLogger("crypto");

// --- Server secrets ---------------------------------------------------------

let warnedDefaults = false;
function secret(envName: string, devDefault: string): string {
  const v = process.env[envName]?.trim();
  if (v) return v;
  if (!warnedDefaults) {
    warnedDefaults = true;
    log.warn("using INSECURE default crypto secrets; set API_KEY_HMAC_SECRET and SECRET_ENCRYPTION_KEY in production");
  }
  return devDefault;
}

const hmacSecret = (): string => secret("API_KEY_HMAC_SECRET", "dev-hmac-secret-change-me");
/** 32-byte key for AES-256-GCM, derived from the env secret. */
const encryptionKey = (): Buffer =>
  createHash("sha256").update(secret("SECRET_ENCRYPTION_KEY", "dev-encryption-key-change-me")).digest();

// --- Password hashing (scrypt) ----------------------------------------------

/** Hash a password as `scrypt$<saltHex>$<hashHex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Verify a password against a stored `scrypt$salt$hash` string (constant-time). */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// --- Secret encryption at rest (AES-256-GCM) --------------------------------

/** Encrypt a string as `<ivHex>:<tagHex>:<cipherHex>`. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

/** Decrypt a value produced by {@link encryptSecret}, or null if it can't be read. */
export function decryptSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = value.split(":");
  if (parts.length !== 3) return null;
  try {
    const [ivHex, tagHex, dataHex] = parts;
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivHex!, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex!, "hex"));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataHex!, "hex")), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}

// --- API keys ---------------------------------------------------------------

export const API_KEY_PREFIX = "SEO-Stijn-Scrape-v2-";

/** HMAC a value with the server secret, base64url, truncated (non-reversible). */
function hmacSegment(value: string): string {
  return createHmac("sha256", hmacSecret()).update(value).digest("base64url").slice(0, 22);
}

export interface GeneratedApiKey {
  /** The full plaintext key — shown to the user once, never stored. */
  key: string;
  uid: string;
  keyHash: string;
  keyPrefix: string;
}

/**
 * Build an API key of the form
 *   SEO-Stijn-Scrape-v2-{UID}.{hmac(email)}.{randomSecret}.{hmac(createdAt)}
 *
 * The email/date segments are HMAC digests (not reversible base64), so a leaked
 * key reveals no PII; the random secret carries the entropy. We persist only the
 * SHA-256 hash of the full key plus the {UID} (for O(1) lookup).
 */
export function generateApiKey(email: string, createdAtIso: string): GeneratedApiKey {
  const uid = randomBytes(9).toString("base64url"); // 12 chars, no '.'
  const emailSeg = hmacSegment(email.toLowerCase());
  const dateSeg = hmacSegment(createdAtIso);
  const randomSecret = randomBytes(24).toString("base64url");
  const key = `${API_KEY_PREFIX}${uid}.${emailSeg}.${randomSecret}.${dateSeg}`;
  return { key, uid, keyHash: hashApiKey(key), keyPrefix: `${API_KEY_PREFIX}${uid}` };
}

/** SHA-256 of a full API key (hex). What we store and compare against. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Extract the {UID} from a key for lookup, or null if it isn't our format. */
export function parseApiKeyUid(key: string): string | null {
  if (!key.startsWith(API_KEY_PREFIX)) return null;
  const rest = key.slice(API_KEY_PREFIX.length);
  const parts = rest.split(".");
  if (parts.length !== 4 || !parts[0]) return null;
  return parts[0];
}

/** Constant-time compare of two hex digests of equal length. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// --- Session tokens ---------------------------------------------------------

export interface GeneratedSession {
  /** Opaque token set in the cookie; only its hash is stored. */
  token: string;
  tokenHash: string;
}

export function generateSessionToken(): GeneratedSession {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: createHash("sha256").update(token).digest("hex") };
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export { randomUUID };
