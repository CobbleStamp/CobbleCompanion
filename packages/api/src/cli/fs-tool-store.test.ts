/**
 * FileSystemCliToolStore tests: enumerates valid tool folders; skips a folder that
 * is missing a file or has invalid JSON (never crashing the scan); ignores files
 * and unsafe folder names; `get` returns a fresh def, rejects a path-traversal ref,
 * and returns null for a missing tool; an unreadable root propagates (so the
 * catalog builder keeps stale rows rather than pruning everything).
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSystemCliToolStore } from './fs-tool-store.js';

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined };

const toolJson = (binary: string): string =>
  JSON.stringify({
    binary,
    description: `Run ${binary}.`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    argv: ['--version'],
    limits: { timeoutMs: 10_000, maxOutputBytes: 65_536 },
  });

async function writeTool(root: string, ref: string, json: string, md = 'usage'): Promise<void> {
  const dir = join(root, ref);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'TOOL.json'), json, 'utf8');
  if (md !== null) {
    await writeFile(join(dir, 'TOOL.md'), md, 'utf8');
  }
}

describe('FileSystemCliToolStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fs-tool-store-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('enumerates valid tool folders and skips invalid ones', async () => {
    await writeTool(root, 'good', toolJson('echo'));
    await writeTool(root, 'badjson', '{not json');
    // A folder missing TOOL.md is invalid → skipped.
    const partial = join(root, 'partial');
    await mkdir(partial, { recursive: true });
    await writeFile(join(partial, 'TOOL.json'), toolJson('cat'), 'utf8');
    // A stray file (not a directory) is ignored.
    await writeFile(join(root, 'stray.txt'), 'ignore me', 'utf8');

    const store = new FileSystemCliToolStore(root, silentLogger);
    const refs = (await store.list()).map((def) => def.ref);
    expect(refs).toEqual(['good']);
  });

  it('get returns a fresh definition by ref', async () => {
    await writeTool(root, 'jq', toolJson('jq'), '# jq\nProcess JSON.');
    const store = new FileSystemCliToolStore(root, silentLogger);
    const def = await store.get('jq');
    expect(def?.binary).toBe('jq');
    expect(def?.usage).toContain('Process JSON.');
  });

  it('get rejects a path-traversal ref', async () => {
    const store = new FileSystemCliToolStore(root, silentLogger);
    expect(await store.get('../../etc/passwd')).toBeNull();
    expect(await store.get('a/b')).toBeNull();
    expect(await store.get('..')).toBeNull();
  });

  it('get returns null for a missing tool', async () => {
    const store = new FileSystemCliToolStore(root, silentLogger);
    expect(await store.get('nope')).toBeNull();
  });

  it('propagates when the root directory is unreadable', async () => {
    const store = new FileSystemCliToolStore(join(root, 'does-not-exist'), silentLogger);
    await expect(store.list()).rejects.toThrow();
  });
});
