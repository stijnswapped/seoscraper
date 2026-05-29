import type { FastifyReply } from "fastify";

export interface ProgressEvent {
  runId: string;
  phase: string;
  message: string;
  url?: string;
  current?: number;
  total?: number;
  timestamp: string;
}

export type ProgressReporter = (event: Omit<ProgressEvent, "runId" | "timestamp">) => void;

const clients = new Map<string, Set<FastifyReply>>();
const history = new Map<string, ProgressEvent[]>();

export function createProgressReporter(runId?: string): ProgressReporter {
  return (event) => {
    if (!runId) return;
    publishProgress(runId, event);
  };
}

export function attachProgressClient(runId: string, reply: FastifyReply): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write("retry: 1000\n\n");

  let set = clients.get(runId);
  if (!set) {
    set = new Set();
    clients.set(runId, set);
  }
  set.add(reply);

  for (const event of history.get(runId) ?? []) {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  reply.raw.on("close", () => {
    set?.delete(reply);
    if (set?.size === 0) clients.delete(runId);
  });
}

export function publishProgress(
  runId: string,
  event: Omit<ProgressEvent, "runId" | "timestamp">,
): void {
  const payload: ProgressEvent = {
    runId,
    timestamp: new Date().toISOString(),
    ...event,
  };
  const existing = history.get(runId) ?? [];
  history.set(runId, [...existing.slice(-24), payload]);
  const message = `data: ${JSON.stringify(payload)}\n\n`;
  const set = clients.get(runId);
  if (!set) return;

  for (const reply of set) {
    reply.raw.write(message);
  }
}

export function finishProgress(runId?: string): void {
  if (!runId) return;
  publishProgress(runId, {
    phase: "complete",
    message: "Check complete.",
  });
  const set = clients.get(runId);
  history.delete(runId);
  if (!set) return;
  for (const reply of set) {
    reply.raw.end();
  }
  clients.delete(runId);
}
