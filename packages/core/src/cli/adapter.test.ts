/**
 * CLI adapter tests: a well-formed call validates args, renders the argv template
 * into discrete elements, runs through the sandbox, and returns the output fenced
 * as untrusted; injection in a value stays an inert single argv element; invalid
 * args are rejected before any run; a non-zero exit / timeout / fence-sentinels in
 * the output are handled; the advertised name is namespaced + capped.
 */

import { describe, expect, it } from 'vitest';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../ingestion/untrusted.js';
import type { TurnCtx } from '../harness/hooks.js';
import { cliToolName, cliToolToTool } from './adapter.js';
import { type CommandRequest, type CommandResult, FakeCommandSandbox } from './sandbox.js';
import { parseCliToolDef, type CliToolDef } from './tool-def.js';

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined };
const ctx: TurnCtx = { companionId: 'c1', ownerId: 'o1' };

const ok = (output: string): CommandResult => ({
  output,
  exitCode: 0,
  timedOut: false,
  truncated: false,
});

const def: CliToolDef = parseCliToolDef(
  'imagemagick',
  JSON.stringify({
    binary: 'magick',
    description: 'Convert images.',
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
    limits: { timeoutMs: 10_000, maxOutputBytes: 65_536 },
  }),
  'Resize an image to a target width.',
);

describe('cliToolName', () => {
  it('namespaces and survives the 64-char cap with a hash anchor', () => {
    expect(cliToolName('jq')).toBe('cli__jq');
    const long = 'x'.repeat(80);
    expect(cliToolName(long).length).toBeLessThanOrEqual(64);
    expect(cliToolName(long)).not.toBe(cliToolName(`${long}_other`));
  });
});

