/** Whole seconds to wait, never zero, so a `Retry-After` of 0 cannot invite an immediate retry. */
export function secondsUntil({ endsAt, now }: { endsAt: number; now: number }): number {
  return Math.max(1, Math.ceil((endsAt - now) / 1000));
}
