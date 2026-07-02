/**
 * The production {@link MissionScheduler} — arms/cancels a mission's wake by shelling the
 * `scheduler-cli` (`schedule`) binary through the {@link CommandSandbox}, the same sandbox the
 * acquired CLI tools run under (companion-tools.md §7). It talks to the loopback scheduler
 * service (Tools/scheduler); the sandbox scrubs the child env down to PATH+LANG, so the base
 * URL is passed explicitly as `--base-url` rather than via `$SCHEDULER_URL`.
 *
 * Contract (verified against Tools/scheduler-cli):
 *  - `schedule run --every <dur> --predicate <str> --action <str>` prints `{ id, first_evaluation }`
 *    JSON on success (exit 0); on failure it prints `{ category, message }` and exits 2–5.
 *  - `--predicate` / `--action` are shell-tokenized (quotes group), and the runner substitutes
 *    `{{message}}` inside each resulting argv element — so the action's `--text` value is kept as
 *    one quoted element (`"<@bot> {{message}}"`) and the mention rides in front of the message.
 *  - `schedule cancel <id>` returns 204 with no stdout (exit 0).
 */

import type { CommandSandbox } from '../cli/sandbox.js';
import type { MissionJobSpec, MissionScheduler } from './start-mission-tool.js';

/** The scheduler is a stateless loopback client — one shared sandbox working dir is fine. */
const SCHEDULER_TENANT = 'mission-scheduler';
/** The scheduler-cli binary (resolved on PATH by the sandbox). */
const SCHEDULE_BINARY = 'schedule';
/** Wall-clock ceiling for a `schedule` invocation (a loopback call — generous but bounded). */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Output cap; the JSON envelopes are tiny, so this only bounds a misbehaving binary. */
const DEFAULT_MAX_OUTPUT_BYTES = 64_000;

export interface SchedulerCliOptions {
  readonly sandbox: CommandSandbox;
  /** Base URL of the loopback scheduler service (default `http://127.0.0.1:8787`). */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

/**
 * Serialize an action argv into the single shell-quoted command string `schedule --action`
 * expects. An element containing whitespace is wrapped in double quotes so scheduler-cli's
 * tokenizer keeps it as ONE argv element (the `--text "<@bot> {{message}}"` case); other
 * elements pass bare. Our elements never contain a double quote (flags, a numeric channel id,
 * `<@id> {{message}}`); a stray one would corrupt tokenization, so it's rejected loudly.
 *
 * Verified against Tools/scheduler-cli (a quote-grouping tokenizer that only splits/unquotes —
 * no glob/var expansion, no subshell) and Tools/scheduler runner.go `substituteMessage`, which
 * does a per-element `strings.ReplaceAll("{{message}}", msg)` — so the mention + placeholder
 * survive as one element and the message lands spliced after the mention.
 */
export function serializeAction(action: readonly string[]): string {
  return action
    .map((element) => {
      if (element.includes('"')) {
        throw new Error(`mission action element cannot contain a double quote: ${element}`);
      }
      return /\s/u.test(element) || element.length === 0 ? `"${element}"` : element;
    })
    .join(' ');
}

/** Build the production scheduler-cli-backed MissionScheduler. */
export function createSchedulerCliScheduler(options: SchedulerCliOptions): MissionScheduler {
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:8787';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const run = (argv: readonly string[]): Promise<{ output: string; ok: boolean }> =>
    options.sandbox
      .run({
        companionId: SCHEDULER_TENANT,
        binary: SCHEDULE_BINARY,
        argv: [...argv, '--base-url', baseUrl],
        timeoutMs,
        maxOutputBytes,
      })
      .then((result) => ({
        output: result.output,
        ok: !result.timedOut && result.exitCode === 0,
      }));

  return {
    async arm(spec: MissionJobSpec): Promise<string> {
      const { output, ok } = await run([
        'run',
        '--every',
        spec.every,
        '--predicate',
        spec.predicate,
        '--action',
        serializeAction(spec.action),
      ]);
      if (!ok) {
        throw new Error(`scheduler run failed: ${schedulerMessage(output)}`);
      }
      const id = parseJobId(output);
      if (id === null) {
        throw new Error(`scheduler run returned no job id: ${output.slice(0, 200)}`);
      }
      return id;
    },

    async cancel(jobId: string): Promise<void> {
      const { output, ok } = await run(['cancel', jobId]);
      if (!ok) {
        throw new Error(`scheduler cancel failed: ${schedulerMessage(output)}`);
      }
    },
  };
}

/** Pull the `id` from `schedule run`'s `{ id, first_evaluation }` JSON, or null if absent. */
function parseJobId(output: string): string | null {
  try {
    const parsed = JSON.parse(output.trim()) as { id?: unknown };
    return typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : null;
  } catch {
    return null;
  }
}

/** Extract scheduler-cli's `{ category, message }` error text, else the raw (capped) output. */
function schedulerMessage(output: string): string {
  try {
    const parsed = JSON.parse(output.trim()) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.length > 0) {
      return parsed.message;
    }
  } catch {
    // not JSON — fall through to the raw output
  }
  return output.trim().slice(0, 200) || 'no output';
}
