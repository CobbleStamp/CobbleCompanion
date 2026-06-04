/**
 * The shared tool-execution point (§4.7): unknown tool → error result, a thrown
 * tool → error result (failures are data), and toolCallId propagation onto every
 * result. The harness loop and the confirm route both go through here, so this is
 * the single place that proves dispatch behaves identically on both paths.
 */

import { describe, expect, it } from 'vitest';
import type { Logger } from '../logging.js';
import type { TurnCtx } from '../harness/hooks.js';
import { dispatchTool } from './dispatch.js';
import { ToolRegistry } from './registry.js';
import type { Tool } from './tool.js';

const ctx: TurnCtx = { companionId: 'c1', ownerId: 'u1' };
const silentLogger: Logger = { error: () => undefined, info: () => undefined };

/** A tool that records its args and returns a fixed result. */
function recordingTool(name: string, reply: string): Tool & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    effectful: false,
    async run(args) {
      calls.push(args);
      return { name, content: reply };
    },
  };
}

describe('dispatchTool', () => {
  it('runs a registered tool and returns its result', async () => {
    const tool = recordingTool('web_fetch', 'PAGE TEXT');
    const result = await dispatchTool(
      new ToolRegistry([tool]),
      'web_fetch',
      { url: 'https://x.dev' },
      ctx,
      silentLogger,
    );
    expect(result).toEqual({ name: 'web_fetch', content: 'PAGE TEXT' });
    expect(tool.calls).toEqual([{ url: 'https://x.dev' }]);
  });

  it('turns an unknown tool into an error result (never a silent block)', async () => {
    const result = await dispatchTool(new ToolRegistry(), 'mystery', {}, ctx, silentLogger);
    expect(result).toEqual({ name: 'mystery', content: 'Error: unknown tool "mystery".' });
  });

  it('turns a thrown tool into an error result and logs it (failures are data)', async () => {
    const throwing: Tool = {
      name: 'ingest_source',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      effectful: true,
      async run() {
        throw new Error('boom');
      },
    };
    const logged: Array<{ message: string; context: Record<string, unknown> }> = [];
    const logger: Logger = {
      error: (message, context) => logged.push({ message, context: context ?? {} }),
      info: () => undefined,
    };

    const result = await dispatchTool(
      new ToolRegistry([throwing]),
      'ingest_source',
      {},
      ctx,
      logger,
    );

    expect(result).toEqual({ name: 'ingest_source', content: 'Error: boom' });
    // The failure is logged with enough context to debug (logging.md).
    expect(logged).toHaveLength(1);
    expect(logged[0]?.context).toMatchObject({
      operation: 'dispatchTool',
      companionId: 'c1',
      tool: 'ingest_source',
    });
  });

  it('propagates toolCallId onto a successful result', async () => {
    const result = await dispatchTool(
      new ToolRegistry([recordingTool('web_fetch', 'ok')]),
      'web_fetch',
      {},
      ctx,
      silentLogger,
      'call_42',
    );
    expect(result.toolCallId).toBe('call_42');
  });

  it('propagates toolCallId onto an unknown-tool error result', async () => {
    const result = await dispatchTool(
      new ToolRegistry(),
      'mystery',
      {},
      ctx,
      silentLogger,
      'call_7',
    );
    expect(result).toEqual({
      name: 'mystery',
      content: 'Error: unknown tool "mystery".',
      toolCallId: 'call_7',
    });
  });

  it('propagates toolCallId onto a thrown-tool error result', async () => {
    const throwing: Tool = {
      name: 'ingest_source',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      effectful: true,
      async run() {
        throw new Error('boom');
      },
    };
    const result = await dispatchTool(
      new ToolRegistry([throwing]),
      'ingest_source',
      {},
      ctx,
      silentLogger,
      'call_9',
    );
    expect(result).toEqual({
      name: 'ingest_source',
      content: 'Error: boom',
      toolCallId: 'call_9',
    });
  });

  it('omits toolCallId entirely when none is supplied', async () => {
    const result = await dispatchTool(
      new ToolRegistry([recordingTool('web_fetch', 'ok')]),
      'web_fetch',
      {},
      ctx,
      silentLogger,
    );
    expect('toolCallId' in result).toBe(false);
  });
});
