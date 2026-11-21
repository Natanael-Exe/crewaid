import type { BillingResponse } from '@crewaid/shared';
import { useCallback, useEffect, useState } from 'react';
import { getBilling } from '../api/billing';
import { useApiClient } from '../api/useApiClient';

/**
 * The plan, for surfaces that only glance at it — the account menu.
 *
 * Read once when mounted, so the menu opens with the numbers already in it
 * rather than growing a section under the pointer, and again on `refresh`,
 * which the menu calls each time it opens. Any failure is `null`: a server
 * that does not bill answers 404, and a glance has nowhere to explain a
 * network error — Plan & usage does that.
 */
export function useBillingGlance(enabled: boolean): {
  readonly billing: BillingResponse | null;
  readonly refresh: () => void;
} {
  const client = useApiClient();
  const [billing, setBilling] = useState<BillingResponse | null>(null);

  const refresh = useCallback(() => {
    if (!enabled) return;
    getBilling(client).then(setBilling, () => setBilling(null));
  }, [client, enabled]);

  useEffect(() => {
    if (enabled) refresh();
    else setBilling(null);
  }, [enabled, refresh]);

  return { billing, refresh };
}
