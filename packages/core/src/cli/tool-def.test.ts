/**
 * CLI tool-def parser tests: a well-formed TOOL.json + TOOL.md parse into a
 * CliToolDef; each construction-time guard rejects a malformed definition
 * (bad JSON, missing binary/description, non-object parameters, bad argv, an
 * argv placeholder naming an undeclared parameter, bad limits).
 */

import { describe, expect, it } from 'vitest';
import { parseCliToolDef } from './tool-def.js';

const goodJson = JSON.stringify({
  binary: 'magick',
  description: 'Convert and transform images.',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string' },
      width: { type: 'integer' },
      output: { type: 'string' },
    },
    required: ['input', 'width', 'output'],
    additionalProperties: false,
  },
  argv: ['{input}', '-resize', '{width}x', '{output}'],
  limits: { timeoutMs: 5000, maxOutputBytes: 1024 },
});

describe('parseCliToolDef', () => {
  it('parses a well-formed definition', () => {
    const def = parseCliToolDef('imagemagick', goodJson, '# imagemagick\nResize images.');
    expect(def.ref).toBe('imagemagick');
    expect(def.binary).toBe('magick');
    expect(def.description).toBe('Convert and transform images.');
    expect(def.usage).toContain('Resize images.');
    expect(def.argv).toEqual(['{input}', '-resize', '{width}x', '{output}']);
    expect(def.limits).toEqual({ timeoutMs: 5000, maxOutputBytes: 1024 });
  });

  it('rejects a blank folder name', () => {
    expect(() => parseCliToolDef('  ', goodJson, 'usage')).toThrow(/folder name/);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseCliToolDef('t', '{not json', 'usage')).toThrow(/not valid JSON/);
  });

  it('rejects a missing binary', () => {
    const json = JSON.stringify({ description: 'x', parameters: { type: 'object' }, argv: ['a'] });
    expect(() => parseCliToolDef('t', json, 'usage')).toThrow(/"binary"/);
  });

  it('rejects a blank description', () => {
    const json = JSON.stringify({
      binary: 'b',
      description: '   ',
      parameters: { type: 'object' },
      argv: ['a'],
    });
    expect(() => parseCliToolDef('t', json, 'usage')).toThrow(/"description"/);
  });

  it('rejects non-object parameters', () => {
    const json = JSON.stringify({ binary: 'b', description: 'd', parameters: [], argv: ['a'] });
    expect(() => parseCliToolDef('t', json, 'usage')).toThrow(/"parameters"/);
  });

  it('rejects a non-array argv', () => {
    const json = JSON.stringify({
      binary: 'b',
      description: 'd',
      parameters: { type: 'object' },
      argv: 'a b c',
    });
    expect(() => parseCliToolDef('t', json, 'usage')).toThrow(/"argv"/);
  });

  it('rejects an argv placeholder that names an undeclared parameter', () => {
    const json = JSON.stringify({
      binary: 'b',
      description: 'd',
      parameters: { type: 'object', properties: { a: { type: 'string' } } },
      argv: ['{a}', '{ghost}'],
    });
    expect(() => parseCliToolDef('t', json, 'usage')).toThrow(/undeclared parameter "\{ghost\}"/);
  });

  it('rejects non-positive limits', () => {
    const json = JSON.stringify({
      binary: 'b',
      description: 'd',
      parameters: { type: 'object' },
      argv: ['a'],
      limits: { timeoutMs: 0 },
    });
    expect(() => parseCliToolDef('t', json, 'usage')).toThrow(/limits.timeoutMs/);
  });

  it('omits limits when none are declared', () => {
    const json = JSON.stringify({
      binary: 'b',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      argv: ['--version'],
    });
    expect(parseCliToolDef('t', json, 'usage').limits).toBeUndefined();
  });
});
