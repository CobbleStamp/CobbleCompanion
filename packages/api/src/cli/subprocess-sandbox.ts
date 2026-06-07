/**
 * The production {@link CommandSandbox} (companion-tools.md §7) — runs a
 * whitelisted binary in a real subprocess, the CLI counterpart of the
 * StreamableHttp MCP gateway (the SDK-backed transport lives in api, not core).
 *
 * Isolation posture (the portable PoC tier; OS-level namespaces/containers are a
 * Phase 8 hardening item behind this same seam):
 *  - **No shell.** `spawn(binary, argv, { shell: false })` — argv elements reach
 *    the process verbatim, so a crafted argument can never be a command.
 *  - **Scrubbed environment.** Only a minimal allowlisted env is passed; no
 *    secrets or ambient config leak into the child.
 *  - **Per-tenant ephemeral working directory** under a scratch root, created
 *    before the run and removed after — never the read-only tool-definition dir.
 *  - **Ceilings.** A wall-clock timeout kills the process; output is captured up
 *    to a byte cap, then the process is killed and the result marked truncated.
 *
 * Not enforced by this tier: network isolation (a Phase 8 concern). The narrow
 * whitelist + fixed binary are the mitigation. A failed run is data, not a throw.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandRequest, CommandResult, CommandSandbox, Logger } from '@cobble/core';
import { consoleLogger } from '@cobble/core';

/** Env passed to every child — deliberately minimal; no secrets, no ambient config. */
function scrubbedEnv(): Record<string, string> {
  // PATH is needed to resolve a bare binary name; nothing else is forwarded.
  return { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C.UTF-8' };
}

export interface SubprocessSandboxOptions {
  /** Root for per-tenant ephemeral working dirs; empty → the OS temp dir. */
  readonly scratchDir?: string;
  readonly logger?: Logger;
}

/** Build the production subprocess sandbox. */
export function createSubprocessSandbox(options: SubprocessSandboxOptions = {}): CommandSandbox {
  const logger = options.logger ?? consoleLogger;
  const scratchRoot =
    options.scratchDir && options.scratchDir.length > 0 ? options.scratchDir : tmpdir();

  return {
    async run(request: CommandRequest): Promise<CommandResult> {
      // A fresh per-run working dir, namespaced by tenant; removed in `finally`.
      const cwd = await mkdtemp(join(scratchRoot, `cli-${sanitize(request.companionId)}-`));
      try {
        return await spawnCapped(request, cwd, logger);
      } finally {
        await rm(cwd, { recursive: true, force: true }).catch((error: unknown) =>
          logger.error('failed to clean up CLI working dir', {
            operation: 'cli.subprocessSandbox.cleanup',
            cwd,
            error,
          }),
        );
      }
    },
  };
}

/** Spawn the process, enforce the output-byte + wall-clock ceilings, capture combined output. */
function spawnCapped(request: CommandRequest, cwd: string, logger: Logger): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(request.binary, [...request.argv], {
      cwd,
      env: scrubbedEnv(),
      shell: false, // never interpret a shell line — argv is passed verbatim
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    let captured = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, request.timeoutMs);

    const capture = (chunk: Buffer): void => {
      if (captured >= request.maxOutputBytes) {
        return;
      }
      const remaining = request.maxOutputBytes - captured;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        captured = request.maxOutputBytes;
        truncated = true;
        child.kill('SIGKILL'); // stop a runaway producer once we have enough
      } else {
        chunks.push(chunk);
        captured += chunk.length;
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        output: Buffer.concat(chunks).toString('utf8'),
        exitCode: timedOut ? null : exitCode,
        timedOut,
        truncated,
      });
    };

    child.on('error', (error) => {
      // Spawn failure (e.g. binary not found) — surface as a failed run, not a throw.
      logger.error('CLI subprocess failed to start', {
        operation: 'cli.subprocessSandbox.spawn',
        binary: request.binary,
        error,
      });
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        output: `failed to start: ${(error as Error).message}`,
        exitCode: null,
        timedOut,
        truncated,
      });
    });
    child.on('close', (code) => finish(code));
  });
}

/** Keep a tenant id safe as a path segment (defense-in-depth; ids are uuids). */
function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, '_');
}
