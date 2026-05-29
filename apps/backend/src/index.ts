import { buildServer } from "./server.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("server");
const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";

async function main(): Promise<void> {
  const app = await buildServer();
  await app.listen({ port: PORT, host: HOST });
  log.info(`listening on http://${HOST}:${PORT}`);
}

main().catch((err) => {
  log.error("failed to start server", { message: (err as Error).message });
  process.exit(1);
});
