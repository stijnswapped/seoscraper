import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { sitesConfig } from "../../../config/sites.config.js";
import { registerCheckProductRoute } from "./routes/checkProduct.js";
import { registerListingTrackerRoutes } from "./routes/listingTracker.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  await app.register(cors, { origin: true });

  // Serve generated runs so the frontend can preview downloaded images.
  await app.register(fastifyStatic, {
    root: path.resolve(sitesConfig.output.baseDir),
    prefix: "/files/",
    decorateReply: false,
  });

  app.get("/health", async () => ({ ok: true }));

  registerCheckProductRoute(app);
  registerListingTrackerRoutes(app);

  return app;
}
