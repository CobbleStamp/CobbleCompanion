/**
 * `/notifybot` — configure the mission-wake trigger from Discord (companion-missions.md
 * §3.2, companion-tools.md §9): the notification bot's Discord user id + the channel its
 * wakes land in. This is the same `(trigger_bot_id, mission_channel_id)` pair the web
 * settings panel writes via the `discord.config.setMissionWake` WS method — offered here
 * so a Discord-only deployment (no web client) can set it too.
 *
 * It is owner-gated upstream (the router's owner lock runs before this) and needs no
 * embodiment — it writes config and refreshes the live bot's trust snapshot in place,
 * mirroring the WS method's `configureMissionWake` + reconcile. It depends only on the
 * `@cobble/db` config store and a reconcile callback (wired to the gateway manager) —
 * nothing from `@cobble/core`.
 */

import type { DiscordConfigStore } from '@cobble/db';
import type { SlashCommandContext } from './gateway/manager.js';
import type { Logger } from './gateway/types.js';

const NOT_CONFIGURED =
  'I’m not set up here yet — add a bot token in your CobbleCompanion settings first.';
const GENERIC_ERROR = 'Something went wrong saving that — give me a moment and try again.';
const USAGE =
  'Give me the notification bot and channel: `/notifybot bot:<bot id or @mention> ' +
  'channel:<channel id or #mention>`.';

/** A Discord snowflake: a 17–20 digit id. */
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Accept a raw snowflake OR a Discord mention wrapper — `<@id>`, `<@!id>`, `<@&id>`,
 * `<#id>` — and return the bare id, or null if it isn't a snowflake. Lets the owner paste
 * either the id or the mention Discord renders.
 */
export function normalizeSnowflake(raw: string): string | null {
  const unwrapped = raw
    .trim()
    .replace(/^<[@#][!&]?/, '')
    .replace(/>$/, '');
  return SNOWFLAKE.test(unwrapped) ? unwrapped : null;
}

/**
 * Set the `(triggerBotId, missionChannelId)` mission-wake pair for the owner, then refresh
 * the running bot's trust snapshot so the guild-trigger gate honours it without a restart.
 * The refresh is best-effort: the config is already persisted and the startup reconcile is
 * the floor, so a refresh hiccup only delays pickup — it never loses the setting.
 */
export async function handleNotifyBotCommand(
  ctx: SlashCommandContext,
  configStore: DiscordConfigStore,
  reconcile: (userId: string) => Promise<void>,
  logger: Logger,
): Promise<void> {
  const botId = normalizeSnowflake(ctx.command.options['bot'] ?? '');
  const channelId = normalizeSnowflake(ctx.command.options['channel'] ?? '');
  if (botId === null || channelId === null) {
    await ctx.reply(USAGE);
    return;
  }

  let record;
  try {
    record = await configStore.configureMissionWake(ctx.userId, botId, channelId);
  } catch (error) {
    logger.error('discord notifybot config write failed', {
      operation: 'discord.command.notifybot',
      userId: ctx.userId,
      error,
    });
    await ctx.reply(GENERIC_ERROR);
    return;
  }
  if (!record) {
    await ctx.reply(NOT_CONFIGURED);
    return;
  }

  try {
    await reconcile(ctx.userId);
  } catch (error) {
    // The pair is saved; only the live in-memory snapshot refresh failed. Log it — the next
    // reconcile / restart picks it up — but still confirm to the owner that it's set.
    logger.error('discord notifybot reconcile failed after config write', {
      operation: 'discord.command.notifybot',
      userId: ctx.userId,
      error,
    });
  }

  await ctx.reply(`Set. I’ll accept mission alerts from <@${botId}> in <#${channelId}>. ✅`);
}
