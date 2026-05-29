import path from "node:path";
import { mkdir } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { sitesConfig } from "../../../config/sites.config.js";
import { registerDashboardRoute } from "./routes/dashboard.js";
import { registerCheckProductRoute } from "./routes/checkProduct.js";
import { registerListingTrackerRoutes } from "./routes/listingTracker.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  await app.register(cors, { origin: true });

  const outputDir = path.resolve(sitesConfig.output.baseDir);
  await mkdir(outputDir, { recursive: true });

  // Serve generated runs so the frontend can preview downloaded images.
  await app.register(fastifyStatic, {
    root: outputDir,
    prefix: "/files/",
    decorateReply: false,
  });

  app.get("/health", async () => ({ ok: true }));

  registerDashboardRoute(app);
  registerCheckProductRoute(app);
  registerListingTrackerRoutes(app);

  return app;
}
