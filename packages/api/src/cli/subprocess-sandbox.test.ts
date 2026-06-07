/**
 * SubprocessSandbox tests against a real, always-present binary (the running
 * `node` executable) — the one place we exercise an actual process rather than the
 * fake. Proves: argv reaches the child verbatim (no shell), output is captured,
 * the byte cap truncates + kills a runaway producer, the wall-clock timeout kills
 * a hung process, and a missing binary is a failed result (not a throw). Skipped
 * where a usable node executable path isn't available.
 */

import { access } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { createSubprocessSandbox } from './subprocess-sandbox.js';

const NODE = process.execPath;
const run = createSubprocessSandbox({
  logger: { error: () => {}, warn: () => {}, info: () => {} },
});
const base = { companionId: 'c1', timeoutMs: 5_000, maxOutputBytes: 64 * 1024 };

describe.skipIf(!NODE)('createSubprocessSandbox', () => {
  it('captures output and passes argv verbatim (no shell)', async () => {
    const result = await run.run({
      ...base,
      binary: NODE,
      // A shell would treat `;` specially; spawn(shell:false) passes it as one arg.
      argv: ['-e', 'process.stdout.write(process.argv.slice(1).join("|"))', 'a;b', 'c d'],
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.output).toBe('a;b|c d');
  });

  it('truncates output at the byte cap and stops the producer', async () => {
    const result = await run.run({
      ...base,
      maxOutputBytes: 100,
      binary: NODE,
      argv: ['-e', 'setInterval(() => process.stdout.write("x".repeat(1000)), 1)'],
    });
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(100);
  });

  it('kills a process that exceeds the wall-clock timeout', async () => {
    const result = await run.run({
      ...base,
      timeoutMs: 150,
      binary: NODE,
      argv: ['-e', 'setTimeout(() => {}, 60_000)'],
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('returns a failed result when the binary does not exist (no throw)', async () => {
    const result = await run.run({
      ...base,
      binary: '/nonexistent/definitely-not-a-real-binary-xyz',
      argv: [],
    });
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain('failed to start');
  });

  it('scrubs the environment — an ambient secret never reaches the child', async () => {
    // Set a secret in the parent; an unscrubbed spawn would inherit it.
    process.env['CLI_SANDBOX_SECRET_TEST'] = 's3cr3t-should-not-leak';
    try {
      const result = await run.run({
        ...base,
        binary: NODE,
        argv: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      });
      const childEnv = JSON.parse(result.output) as Record<string, string>;
      expect(childEnv['CLI_SANDBOX_SECRET_TEST']).toBeUndefined();
      // Only the deliberate allowlist (PATH to resolve the binary, a fixed LANG).
      expect(childEnv['PATH']).toBeTruthy();
      expect(childEnv['LANG']).toBe('C.UTF-8');
    } finally {
      delete process.env['CLI_SANDBOX_SECRET_TEST'];
    }
  });

  it('runs in an ephemeral per-tenant working dir that is removed after the run', async () => {
    const result = await run.run({
      ...base,
      binary: NODE,
      argv: ['-e', 'process.stdout.write(process.cwd())'],
    });
    const childCwd = result.output;
    // A fresh dir namespaced by the tenant id — never the caller's own cwd.
    expect(childCwd).toContain('cli-c1-');
    expect(childCwd).not.toBe(process.cwd());
    // The `finally` cleanup removed it by the time the run resolved.
    await expect(access(childCwd)).rejects.toThrow();
  });
});
