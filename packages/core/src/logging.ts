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
