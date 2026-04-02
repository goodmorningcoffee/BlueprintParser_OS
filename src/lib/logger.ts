/**
 * Structured logger — zero-dependency, works in both Node and Edge runtimes.
 *
 * Usage:
 *   import { logger } from "@/lib/logger";
 *   logger.info("Processing page", { projectId: 5, page: 3 });
 *   logger.error("Upload failed", err);          // Error object auto-serialized
 *   logger.error("Upload failed", { err, key }); // Or pass context object
 *
 * Set LOG_LEVEL env var: "error" | "warn" | "info" (default) | "debug"
 */

type LogLevel = "error" | "warn" | "info" | "debug";
type LogContext = Record<string, unknown> | Error | unknown;

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const currentLevel: number = LEVELS[(process.env.LOG_LEVEL as LogLevel) || "info"] ?? LEVELS.info;

function formatLog(level: LogLevel, msg: string, ctx?: LogContext): string {
  const entry: Record<string, unknown> = { level, msg, ts: new Date().toISOString() };
  if (ctx instanceof Error) {
    entry.error = { message: ctx.message, stack: ctx.stack };
  } else if (ctx && typeof ctx === "object" && ctx !== null) {
    for (const [k, v] of Object.entries(ctx as Record<string, unknown>)) {
      if (v instanceof Error) {
        entry[k] = { message: v.message, stack: v.stack };
      } else {
        entry[k] = v;
      }
    }
  } else if (ctx !== undefined) {
    entry.detail = ctx;
  }
  return JSON.stringify(entry);
}

export const logger = {
  error(msg: string, ctx?: LogContext) {
    if (currentLevel >= LEVELS.error) console.error(formatLog("error", msg, ctx));
  },
  warn(msg: string, ctx?: LogContext) {
    if (currentLevel >= LEVELS.warn) console.warn(formatLog("warn", msg, ctx));
  },
  info(msg: string, ctx?: LogContext) {
    if (currentLevel >= LEVELS.info) console.log(formatLog("info", msg, ctx));
  },
  debug(msg: string, ctx?: LogContext) {
    if (currentLevel >= LEVELS.debug) console.log(formatLog("debug", msg, ctx));
  },
};
