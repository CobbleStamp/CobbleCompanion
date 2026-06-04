/** The tool registry: list (advertised defs), get-by-name, size. */

import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../harness/hooks.js';
import { ToolRegistry } from './registry.js';
import type { Tool } from './tool.js';

function stubTool(name: string, effectful = false): Tool {
  return {
    name,
    description: `the ${name} tool`,
    parameters: { type: 'object', properties: {} },
    effectful,
    async run(): Promise<{ name: string; content: string }> {
      return { name, content: 'ok' };
    },
  };
}

const ctx: TurnCtx = { companionId: 'c1', ownerId: 'u1' };

describe('ToolRegistry', () => {
  it('advertises each tool as a ToolDef (name/description/parameters)', () => {
    const registry = new ToolRegistry([stubTool('web_fetch'), stubTool('ingest_source', true)]);
    expect(registry.list()).toEqual([
      {
        name: 'web_fetch',
        description: 'the web_fetch tool',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'ingest_source',
        description: 'the ingest_source tool',
        parameters: { type: 'object', properties: {} },
      },
    ]);
    expect(registry.size).toBe(2);
  });

  it('looks a tool up by name and returns undefined for an unknown one', async () => {
    const registry = new ToolRegistry([stubTool('web_fetch')]);
    const tool = registry.get('web_fetch');
    expect(tool).toBeDefined();
    expect(await tool!.run({}, ctx)).toEqual({ name: 'web_fetch', content: 'ok' });
    expect(registry.get('nope')).toBeUndefined();
  });

  it('an empty registry advertises nothing (the Phase 0 path)', () => {
    const registry = new ToolRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.size).toBe(0);
  });
});
