type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
  if (raw in LEVELS) return raw as LogLevel;
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      msg: `Unrecognized LOG_LEVEL '${raw}', falling back to 'info'. Valid: debug, info, warn, error.`,
    }) + "\n",
  );
  return "info";
}

const activeLevel = LEVELS[resolveLevel()];

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (LEVELS[level] < activeLevel) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(context ?? {}),
  };
  process.stderr.write(JSON.stringify(line) + "\n");
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit("error", msg, ctx),
};
