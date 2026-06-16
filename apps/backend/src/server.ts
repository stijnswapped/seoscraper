import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { globalRateLimit } from "./services/rateLimit.js";
import { sitesConfig } from "../../../config/sites.config.js";
import { registerCheckProductRoute } from "./routes/checkProduct.js";
import { registerListingTrackerRoutes } from "./routes/listingTracker.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBillingRoutes } from "./routes/billing.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: true });

  // Open CORS for the public API. Auth is by API key (a bearer secret the caller
  // holds) or the `X-Session-Token` header for the dashboard — never an ambient
  // cookie. So credentials:false: we do NOT expose the session cookie cross-origin,
  // which closes the "any site can ride a logged-in user's cookie" hole while
  // keeping the API itself fully open. The frontend authenticates with the
  // X-Session-Token header (not credentials), so it is unaffected.
  await app.register(cors, { origin: true, credentials: false });
  await app.register(cookie);

  // Per-credential (then per-IP) rate limiting. Registered before the routes so
  // per-route `config.rateLimit` overrides (login, scrape endpoints) take effect.
  await app.register(rateLimit, globalRateLimit);

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
  registerBillingRoutes(app);

  return app;
}
