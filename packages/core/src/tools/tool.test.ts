/** Unit tests for the tool helper functions: summaries, projection, arg readers. */

import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../harness/hooks.js';
import {
  readHttpUrlArg,
  readStringArg,
  type Tool,
  toolErrorMessage,
  toolStepSummary,
  toToolDef,
} from './tool.js';

/** A minimal tool stub; `stepSummary` is overridden per test where needed. */
function stubTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'demo',
    description: 'A demo tool.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    effectful: false,
    async run(): Promise<ToolResult> {
      return { name: 'demo', content: 'ok' };
    },
    ...overrides,
  };
}

describe('toolStepSummary', () => {
  it("uses the tool's own stepSummary when provided", () => {
    const tool = stubTool({ stepSummary: (args) => `Read ${String(args.url)}` });
    expect(toolStepSummary(tool, { url: 'https://x.dev' })).toBe('Read https://x.dev');
  });

  it('falls back to a generic line when stepSummary is omitted', () => {
    expect(toolStepSummary(stubTool(), {})).toBe('Used demo.');
  });
});

describe('toToolDef', () => {
  it('projects a tool to the wire shape (name, description, parameters)', () => {
    const params = { type: 'object', properties: { url: { type: 'string' } } };
    const tool = stubTool({ name: 'web_fetch', description: 'Fetch a page.', parameters: params });
    expect(toToolDef(tool)).toEqual({
      name: 'web_fetch',
      description: 'Fetch a page.',
      parameters: params,
    });
  });
});

describe('toolErrorMessage', () => {
  it('returns the message of a thrown Error', () => {
    expect(toolErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns a generic message for a non-Error value', () => {
    expect(toolErrorMessage('just a string')).toBe('unexpected error');
    expect(toolErrorMessage(undefined)).toBe('unexpected error');
  });
});

describe('readStringArg', () => {
  it('returns a non-empty string value', () => {
    expect(readStringArg({ title: 'A Post' }, 'title')).toBe('A Post');
  });

  it('returns null for a missing key', () => {
    expect(readStringArg({}, 'title')).toBeNull();
  });

  it('returns null for a blank/whitespace-only value', () => {
    expect(readStringArg({ title: '   ' }, 'title')).toBeNull();
  });

  it('returns null for a non-string value', () => {
    expect(readStringArg({ title: 42 }, 'title')).toBeNull();
  });
});

describe('readHttpUrlArg', () => {
  it('returns a valid absolute http(s) URL', () => {
    expect(readHttpUrlArg({ url: 'https://x.dev/post' }, 'url')).toBe('https://x.dev/post');
    expect(readHttpUrlArg({ url: 'http://x.dev' }, 'url')).toBe('http://x.dev');
  });

  it('returns null for a missing or blank value', () => {
    expect(readHttpUrlArg({}, 'url')).toBeNull();
    expect(readHttpUrlArg({ url: '  ' }, 'url')).toBeNull();
  });

  it('returns null for a non-string value', () => {
    expect(readHttpUrlArg({ url: 123 }, 'url')).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(readHttpUrlArg({ url: 'not-a-url' }, 'url')).toBeNull();
  });

  it('returns null for a non-http(s) scheme', () => {
    expect(readHttpUrlArg({ url: 'ftp://x.dev/file' }, 'url')).toBeNull();
    expect(readHttpUrlArg({ url: 'mailto:x@y.dev' }, 'url')).toBeNull();
  });
});
