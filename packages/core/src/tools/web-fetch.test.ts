/** The web_fetch read-only tool: resolve → parse → text, with capping + failure-as-data. */

import { describe, expect, it } from 'vitest';
import type { RawContent } from '../ingestion/content-parser.js';
import type { LinkResolver } from '../ingestion/link-resolver.js';
import type { TurnCtx } from '../harness/hooks.js';
import type { Logger } from '../logging.js';
import { createWebFetchTool } from './web-fetch.js';

const ctx: TurnCtx = { companionId: 'c1', ownerId: 'u1' };
const silentLogger: Logger = { error: () => undefined, info: () => undefined };

/** A resolver that returns the given text as a plain-text body (the note parser). */
function textResolver(text: string): LinkResolver {
  return {
    async resolve(): Promise<RawContent> {
      return { bytes: new TextEncoder().encode(text), contentType: 'text' };
    },
  };
}

describe('createWebFetchTool', () => {
  it('is a read-only tool', () => {
    expect(createWebFetchTool({ resolver: textResolver('') }).effectful).toBe(false);
  });

  it('fetches and returns the parsed text', async () => {
    const tool = createWebFetchTool({ resolver: textResolver('Hello world.\n\nSecond para.') });
    const result = await tool.run({ url: 'https://example.com/a' }, ctx);
    expect(result.name).toBe('web_fetch');
    expect(result.content).toContain('Hello world.');
    expect(result.content).toContain('Second para.');
  });

  it('truncates text beyond the char cap', async () => {
    const tool = createWebFetchTool({ resolver: textResolver('a'.repeat(50)), maxChars: 10 });
    const result = await tool.run({ url: 'https://example.com/a' }, ctx);
    expect(result.content).toBe(`${'a'.repeat(10)}\n…[truncated]`);
  });

  it('rejects a missing/invalid url as an error result (not a throw)', async () => {
    const tool = createWebFetchTool({ resolver: textResolver('x') });
    expect((await tool.run({}, ctx)).content).toMatch(/valid absolute "url"/);
    expect((await tool.run({ url: 'not-a-url' }, ctx)).content).toMatch(/valid absolute "url"/);
  });

  it('returns a fetch failure as text rather than throwing', async () => {
    const resolver: LinkResolver = {
      async resolve(): Promise<RawContent> {
        throw new Error('link fetch responded 404');
      },
    };
    const tool = createWebFetchTool({ resolver, logger: silentLogger });
    const result = await tool.run({ url: 'https://example.com/missing' }, ctx);
    expect(result.content).toContain('Error fetching https://example.com/missing');
    expect(result.content).toContain('404');
  });
});
