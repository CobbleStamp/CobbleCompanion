import type { EmbodimentStore } from '@cobble/core';
import type { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { overCapGuard } from '../../quota-guard.js';
import { type WsCallContext, WsClientError } from '../dispatch.js';
import { requireEmbodiment } from '../fencing.js';

/** A method param failed schema validation — the dispatcher maps it to a client error. */
export class BadParamsError extends WsClientError {
  readonly code = 'bad_params';
  constructor(message: string) {
    super(message);
    this.name = 'BadParamsError';
  }
}

/** A method could not proceed against current state (the WS analogue of HTTP 409). */
export class ConflictError extends WsClientError {
  readonly code = 'conflict';
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** A referenced resource was not found (the WS analogue of HTTP 404). */
export class NotFoundError extends WsClientError {
  readonly code = 'not_found';
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** The vitality wallet is empty — the action would spend tokens it doesn't have
 *  (the WS analogue of HTTP 429). */
export class OverCapError extends WsClientError {
  readonly code = 'over_cap';
  constructor(message: string) {
    super(message);
    this.name = 'OverCapError';
  }
}

/**
 * The shared ingest queue is at capacity — a transient, retryable refusal (the WS
 * analogue of the HTTP route's 429, and distinct from the per-companion vitality
 * {@link OverCapError}). Tagging the core `IngestionQueueFullError` at the WS boundary
 * keeps its already-client-safe message reaching the client: the dispatcher only
 * forwards messages from {@link WsClientError}s (`dispatch.ts`).
 */
export class QueueFullError extends WsClientError {
  readonly code = 'queue_full';
  constructor(message: string) {
    super(message);
    this.name = 'QueueFullError';
  }
}

/**
 * Embed a search query for the recall methods, mirroring the routes: gate on the
 * stamina wallet (throw {@link OverCapError} if empty), then embed — degrading to a
 * lexical-only (empty) embedding if the provider fails — and best-effort spend the
 * tokens. Never throws except the over-cap gate.
 */
export async function embedSearchQuery(
  deps: AppDeps,
  companionId: string,
  query: string,
  operation: string,
): Promise<readonly number[]> {
  const overCap = await overCapGuard(deps.quota, companionId);
  if (overCap) {
    throw new OverCapError(overCap);
  }
  let queryEmbedding: readonly number[] = [];
  let searchTokens = 0;
  try {
    const { vectors, usage } = await deps.embeddings.embed({
      input: [query],
      model: deps.config.embeddingModel,
      dimensions: deps.config.embeddingDimensions,
    });
    queryEmbedding = vectors[0] ?? [];
    searchTokens = usage.totalTokens;
  } catch (error) {
    deps.logger.error('search embedding failed; degrading to lexical-only', {
      operation,
      companionId,
      error,
    });
  }
  try {
    await deps.quota.spend(companionId, searchTokens);
  } catch (error) {
    deps.logger.error('failed to record search token usage', { operation, companionId, error });
  }
  return queryEmbedding;
}

/** Validate a method's params with the same Zod schema the HTTP route used.
 *  Returns the parsed *output* type, so schema `.default(...)`s are applied. */
export function parseParams<S extends z.ZodTypeAny>(
  schema: S,
  params: unknown,
  message: string,
): z.infer<S> {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new BadParamsError(message);
  }
  return result.data;
}

/**
 * The companion this connection embodies, ownership-checked at the handshake and
 * still held (fenced). Companion-scoped methods use this instead of re-resolving +
 * re-authorizing per call — the embodiment binding *is* the authorization.
 */
export async function companionOf(
  embodiment: EmbodimentStore,
  ctx: WsCallContext,
): Promise<string> {
  const binding = await requireEmbodiment(embodiment, ctx);
  return binding.companionId;
}
