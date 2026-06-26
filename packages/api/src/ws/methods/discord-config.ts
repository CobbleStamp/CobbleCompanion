import {
  encryptSecret,
  generateLinkCode,
  keyFromBase64,
  type DiscordConfigRecord,
} from '@cobble/db';
import { discordConfigSetSchema, type DiscordConfigViewDto } from '@cobble/shared';
import type { AppDeps } from '../../app.js';
import type { WsMethods } from '../dispatch.js';
import { ConflictError, NotFoundError, parseParams } from './helpers.js';

/**
 * The Discord settings methods (companion-discord.md §9, T13): the web panel saves the
 * user's bot token + bound companion, and the API encrypts the token before storing it
 * in `discord_config` (which the decoupled worker polls). USER-scoped — they act on
 * `ctx.userId`, never on an embodied companion, so they carry no `requireEmbodiment`
 * guard.
 *
 * Disabled (every method returns a `conflict` "not configured") unless
 * `DISCORD_TOKEN_KEY` is set — the encryption key the worker shares.
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
  };
}

export function discordConfigMethods(deps: AppDeps): WsMethods {
  const { discordConfig, identity, config } = deps;
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

    'discord.config.delete': async (ctx) => {
      await discordConfig.delete(ctx.userId);
      return { ok: true };
    },
  };
}
