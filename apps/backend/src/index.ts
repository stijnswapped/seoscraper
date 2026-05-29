import "./env.js";
import { buildServer } from "./server.js";
import { runMigrations } from "./db/migrate.js";
import { getDatabaseUrl } from "./db/postgres.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("server");
const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  const app = await buildServer();
  await app.listen({ port: PORT, host: HOST });
  log.info(`listening on http://${HOST}:${PORT}`);

  // Run DB migrations in the background after the server is already accepting
  // connections. This prevents Railway's healthcheck from timing out (SIGTERM)
  // while waiting for migrations to complete on a cold start.
  if (getDatabaseUrl()) {
    runMigrations()
      .then(() => log.info("database migrations applied"))
      .catch((err) =>
        log.error("database migration failed; listing tracker endpoints may not work", {
          message: (err as Error).message,
        }),
      );
  } else {
    log.warn("DATABASE_URL not set; listing tracker endpoints are disabled");
  }
}

main().catch((err) => {
  log.error("failed to start server", { message: (err as Error).message });
  process.exit(1);
});
