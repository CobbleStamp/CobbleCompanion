import type { EmbodimentStore } from '@cobble/core';
import type { EmbodimentBinding } from './connection.js';
import { type WsCallContext, WsClientError } from './dispatch.js';

/** Raised when a method needs the live embodiment but the connection doesn't hold it
 *  (never claimed a companion, or has since been superseded). The dispatcher turns
 *  the message into a client-safe error reply. */
export class NotEmbodiedError extends WsClientError {
  readonly code = 'not_embodied';
  constructor(message: string) {
    super(message);
    this.name = 'NotEmbodiedError';
  }
}

/**
 * Fence a state-mutating method (deliver-scalability.md §5.2): the connection must
 * embody a companion AND still hold the claim (a superseded zombie is rejected, so
 * it cannot inject an action after a handoff). Returns the binding to act on.
 */
export async function requireEmbodiment(
  embodiment: EmbodimentStore,
  ctx: WsCallContext,
): Promise<EmbodimentBinding> {
  const binding = ctx.embodiment;
  if (!binding) {
    throw new NotEmbodiedError('this connection does not embody a companion');
  }
  if (!(await embodiment.holds(binding.companionId, binding.owner))) {
    throw new NotEmbodiedError(
      'this connection was superseded — your companion moved to another room',
    );
  }
  return binding;
}
