import type { Logger } from './gateway/types.js';

/**
 * A minimal structured logger for the worker process: JSON lines to stdout (info) /
 * stderr (warn/error). Not `console.log` — this is the logging boundary. `Error` values
 * in metadata are serialized to `{ name, message, stack }` so stacks aren't lost.
 */
function serialize(level: string, message: string, meta?: Record<string, unknown>): string {
  const record = { level, msg: message, ...(meta ?? {}) };
  return (
    JSON.stringify(record, (_key, value) =>
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value,
    ) + '\n'
  );
}

export const consoleLogger: Logger = {
  error: (message, meta) => process.stderr.write(serialize('error', message, meta)),
  warn: (message, meta) => process.stderr.write(serialize('warn', message, meta)),
  info: (message, meta) => process.stdout.write(serialize('info', message, meta)),
};
