import { describe, expect, it } from 'vitest';
import { FakeCommandSandbox, type CommandRequest, type CommandResult } from '../cli/sandbox.js';
import { createSchedulerCliScheduler, serializeAction } from './scheduler-cli-scheduler.js';

const ok = (output: string): CommandResult => ({
  output,
  exitCode: 0,
  timedOut: false,
  truncated: false,
});

describe('serializeAction', () => {
  it('quotes only the multi-word element (the --text value), leaving flags bare', () => {
    expect(
      serializeAction(['discord-notify', '--channel', '12345', '--text', '<@bot-42> {{message}}']),
    ).toBe('discord-notify --channel 12345 --text "<@bot-42> {{message}}"');
  });

  it('rejects an element containing a double quote (would corrupt tokenization)', () => {
    expect(() => serializeAction(['--text', 'say "hi"'])).toThrow(/double quote/);
  });
});

describe('createSchedulerCliScheduler', () => {
  const spec = {
    predicate: 'ibkr-cli query LITE le 810',
    cadence: { every: '1s' },
    action: ['discord-notify', '--channel', 'ch', '--text', '<@bot> {{message}}'],
  };

  it('arms a job: shells `schedule run` with the base url and returns the parsed id', async () => {
    let seen: CommandRequest | undefined;
    const sandbox = new FakeCommandSandbox((req) => {
      seen = req;
      return ok(JSON.stringify({ id: 'job_abc', first_evaluation: '2026-07-02T00:00:00Z' }));
    });
    const scheduler = createSchedulerCliScheduler({ sandbox, baseUrl: 'http://127.0.0.1:9999' });

    const id = await scheduler.arm(spec);

    expect(id).toBe('job_abc');
    expect(seen?.binary).toBe('schedule');
    expect(seen?.argv).toEqual([
      'run',
      '--every',
      '1s',
      '--predicate',
      'ibkr-cli query LITE le 810',
      '--action',
      'discord-notify --channel ch --text "<@bot> {{message}}"',
      '--base-url',
      'http://127.0.0.1:9999',
    ]);
  });

  it('arms a cron-cadence job with --cron/--tz instead of --every (first_evaluation null)', async () => {
    let seen: CommandRequest | undefined;
    const sandbox = new FakeCommandSandbox((req) => {
      seen = req;
      return ok(
        JSON.stringify({
          id: 'job_cron',
          first_evaluation: null,
          next_run_at: '2026-07-08T06:30:00Z',
        }),
      );
    });
    const scheduler = createSchedulerCliScheduler({ sandbox });

    const id = await scheduler.arm({
      ...spec,
      cadence: { cron: '30 7 * * 1-5', tz: 'Europe/London' },
    });

    expect(id).toBe('job_cron');
    expect(seen?.argv.slice(0, 5)).toEqual([
      'run',
      '--cron',
      '30 7 * * 1-5',
      '--tz',
      'Europe/London',
    ]);
    expect(seen?.argv).not.toContain('--every');
  });

  it('defaults to the loopback base url', async () => {
    let seen: CommandRequest | undefined;
    const sandbox = new FakeCommandSandbox((req) => {
      seen = req;
      return ok(JSON.stringify({ id: 'j' }));
    });
    await createSchedulerCliScheduler({ sandbox }).arm(spec);
    expect(seen?.argv).toContain('http://127.0.0.1:8787');
  });

  it('throws with the scheduler error message on a non-zero exit', async () => {
    const sandbox = new FakeCommandSandbox(() => ({
      output: JSON.stringify({ category: 'usage', message: 'unbalanced quote' }),
      exitCode: 2,
      timedOut: false,
      truncated: false,
    }));
    await expect(createSchedulerCliScheduler({ sandbox }).arm(spec)).rejects.toThrow(
      /unbalanced quote/,
    );
  });

  it('throws when the run output carries no job id', async () => {
    const sandbox = new FakeCommandSandbox(() => ok('{}'));
    await expect(createSchedulerCliScheduler({ sandbox }).arm(spec)).rejects.toThrow(/no job id/);
  });

  it('throws on a timed-out run', async () => {
    const sandbox = new FakeCommandSandbox(() => ({
      output: '',
      exitCode: null,
      timedOut: true,
      truncated: false,
    }));
    await expect(createSchedulerCliScheduler({ sandbox }).arm(spec)).rejects.toThrow(
      /scheduler run failed/,
    );
  });

  it('cancels a job: shells `schedule cancel <id>` (204, no stdout)', async () => {
    let seen: CommandRequest | undefined;
    const sandbox = new FakeCommandSandbox((req) => {
      seen = req;
      return ok('');
    });
    await createSchedulerCliScheduler({ sandbox, baseUrl: 'http://x' }).cancel('job_abc');
    expect(seen?.argv).toEqual(['cancel', 'job_abc', '--base-url', 'http://x']);
  });

  it('cancel is idempotent: a `not_found` result resolves (the job is already gone)', async () => {
    const sandbox = new FakeCommandSandbox(() => ({
      output: JSON.stringify({ category: 'not_found', message: 'no job with that id' }),
      exitCode: 5,
      timedOut: false,
      truncated: false,
    }));
    await expect(createSchedulerCliScheduler({ sandbox }).cancel('gone')).resolves.toBeUndefined();
  });

  it('throws when a cancel fails for any reason other than not_found', async () => {
    const sandbox = new FakeCommandSandbox(() => ({
      output: JSON.stringify({ category: 'unavailable', message: 'scheduler is down' }),
      exitCode: 3,
      timedOut: false,
      truncated: false,
    }));
    await expect(createSchedulerCliScheduler({ sandbox }).cancel('job_abc')).rejects.toThrow(
      /scheduler is down/,
    );
  });
});
