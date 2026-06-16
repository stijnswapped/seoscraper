import type { FastifyRequest } from "fastify";
import { getDatabaseUrl } from "../db/postgres.js";
import { recordUsageEvent } from "../db/accountRepository.js";
import { hasEnvProxy } from "./antiBlock.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("usage");

/** Which proxy a scrape ended up using, for the dashboard breakdown. */
export function proxySource(requestProxy: string | undefined, userProxy: string | null | undefined): string {
  if (requestProxy) return "request";
  if (userProxy) return "user";
  return hasEnvProxy() ? "env" : "none";
}

/**
 * Record one billable scrape call. Best-effort: no-ops without a database and
 * never throws into the request path (a logging failure must not fail a scrape).
 */
export async function logUsage(
  request: FastifyRequest,
  input: {
    endpoint: string;
    status: number | null;
    ok: boolean;
    durationMs: number;
    usedProxy: string;
    units?: number;
    billable?: boolean;
  },
): Promise<void> {
  if (!getDatabaseUrl()) return;
  try {
    await recordUsageEvent({
      userId: request.auth?.userId ?? null,
      apiKeyId: request.auth?.apiKeyId ?? null,
      ...input,
    });
  } catch (err) {
    log.warn("failed to record usage event", { message: (err as Error).message });
  }
}
