/**
 * The Discord settings panel (companion-discord.md §9, T13): attach a bring-your-own
 * bot token, pick the companion it embodies, and get the single-use `/link` code to
 * claim the bot in Discord. The token is sent over the WS to the API, which encrypts
 * it at rest (`discord.config.set`); it is never read back. The decoupled worker picks
 * up the saved row on its next poll and brings the bot online.
 */

import type { CompanionDto, DiscordConfigViewDto } from '@cobble/shared';
import { useEffect, useState } from 'react';
import {
  deleteDiscordConfig,
  getDiscordConfig,
  listCompanions,
  regenerateDiscordLink,
  saveDiscordConfig,
  saveDiscordMissionWake,
} from '../api/client.js';

interface DiscordPageProps {
  readonly companionName: string;
  readonly companionId: string;
  readonly onBack: () => void;
}

export function Discord({ companionName, companionId, onBack }: DiscordPageProps): JSX.Element {
  const [config, setConfig] = useState<DiscordConfigViewDto | null>(null);
  const [companions, setCompanions] = useState<readonly CompanionDto[]>([]);
  const [botToken, setBotToken] = useState<string>('');
  const [boundCompanionId, setBoundCompanionId] = useState<string>(companionId);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    void (async () => {
      try {
        const [current, list] = await Promise.all([getDiscordConfig(), listCompanions()]);
        setConfig(current);
        setCompanions(list);
        if (current.boundCompanionId) setBoundCompanionId(current.boundCompanionId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load Discord settings');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function run(action: () => Promise<DiscordConfigViewDto | null>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) setConfig(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function onSave(): Promise<void> {
    if (botToken.trim().length === 0) {
      setError('Paste your bot token first.');
      return;
    }
    await run(async () => {
      const next = await saveDiscordConfig(botToken.trim(), boundCompanionId);
      setBotToken(''); // never keep the secret in component state after a save
      return next;
    });
  }

  async function onDisconnect(): Promise<void> {
    await run(async () => {
      await deleteDiscordConfig();
      return { configured: false, boundCompanionId: null, ownerLinked: false, linkCode: null };
    });
  }

  return (
    <main className="chat">
      <header>
        <h1>{companionName} · Discord</h1>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </header>

      {error && <p className="error">{error}</p>}
      {loading && !error && <p>Loading…</p>}

      {!loading && config && (
        <div className="memory-sections">
          <StatusSection config={config} />

          <section className="memory-section">
            <h2>{config.configured ? 'Update your bot' : 'Connect a Discord bot'}</h2>
            <p className="who">
              Paste a bot token from the{' '}
              <a
                href="https://discord.com/developers/applications"
                target="_blank"
                rel="noreferrer noopener"
              >
                Discord Developer Portal
              </a>
              . It’s encrypted before it’s stored, and never shown again.
            </p>
            <label htmlFor="bot-token">Bot token</label>
            <input
              id="bot-token"
              type="password"
              autoComplete="off"
              value={botToken}
              disabled={busy}
              placeholder={config.configured ? '•••••• (saved — paste to replace)' : 'Bot token'}
              onChange={(e) => setBotToken(e.target.value)}
            />
            <label htmlFor="bound-companion">Companion to embody</label>
            <select
              id="bound-companion"
              value={boundCompanionId}
              disabled={busy}
              onChange={(e) => setBoundCompanionId(e.target.value)}
            >
              {companions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button type="button" disabled={busy} onClick={() => void onSave()}>
              {config.configured ? 'Save changes' : 'Connect bot'}
            </button>
          </section>

          {config.configured && <MissionWakeSection config={config} busy={busy} run={run} />}

          {config.configured && (
            <LinkSection config={config} busy={busy} run={run} onDisconnect={onDisconnect} />
          )}
        </div>
      )}
    </main>
  );
}

/** Current connection status — configured? owner linked? */
function StatusSection({ config }: { config: DiscordConfigViewDto }): JSX.Element {
  if (!config.configured) {
    return (
      <section className="memory-section">
        <p className="who">
          No bot connected yet. Add one below to chat with your companion in a Discord DM.
        </p>
      </section>
    );
  }
  return (
    <section className="memory-section">
      <p className="who">
        {config.ownerLinked
          ? '✓ Bot connected and linked to your Discord account. DM it and run /summon.'
          : '⚠ Bot connected, but not yet linked — run the /link command below in a DM with your bot.'}
      </p>
    </section>
  );
}

/**
 * The mission wake (companion-missions.md §3.2): the owner sets the allowlisted trigger-sender
 * bot id (the scheduler's discord-notify bot) and the shared mission channel id. Both, plus the
 * companion bot's own id (captured automatically on connect), must be set before a mission can
 * be armed. Trust is the (author, channel) pair, never message content.
 */
function MissionWakeSection({
  config,
  busy,
  run,
}: {
  config: DiscordConfigViewDto;
  busy: boolean;
  run: (action: () => Promise<DiscordConfigViewDto | null>) => Promise<void>;
}): JSX.Element {
  const wake = config.missionWake;
  const [triggerBotId, setTriggerBotId] = useState<string>(wake?.triggerBotId ?? '');
  const [missionChannelId, setMissionChannelId] = useState<string>(wake?.missionChannelId ?? '');

  // Reflect a saved config (or a refresh) back into the inputs.
  useEffect(() => {
    setTriggerBotId(wake?.triggerBotId ?? '');
    setMissionChannelId(wake?.missionChannelId ?? '');
  }, [wake?.triggerBotId, wake?.missionChannelId]);

  const digits = /^\d+$/u;
  const valid = digits.test(triggerBotId.trim()) && digits.test(missionChannelId.trim());
  const configured =
    (wake?.triggerBotId ?? null) !== null && (wake?.missionChannelId ?? null) !== null;

  return (
    <section className="memory-section">
      <h2>Missions</h2>
      <p className="who">
        Let a scheduler wake your companion for long-running missions. Enter the Discord user id of
        the bot that posts triggers and the id of the shared mission channel both bots are in.
        {configured
          ? wake?.botUserIdCaptured
            ? ' ✓ Ready to run missions.'
            : ' ⚠ Waiting for your bot to connect once so its own id can be captured.'
          : ' Not configured yet.'}
      </p>
      <label htmlFor="trigger-bot-id">Trigger bot user id</label>
      <input
        id="trigger-bot-id"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={triggerBotId}
        disabled={busy}
        placeholder="e.g. 1473000000000000000"
        onChange={(e) => setTriggerBotId(e.target.value)}
      />
      <label htmlFor="mission-channel-id">Mission channel id</label>
      <input
        id="mission-channel-id"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={missionChannelId}
        disabled={busy}
        placeholder="e.g. 1472000000000000000"
        onChange={(e) => setMissionChannelId(e.target.value)}
      />
      <button
        type="button"
        disabled={busy || !valid}
        onClick={() =>
          void run(() => saveDiscordMissionWake(triggerBotId.trim(), missionChannelId.trim()))
        }
      >
        Save mission wake
      </button>
    </section>
  );
}

/** The /link code + regenerate, and the disconnect action. */
function LinkSection({
  config,
  busy,
  run,
  onDisconnect,
}: {
  config: DiscordConfigViewDto;
  busy: boolean;
  run: (action: () => Promise<DiscordConfigViewDto | null>) => Promise<void>;
  onDisconnect: () => Promise<void>;
}): JSX.Element {
  return (
    <section className="memory-section">
      <h2>Link your Discord account</h2>
      {config.ownerLinked ? (
        <p className="who">
          Already linked. Re-linking is only needed if you change the token or want a new code.
        </p>
      ) : (
        <p className="who">
          In a DM with your bot, run <code>/link {config.linkCode ?? '────────'}</code>. The code is
          single-use and expires in ~15 minutes.
        </p>
      )}
      <div className="header-actions">
        <button type="button" disabled={busy} onClick={() => void run(regenerateDiscordLink)}>
          Regenerate code
        </button>
        <button type="button" disabled={busy} onClick={() => void onDisconnect()}>
          Disconnect bot
        </button>
      </div>
    </section>
  );
}
