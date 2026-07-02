import {
  encryptSecret,
  generateLinkCode,
  keyFromBase64,
  type DiscordConfigRecord,
} from '@cobble/db';
import {
  discordConfigSetSchema,
  discordMissionWakeSchema,
  type DiscordConfigViewDto,
} from '@cobble/shared';
import type { AppDeps } from '../../app.js';
import type { WsMethods } from '../dispatch.js';
import { ConflictError, NotFoundError, parseParams } from './helpers.js';

/**
 * The Discord settings methods (companion-discord.md §9, T13): the web panel saves the
 * user's bot token + bound companion, and the API encrypts the token before storing it
 * in `discord_config` (which the decoupled service reads). USER-scoped — they act on
 * `ctx.userId`, never on an embodied companion, so they carry no `requireEmbodiment`
 * guard.
 *
 * Disabled (every method returns a `conflict` "not configured") unless
 * `DISCORD_TOKEN_KEY` is set — the encryption key the service shares.
 */

const NOT_CONFIGURED = 'Discord is not available on this server.';

/** Project a stored row to the settings view — NEVER exposes the bot token. */
function toView(record: DiscordConfigRecord | null): DiscordConfigViewDto {
  if (!record) {
    return { configured: false, boundCompanionId: null, ownerLinked: false, linkCode: null };
  }
  const ownerLinked = record.ownerDiscordUserId !== null;
  return {
    configured: true,
    boundCompanionId: record.boundCompanionId,
    ownerLinked,
    // Show the code only while it's still actionable (owner not yet linked).
    linkCode: ownerLinked ? null : record.linkCode,
    missionWake: {
      triggerBotId: record.triggerBotId,
      missionChannelId: record.missionChannelId,
      botUserIdCaptured: record.botUserId !== null,
    },
  };
}

export function discordConfigMethods(deps: AppDeps): WsMethods {
  const { discordConfig, identity, config, discordReconcile } = deps;
  const keyBase64 = config.discordTokenKey;

  /** The AES key, or null when Discord isn't configured / the key is malformed. */
  const encryptionKey = (): Buffer | null => {
    if (keyBase64.length === 0) return null;
    try {
      return keyFromBase64(keyBase64);
    } catch {
      return null; // a malformed key degrades to "not configured", never crashes boot.
    }
  };

  return {
    'discord.config.get': async (ctx) => ({
      discord: toView(await discordConfig.findByUserId(ctx.userId)),
    }),

    'discord.config.set': async (ctx, params) => {
      const key = encryptionKey();
      if (!key) throw new ConflictError(NOT_CONFIGURED);
      const { botToken, boundCompanionId } = parseParams(
        discordConfigSetSchema,
        params,
        'a bot token and a companion to bind are required',
      );
      // Authorize the bound companion: it must belong to the caller.
      const companion = await identity.getCompanion(boundCompanionId, ctx.userId);
      if (!companion) throw new NotFoundError('no such companion');
      const record = await discordConfig.upsert({
        userId: ctx.userId,
        encryptedBotToken: encryptSecret(botToken, key),
        boundCompanionId,
        linkCode: generateLinkCode(),
        linkCodeIssuedAt: new Date(),
      });
      // The token may have changed → tell the adapter to (re)start this bot at once
      // (companion-discord.md §2.1). Fire-and-forget: the notifier retries + logs.
      void discordReconcile?.(ctx.userId);
      return { discord: toView(record) };
    },

    'discord.config.regenerateLink': async (ctx) => {
      if (!encryptionKey()) throw new ConflictError(NOT_CONFIGURED);
      const record = await discordConfig.reissueLinkCode(
        ctx.userId,
        generateLinkCode(),
        new Date(),
      );
      if (!record) throw new NotFoundError('no Discord config to relink');
      return { discord: toView(record) };
    },

    'discord.config.setMissionWake': async (ctx, params) => {
      if (!encryptionKey()) throw new ConflictError(NOT_CONFIGURED);
      const { triggerBotId, missionChannelId } = parseParams(
        discordMissionWakeSchema,
        params,
        'a trigger bot id and a mission channel id are required',
      );
      // Independent of the token/owner-lock path — configuring the wake never re-links the bot
      // (companion-missions.md §3.2). The router reads these on demand, so no gateway restart.
      const record = await discordConfig.configureMissionWake(
        ctx.userId,
        triggerBotId,
        missionChannelId,
      );
      if (!record) throw new NotFoundError('no Discord config to configure');
      return { discord: toView(record) };
    },

    'discord.config.delete': async (ctx) => {
      await discordConfig.delete(ctx.userId);
      // The row is gone → tell the adapter to stop this bot (companion-discord.md §2.1).
      void discordReconcile?.(ctx.userId);
      return { ok: true };
    },
  };
}
