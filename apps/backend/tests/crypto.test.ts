import { describe, it, expect } from "vitest";
import {
  API_KEY_PREFIX,
  decryptSecret,
  encryptSecret,
  generateApiKey,
  hashApiKey,
  hashesEqual,
  hashPassword,
  parseApiKeyUid,
  verifyPassword,
} from "../src/services/crypto.js";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", () => {
    const stored = hashPassword("hunter2");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("hunter2", stored)).toBe(true);
    expect(verifyPassword("Hunter2", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("produces a different salt/hash each time", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects malformed stored values", () => {
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    expect(verifyPassword("x", "bcrypt$a$b")).toBe(false);
  });
});

describe("secret encryption at rest", () => {
  it("round-trips a value", () => {
    const proxy = "http://user:p@ss@gate.smartproxy.net:3120";
    const enc = encryptSecret(proxy);
    expect(enc).not.toContain(proxy);
    expect(decryptSecret(enc)).toBe(proxy);
  });

  it("returns null for tampered or empty ciphertext", () => {
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret("")).toBeNull();
    expect(decryptSecret("garbage")).toBeNull();
    const enc = encryptSecret("secret");
    expect(decryptSecret(enc.slice(0, -2) + "00")).toBeNull(); // flipped tag/data byte
  });
});

describe("API keys", () => {
  it("generates the documented format with HMAC (non-PII) segments", () => {
    const email = "Customer@Example.com";
    const { key, uid, keyHash, keyPrefix } = generateApiKey(email, "2026-06-15T00:00:00.000Z");
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    const segments = key.slice(API_KEY_PREFIX.length).split(".");
    expect(segments).toHaveLength(4);
    expect(segments[0]).toBe(uid);
    // The email is NOT recoverable from the key (HMAC, not base64).
    expect(key.toLowerCase()).not.toContain("customer@example.com");
    expect(Buffer.from(segments[1]!, "base64url").toString("utf8")).not.toContain("example");
    expect(keyPrefix).toBe(`${API_KEY_PREFIX}${uid}`);
    expect(keyHash).toBe(hashApiKey(key));
  });

  it("parses the uid back out and rejects foreign keys", () => {
    const { key, uid } = generateApiKey("a@b.com", new Date().toISOString());
    expect(parseApiKeyUid(key)).toBe(uid);
    expect(parseApiKeyUid("sk-12345")).toBeNull();
    expect(parseApiKeyUid(`${API_KEY_PREFIX}only-one-segment`)).toBeNull();
  });

  it("hashes are unique per key and compare constant-time", () => {
    const a = generateApiKey("a@b.com", new Date().toISOString());
    const b = generateApiKey("a@b.com", new Date().toISOString());
    expect(a.keyHash).not.toBe(b.keyHash);
    expect(hashesEqual(a.keyHash, a.keyHash)).toBe(true);
    expect(hashesEqual(a.keyHash, b.keyHash)).toBe(false);
  });
});
