import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "./postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("db:migrate");

export async function runMigrations(): Promise<void> {
  await query(`create table if not exists schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
  )`);

  const migrations = [
    "001_listing_tracker.sql",
    "002_title_seo.sql",
    "003_accounts.sql",
    "004_invites.sql",
    "005_billing.sql",
    "006_listing_owner.sql",
    "007_early_access.sql",
  ];
  const migrationsDir = path.dirname(fileURLToPath(import.meta.url));

  for (const migration of migrations) {
    const applied = await query<{ version: string }>(
      "select version from schema_migrations where version = $1",
      [migration],
    );
    if (applied.rows.length > 0) continue;

    const sql = await readFile(path.join(migrationsDir, "migrations", migration), "utf8");
    await query(sql);
    await query("insert into schema_migrations (version) values ($1)", [migration]);
    log.info("migration applied", { migration });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch((err) => {
    log.error("migration failed", { message: (err as Error).message });
    process.exit(1);
  });
}
