/**
 * Minimal logging seam. Errors must always be logged with context before being
 * handled or surfaced (common/logging.md). The API injects its real logger; the
 * default writes to the console.
 */
export interface Logger {
  error(message: string, context: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
}

/**
 * A child logger that merges `bindings` into the context of every log call, so a
 * stable set of correlation fields (e.g. a WS `connectionId` + `userId`) rides on
 * every line without each call site repeating them. Per-call context wins on a key
 * collision. Used to give every log emitted during one WebSocket connection's life a
 * `connectionId`, so logs from a superseded connection and its successor are
 * distinguishable (deliver-scalability.md §5.2).
 */
export function withContext(logger: Logger, bindings: Record<string, unknown>): Logger {
  return {
    error: (message, context) => logger.error(message, { ...bindings, ...context }),
    warn: (message, context) => logger.warn(message, { ...bindings, ...context }),
    info: (message, context) => logger.info(message, { ...bindings, ...context }),
  };
}

export const consoleLogger: Logger = {
  error(message, context) {
    console.error(message, context);
  },
  warn(message, context) {
    console.warn(message, context ?? {});
  },
  info(message, context) {
    console.info(message, context ?? {});
  },
};
