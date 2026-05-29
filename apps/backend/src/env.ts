import dotenv from "dotenv";
import path from "node:path";

/**
 * Load environment variables from a local .env file for development.
 *
 * - Real platform environment variables (e.g. those injected by Railway) are
 *   ALWAYS preserved: dotenv never overrides an already-set variable.
 * - We look in the current working directory first (where `npm run dev` runs
 *   the backend workspace) and then the monorepo root, so a single root .env
 *   works regardless of where the process is started from.
 *
 * Import this module first, before anything that reads process.env.
 */
const candidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "..", "..", ".env"),
];

for (const file of candidates) {
  dotenv.config({ path: file });
}
