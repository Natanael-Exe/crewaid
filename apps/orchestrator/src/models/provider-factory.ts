import type { ProviderKind } from '@crewaid/shared';

/**
 * One connection, one callable model: what a connection hands
 * the adapter factory (`tanstack/text-adapter.ts`). The key comes from the
 * owner's connection, never from the process environment, and R3 holds —
 * nothing in the orchestrator calls a provider's HTTP API directly.
 */

/** What a connection needs to become a callable model. Never the row itself. */
export type ProviderBinding = {
  readonly kind: ProviderKind;
  /** Decrypted by the owner-scoped vault immediately before this call. */
  readonly apiKey: string;
  /** Set for `custom` only; admitted by D-085 before it gets here. */
  readonly endpoint: string | null;
  readonly upstreamModelId: string;
};

export class ProviderConfigError extends Error {
  readonly code = 'PROVIDER_CONFIG' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}
