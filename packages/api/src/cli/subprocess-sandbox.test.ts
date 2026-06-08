/**
 * SubprocessSandbox tests against a real, always-present binary (the running
 * `node` executable) — the one place we exercise an actual process rather than the
 * fake. Proves: argv reaches the child verbatim (no shell), output is captured,
 * the byte cap truncates + kills a runaway producer, the wall-clock timeout kills
 * a hung process, and a missing binary is a failed result (not a throw). Skipped
 * where a usable node executable path isn't available.
 */

import { readFileSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { createSubprocessSandbox } from './subprocess-sandbox.js';

/** True while `pid` is still a live process; false once it's reaped (ESRCH). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, no actual signal sent
    return true;
  } catch {
    return false;
  }
}

/** Poll until `predicate` holds or the deadline passes. */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

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

  it('reaps the whole process tree on timeout — a forked child does not survive', async () => {
    // The "binary" forks a long-lived grandchild (the failure mode the bare
    // `child.kill()` would miss), records its pid, then hangs. The ceiling fire
    // must kill the group, not just the immediate child.
    const pidFile = join(tmpdir(), `cli-sandbox-grandchild-${process.pid}-${Date.now()}.pid`);
    const grandchild =
      'require("fs").writeFileSync(process.argv[1], String(process.pid));' +
      'setTimeout(() => {}, 60_000)';
    const parent =
      'const cp = require("child_process");' +
      // Forked WITHOUT detached → grandchild stays in the parent's group.
      `cp.spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}, process.argv[1]], { stdio: "ignore" });` +
      'setTimeout(() => {}, 60_000)';

    const result = await run.run({
      ...base,
      timeoutMs: 800,
      binary: NODE,
      argv: ['-e', parent, pidFile],
    });
    expect(result.timedOut).toBe(true);

    // The grandchild wrote its pid before the parent was killed.
    const wrote = await waitUntil(() => {
      try {
        return readFileSync(pidFile).length > 0;
      } catch {
        return false;
      }
    }, 1_000);
    expect(wrote).toBe(true);
    const grandchildPid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);

    // With the group kill, the grandchild is reaped too — not orphaned.
    const reaped = await waitUntil(() => !isAlive(grandchildPid), 2_000);
    expect(reaped).toBe(true);
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
