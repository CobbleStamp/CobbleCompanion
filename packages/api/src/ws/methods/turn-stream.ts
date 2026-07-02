/**
 * Shared turn-stream plumbing for the streaming WS methods (the chat turn, the greeting,
 * proposal-confirm re-entry, and the mission turns). A turn is a multi-step agent loop, so
 * these methods run through the connection's serial chain (D2′) and drive the harness
 * generator by hand to capture its terminal supersession signal. Extracted so `streaming.ts`
 * and `missions.ts` share exactly one copy (deliver-scalability.md §5.2).
 */

import type { CompanionDto, ChatStreamEvent } from '@cobble/shared';
import type { EmbodimentStore, IdentityStore } from '@cobble/core';
import { SUPERSEDED_CLOSE } from '../connection.js';
import type { WsCallContext } from '../dispatch.js';
import { requireEmbodiment } from '../fencing.js';
import { NotFoundError } from './helpers.js';

/** The embodied companion resolved as a DTO, with the exact lease claim for the mid-turn fence. */
export interface EmbodiedCompanion {
  readonly id: string;
  readonly dto: CompanionDto;
  readonly connectionId: string;
  readonly claimSeq: number;
}

/**
 * Resolve the embodied companion as a DTO (for harness calls) — fenced. Carries the ULID
 * `connectionId` + `claimSeq` so the turn can re-check the exact lease mid-loop.
 */
export async function embodiedCompanion(
  deps: { readonly identity: IdentityStore; readonly embodiment: EmbodimentStore },
  ctx: WsCallContext,
): Promise<EmbodiedCompanion> {
  const binding = await requireEmbodiment(deps.embodiment, ctx);
  const dto = await deps.identity.getCompanion(binding.companionId, ctx.userId);
  if (!dto) {
    throw new NotFoundError('companion not found');
  }
  return {
    id: binding.companionId,
    dto,
    connectionId: binding.connectionId,
    claimSeq: binding.claimSeq,
  };
}

/**
 * The mid-turn embodiment fence handed to the harness: re-reads the DB claim so a turn
 * already running self-ends if a newer connection took the room (§5.2). Matches the exact
 * claim (connectionId + claimSeq) so a recurred ULID can't revive a stale fence.
 */
export function leaseGuard(
  embodiment: EmbodimentStore,
  companionId: string,
  connectionId: string,
  claimSeq: number,
): () => Promise<boolean> {
  return () => embodiment.holds(companionId, connectionId, claimSeq);
}

/**
 * Drive a turn stream to completion, emitting each chunk. Returns the harness's terminal
 * signal: true = the turn stood down mid-loop because a newer connection force-claimed the
 * companion (the user moved rooms). The caller yields the room.
 */
export async function emitAll(
  ctx: WsCallContext,
  stream: AsyncGenerator<ChatStreamEvent, boolean | void>,
): Promise<boolean> {
  try {
    let next = await stream.next();
    while (!next.done) {
      ctx.emit(next.value);
      next = await stream.next();
    }
    return next.value === true;
  } catch (error) {
    // Driving the generator by hand (to capture its terminal return value) loses the
    // automatic `.return()` that `for await` performs on early exit. Forward termination so
    // the harness generator's `finally` still runs — ending its trace, debiting metered
    // tokens, and tearing down any in-flight LLM stream — then re-throw for the dispatcher.
    await stream.return(false).catch(() => undefined);
    throw error;
  }
}

/**
 * The companion moved rooms mid-turn: tell this (now superseded) client and close the socket
 * at once, rather than lingering until the next heartbeat notices the lost claim (§5.2).
 * Idempotent with the heartbeat's own self-fence — a second close is a no-op.
 */
export function yieldRoom(ctx: WsCallContext, companionId: string): void {
  ctx.connection.pushEvent('embodiment.superseded', { companionId });
  ctx.connection.close(SUPERSEDED_CLOSE, 'superseded');
}
