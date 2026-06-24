import { describe, expect, it } from 'vitest';
import { type Logger, withContext } from './logging.js';

/** A logger that records each call's message + context for assertions. */
function recordingLogger(): {
  logger: Logger;
  calls: {
    level: 'error' | 'warn' | 'info';
    message: string;
    context: Record<string, unknown> | undefined;
  }[];
} {
  const calls: {
    level: 'error' | 'warn' | 'info';
    message: string;
    context: Record<string, unknown> | undefined;
  }[] = [];
  return {
    calls,
    logger: {
      error: (message, context) => calls.push({ level: 'error', message, context }),
      warn: (message, context) => calls.push({ level: 'warn', message, context }),
      info: (message, context) => calls.push({ level: 'info', message, context }),
    },
  };
}

describe('withContext', () => {
  it('merges the bound fields into every log level', () => {
    const { logger, calls } = recordingLogger();
    const child = withContext(logger, { connectionId: 'c-1', userId: 'u-1' });

    child.error('boom', { operation: 'ws.dispatch' });
    child.warn('slow');
    child.info('opened');

    expect(calls).toEqual([
      {
        level: 'error',
        message: 'boom',
        context: { connectionId: 'c-1', userId: 'u-1', operation: 'ws.dispatch' },
      },
      { level: 'warn', message: 'slow', context: { connectionId: 'c-1', userId: 'u-1' } },
      { level: 'info', message: 'opened', context: { connectionId: 'c-1', userId: 'u-1' } },
    ]);
  });

  it('lets per-call context override a bound field on a key collision', () => {
    const { logger, calls } = recordingLogger();
    const child = withContext(logger, { connectionId: 'c-1' });

    child.error('boom', { connectionId: 'override' });

    expect(calls[0]?.context).toEqual({ connectionId: 'override' });
  });
});
