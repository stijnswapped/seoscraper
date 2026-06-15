import { createUser, getUserWithPasswordByEmail } from "../db/accountRepository.js";
import { hashPassword } from "./crypto.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("adminSeed");

/**
 * Create the bootstrap admin from ADMIN_EMAIL / ADMIN_PASSWORD if it doesn't yet
 * exist. There's no open signup, so this is how the first account comes into
 * being; all further accounts are created by an admin via /api/admin/users.
 * No-op when the env vars are unset or the account already exists.
 */
export async function seedAdminUser(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  try {
    if (await getUserWithPasswordByEmail(email)) return; // already exists
    await createUser({ email, passwordHash: hashPassword(password), role: "admin" });
    log.info("bootstrap admin created", { email });
  } catch (err) {
    log.warn("could not seed admin user", { message: (err as Error).message });
  }
}