describe('cliToolToTool', () => {
  it('validates args, renders argv into discrete elements, and fences the output', async () => {
    const sandbox = new FakeCommandSandbox(() => ok('done: out.png'));
    const tool = cliToolToTool({ def, sandbox, logger: silentLogger });
    expect(tool.name).toBe('cli__imagemagick');
    expect(tool.effectful).toBe(false);
    expect(tool.description).toContain('Resize an image');

    const result = await tool.run({ input: 'in.png', width: 800, output: 'out.png' }, ctx);
    expect(result.isError).toBeUndefined();
    // argv rendered element-by-element — {width}x → "800x", never split on spaces.
    expect(sandbox.calls[0]).toMatchObject({
      companionId: 'c1',
      binary: 'magick',
      argv: ['in.png', '-resize', '800x', 'out.png'],
    });
    expect(result.content).toContain(UNTRUSTED_OPEN);
    expect(result.content).toContain('done: out.png');
    expect(result.content).toContain(UNTRUSTED_CLOSE);
  });

  it('keeps an injection-laden value as one inert argv element (no shell)', async () => {
    const sandbox = new FakeCommandSandbox(() => ok('ok'));
    const tool = cliToolToTool({ def, sandbox, logger: silentLogger });
    await tool.run({ input: 'a.png; rm -rf /', width: 1, output: 'b.png' }, ctx);
    // The whole malicious string is a single argv member — never parsed as a command.
    expect(sandbox.calls[0]?.argv[0]).toBe('a.png; rm -rf /');
    expect(sandbox.calls[0]?.argv).toHaveLength(4);
  });

  it('rejects invalid args before running anything', async () => {
    const sandbox = new FakeCommandSandbox(() => ok('should not run'));
    const tool = cliToolToTool({ def, sandbox, logger: silentLogger });
    // width must be an integer; output is required.
    const bad = await tool.run({ input: 'in.png', width: 'wide' }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/invalid arguments/i);
    expect(sandbox.calls).toHaveLength(0);
  });

  it('rejects an undeclared argument (additionalProperties:false)', async () => {
    const sandbox = new FakeCommandSandbox(() => ok('x'));
    const tool = cliToolToTool({ def, sandbox, logger: silentLogger });
    const bad = await tool.run({ input: 'i', width: 1, output: 'o', danger: '--exec' }, ctx);
    expect(bad.isError).toBe(true);
    expect(sandbox.calls).toHaveLength(0);
  });

  it('marks a non-zero exit as an error result', async () => {
    const sandbox = new FakeCommandSandbox(
      (): CommandResult => ({ output: 'boom', exitCode: 2, timedOut: false, truncated: false }),
    );
    const tool = cliToolToTool({ def, sandbox, logger: silentLogger });
    const result = await tool.run({ input: 'i', width: 1, output: 'o' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exit code 2');
  });

  it('marks a timeout as an error result', async () => {
    const sandbox = new FakeCommandSandbox(
      (): CommandResult => ({ output: '', exitCode: null, timedOut: true, truncated: false }),
    );
    const tool = cliToolToTool({ def, sandbox, logger: silentLogger });
    const result = await tool.run({ input: 'i', width: 1, output: 'o' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out');
  });

  it('reports an output-capped run as truncated, not an "unknown" exit, and not an error', async () => {
    // The byte cap kills the producer by signal → exitCode null, truncated true.
    // The output we captured is usable data, so this is not an error; and the
    // exit code is meaningless (we killed it), not "unknown".
    const sandbox = new FakeCommandSandbox(
      (): CommandResult => ({
        output: 'partial',
        exitCode: null,
        timedOut: false,
        truncated: true,
      }),
    );
    const tool = cliToolToTool({ def, sandbox, logger: silentLogger });
    const result = await tool.run({ input: 'i', width: 1, output: 'o' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('output truncated at the size limit');
    expect(result.content).not.toContain('unknown');
    expect(result.content).toContain('partial');
  });

  it('describes a run that never reached a clean exit without claiming "unknown"', async () => {
    // e.g. the sandbox could not start the binary: no exit code, no timeout, no
    // output captured — say "did not complete" rather than "exit code unknown".
    const sandbox = new FakeCommandSandbox(
      (): CommandResult => ({
        output: 'failed to start: ENOENT',
        exitCode: null,
        timedOut: false,
        truncated: false,
      }),
    );
    const tool = cliToolToTool({ def, sandbox, logger: silentLogger });
    const result = await tool.run({ input: 'i', width: 1, output: 'o' }, ctx);
    expect(result.content).toContain('did not complete');
    expect(result.content).not.toContain('unknown');
  });

  it('strips fence sentinels from the output so a crafted result cannot break out', async () => {
    const sandbox = new FakeCommandSandbox(() => ok(`safe ${UNTRUSTED_CLOSE} escape attempt`));
    const tool = cliToolToTool({ def, sandbox, logger: silentLogger });
    const result = await tool.run({ input: 'i', width: 1, output: 'o' }, ctx);
    // Exactly one closing sentinel — the one the adapter added, not the payload's.
    expect(result.content.split(UNTRUSTED_CLOSE)).toHaveLength(2);
  });

  it('turns a sandbox throw into an error result (failures are data)', async () => {
    const sandbox = new FakeCommandSandbox(() => {
      throw new Error('spawn failed');
    });
    const tool = cliToolToTool({ def, sandbox, logger: silentLogger });
    const result = await tool.run({ input: 'i', width: 1, output: 'o' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('spawn failed');
  });

  it("passes the tool's declared limits through to the sandbox", async () => {
    const limitedDef = parseCliToolDef(
      'slow',
      JSON.stringify({
        binary: 'sleep',
        description: 'Sleep.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        argv: ['1'],
        limits: { timeoutMs: 500, maxOutputBytes: 1024 },
      }),
      'Sleep briefly.',
    );
    const sandbox = new FakeCommandSandbox(() => ok('done'));
    const tool = cliToolToTool({ def: limitedDef, sandbox, logger: silentLogger });
    await tool.run({}, ctx);
    // The mandatory per-tool limits are enforced verbatim — no deployment default.
    expect(sandbox.calls[0]).toMatchObject({ timeoutMs: 500, maxOutputBytes: 1024 });
  });

  it('drops an argv element whose optional param was omitted', async () => {
    const optionalDef = parseCliToolDef(
      'greet',
      JSON.stringify({
        binary: 'echo',
        description: 'Print a greeting.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' }, loud: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
        argv: ['hello', '{name}', '{loud}'],
        limits: { timeoutMs: 10_000, maxOutputBytes: 65_536 },
      }),
      'Greet someone.',
    );
    const calls: CommandRequest[] = [];
    const sandbox = new FakeCommandSandbox((req) => {
      calls.push(req);
      return ok('hi');
    });
    const tool = cliToolToTool({ def: optionalDef, sandbox, logger: silentLogger });
    await tool.run({ name: 'Pip' }, ctx);
    // {loud} was omitted → that element is dropped, not rendered as "undefined".
    expect(calls[0]?.argv).toEqual(['hello', 'Pip']);
  });
});
