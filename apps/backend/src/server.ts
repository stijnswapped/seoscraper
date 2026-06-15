import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { sitesConfig } from "../../../config/sites.config.js";
import { registerCheckProductRoute } from "./routes/checkProduct.js";
import { registerListingTrackerRoutes } from "./routes/listingTracker.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: true });

  // credentials:true so the dashboard's httpOnly session cookie is accepted
  // cross-origin (frontend domain ≠ backend domain). Origin is reflected, not '*'.
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);

  // Serve generated runs so the frontend can preview downloaded images.
  await app.register(fastifyStatic, {
    root: path.resolve(sitesConfig.output.baseDir),
    prefix: "/files/",
    decorateReply: false,
  });

  app.get("/health", async () => ({ ok: true }));

  registerCheckProductRoute(app);
  registerListingTrackerRoutes(app);
  registerAdminRoutes(app);
  registerAuthRoutes(app);

  return app;
}
