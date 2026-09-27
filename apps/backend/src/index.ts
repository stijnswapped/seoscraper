import "./env.js";
import { buildServer } from "./server.js";
import { runMigrations } from "./db/migrate.js";
import { getDatabaseUrl } from "./db/postgres.js";
import { startStorageCleanup } from "./services/storageMaintenance.js";
import { seedAdminUser } from "./services/adminSeed.js";
import { orphansAreReaped, readProcessDiagnostics } from "./services/browserHealth.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("server");
const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "0.0.0.0";

// Global error handlers to prevent silent crashes
process.on("unhandledRejection", (reason, promise) => {
  log.error("unhandled promise rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
    promise: String(promise),
  });
});

process.on("uncaughtException", (err) => {
  log.error("uncaught exception", { message: err.message, stack: err.stack });
  process.exit(1);
});

async function main(): Promise<void> {
  const app = await buildServer();
  await app.listen({ port: PORT, host: HOST });
  log.info(`listening on http://${HOST}:${PORT}`);

  // Every Chromium session leaves helper processes behind for an init (PID 1,
  // or tini -s as our parent) to reap. Without one (e.g. a start command that
  // bypasses tini) they pile up as zombies until browser launches start failing
  // with SIGTRAP.
  const runtime = readProcessDiagnostics();
  if (runtime.pid1 !== undefined && !orphansAreReaped(runtime)) {
    log.warn("no init reaps exited Chromium helpers (PID 1 and parent are not tini/an init)", runtime);
  } else {
    log.info("runtime", runtime);
  }

  // Periodically prune old on-disk research runs so disk stays bounded.
  startStorageCleanup();

  // Run DB migrations in the background after the server is already accepting
  // connections. This prevents Railway's healthcheck from timing out (SIGTERM)
  // while waiting for migrations to complete on a cold start.
  if (getDatabaseUrl()) {
    runMigrations()
      .then(async () => {
        log.info("database migrations applied");
        // Bootstrap the first admin from env (no open signup). No-op if it
        // already exists or the env vars are unset.
        await seedAdminUser();
      })
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

