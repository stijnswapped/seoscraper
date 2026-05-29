/** Tiny structured logger. Keeps logs greppable without pulling in a dep. */

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase()}] (${scope}) ${msg}`;
  const line =
    extra === undefined ? base : `${base} ${safeStringify(extra)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (msg, extra) => emit("debug", scope, msg, extra),
    info: (msg, extra) => emit("info", scope, msg, extra),
    warn: (msg, extra) => emit("warn", scope, msg, extra),
    error: (msg, extra) => emit("error", scope, msg, extra),
  };
}
