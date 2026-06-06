/**
 * Deterministic trace sampling (runbook-tracing.md). A whole turn's spans are
 * kept or dropped together (sampling by trace id, not per span) so a trace is
 * never half-recorded. Default rate is 0 — even with a provider configured,
 * nothing is sent until the rate is raised. Pure + unit-tested.
 */

/** FNV-1a over the trace id → a stable bucket in [0, 1). */
function bucket(traceId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < traceId.length; i++) {
    hash ^= traceId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // >>> 0 makes it unsigned; divide by 2^32 for [0, 1).
  return (hash >>> 0) / 0x100000000;
}

/** Whether to record a trace at the given sample rate (0…1), deterministic by id. */
export function shouldSample(traceId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return bucket(traceId) < rate;
}
