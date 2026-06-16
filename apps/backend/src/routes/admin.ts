import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sitesConfig } from "../../../../config/sites.config.js";
import { requireApiKeyAuth, requireApiAdmin } from "../services/apiAuth.js";
import { cleanupOldRuns, purgeAllRuns, getStorageStats } from "../services/storageMaintenance.js";

const cleanupBodySchema = z.object({
  /** Delete runs older than this many days. Omit or 0 to purge ALL runs. */
  olderThanDays: z.number().int().min(0).optional(),
});

export function registerAdminRoutes(app: FastifyInstance): void {
  // Read-only disk check: run-folder count + volume free/used space.
  app.get("/api/admin/storage", { preHandler: [requireApiKeyAuth, requireApiAdmin] }, async (_request, reply) => {
    const stats = await getStorageStats(sitesConfig.output.baseDir);
    return reply.send({ success: true, ...stats });
  });


  // Free disk space on the output volume. Auth-protected; safe to call anytime
  // (research run files are regenerable and rank tracking writes nothing here).
  app.post("/api/admin/cleanup-runs", { preHandler: [requireApiKeyAuth, requireApiAdmin] }, async (request, reply) => {
    const parsed = cleanupBodySchema.safeParse(request.body ?? {});
    const days = parsed.success ? parsed.data.olderThanDays : undefined;
    const baseDir = sitesConfig.output.baseDir;

    const removed = days && days > 0 ? await cleanupOldRuns(baseDir, days) : await purgeAllRuns(baseDir);
    return reply.send({
      success: true,
      removed,
      scope: days && days > 0 ? `runs older than ${days} day(s)` : "all runs",
    });
  });
}
