/** The web_fetch read-only tool: resolve → parse → text, with capping + failure-as-data. */

import { describe, expect, it } from 'vitest';
import type { RawContent } from '../ingestion/content-parser.js';
import type { LinkResolver } from '../ingestion/link-resolver.js';
import type { TurnCtx } from '../harness/hooks.js';
import type { Logger } from '../logging.js';
import type { LeadStatus } from '@cobble/shared';
import type { LeadRecord, LeadStore } from './lead-store.js';
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

/** A resolver that returns an HTML body with a base URL (for link harvesting). */
function htmlResolver(html: string, sourceUrl: string): LinkResolver {
  return {
    async resolve(): Promise<RawContent> {
      return { bytes: new TextEncoder().encode(html), contentType: 'html', sourceUrl };
    },
  };
}

/** A lead store that records captures. */
function fakeLeads(): LeadStore & { captured: { url: string; why?: string }[] } {
  const captured: { url: string; why?: string }[] = [];
  return {
    captured,
    async record(_companionId: string, url: string, why?: string) {
      captured.push(why !== undefined ? { url, why } : { url });
    },
    async listByStatus(): Promise<readonly LeadRecord[]> {
      return [];
    },
    async markStatus(_c: string, _id: string, _s: LeadStatus) {},
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

  it('harvests outbound http(s) links from an HTML page into the reading list', async () => {
    const leads = fakeLeads();
    const html = `<html><body>
      <a href="https://other.dev/post">post</a>
      <a href="/relative">rel</a>
      <a href="mailto:x@y.dev">mail</a>
      <a href="https://other.dev/post">dup</a>
    </body></html>`;
    const tool = createWebFetchTool({
      resolver: htmlResolver(html, 'https://src.dev/page'),
      leads,
    });
    await tool.run({ url: 'https://src.dev/page' }, ctx);
    const urls = leads.captured.map((c) => c.url);
    expect(urls).toContain('https://other.dev/post');
    expect(urls).toContain('https://src.dev/relative'); // relative resolved against base
    expect(urls).not.toContain('mailto:x@y.dev'); // non-http dropped
    expect(urls.filter((u) => u === 'https://other.dev/post')).toHaveLength(1); // deduped
    expect(leads.captured[0]!.why).toContain('found while reading');
  });

  it('does not harvest when no lead store is configured', async () => {
    const tool = createWebFetchTool({
      resolver: htmlResolver('<a href="https://x.dev">x</a>', 'https://s.dev'),
    });
    // No throw, returns text; nothing to assert beyond it completing.
    const result = await tool.run({ url: 'https://s.dev' }, ctx);
    expect(result.name).toBe('web_fetch');
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
