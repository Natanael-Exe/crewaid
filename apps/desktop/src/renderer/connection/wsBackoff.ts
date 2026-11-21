export const RECONNECT_MIN_DELAY_MS = 1_000 as const;
export const RECONNECT_MAX_DELAY_MS = 30_000 as const;

/**
 * Return the delay before retry number `retryIndex` (zero-based).
 * Consecutive failures use 1s, 2s, 4s, 8s, 16s, then 30s forever.
 */
export function reconnectDelayMs(retryIndex: number): number {
  const safeIndex = Number.isInteger(retryIndex) && retryIndex >= 0 ? retryIndex : 0;
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_MIN_DELAY_MS * 2 ** Math.min(safeIndex, 5));
}
