import "./env.js";
import { buildServer } from "./server.js";
import { runMigrations } from "./db/migrate.js";
import { getDatabaseUrl } from "./db/postgres.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("server");
const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";

async function main(): Promise<void> {
  // Apply DB migrations on boot when a database is configured. The core
  // product checker still works without a database; only the listing rank
  // tracker endpoints need one.
  if (getDatabaseUrl()) {
    try {
      await runMigrations();
      log.info("database migrations applied");
    } catch (err) {
      log.error("database migration failed; listing tracker endpoints may not work", {
        message: (err as Error).message,
      });
    }
  } else {
    log.warn("DATABASE_URL not set; listing tracker endpoints are disabled");
  }

  const app = await buildServer();
  await app.listen({ port: PORT, host: HOST });
  log.info(`listening on http://${HOST}:${PORT}`);
}

main().catch((err) => {
  log.error("failed to start server", { message: (err as Error).message });
  process.exit(1);
});
