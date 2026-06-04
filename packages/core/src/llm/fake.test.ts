/** The deterministic fake gateway: text streaming, scripted tool calls, multi-turn advance. */

import { describe, expect, it } from 'vitest';
import type { StreamResult } from './gateway.js';
import { FakeLlmGateway } from './fake.js';

async function drain(
  stream: AsyncGenerator<string, StreamResult, void>,
): Promise<{ text: string; result: StreamResult }> {
  let text = '';
  for (;;) {
    const { value, done } = await stream.next();
    if (done) return { text, result: value };
    text += value;
  }
}

const params = { messages: [{ role: 'user' as const, content: 'hi' }], model: 'm' };

describe('FakeLlmGateway', () => {
  it('streams a flat chunk list as a single text turn', async () => {
    const { text, result } = await drain(new FakeLlmGateway(['Hel', 'lo']).stream(params));
    expect(text).toBe('Hello');
    expect(result.toolCalls).toEqual([]);
  });

  it('returns scripted tool calls on the turn that has them', async () => {
    const gateway = new FakeLlmGateway([
      { toolCalls: [{ id: 't1', name: 'web_fetch', args: { url: 'u' } }] },
      { chunks: ['Done.'] },
    ]);

    const first = await drain(gateway.stream(params));
    expect(first.text).toBe('');
    expect(first.result.toolCalls).toEqual([{ id: 't1', name: 'web_fetch', args: { url: 'u' } }]);

    const second = await drain(gateway.stream(params));
    expect(second.text).toBe('Done.');
    expect(second.result.toolCalls).toEqual([]);
  });

  it('records each call and repeats the last turn once exhausted', async () => {
    const gateway = new FakeLlmGateway(['x']);
    await drain(gateway.stream(params));
    await drain(gateway.stream(params));
    expect(gateway.calls).toHaveLength(2);
    // The single turn repeats, so a third call still streams 'x'.
    const third = await drain(gateway.stream(params));
    expect(third.text).toBe('x');
  });
});
