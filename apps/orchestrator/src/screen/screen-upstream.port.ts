export type {
  ScreenUpstream,
  ScreenUpstreamFactory,
  ScreenUpstreamOptions,
} from '@crewaid/screen-stream';

/**
 * Injection token for the factory every screen connection is opened through.
 * A string token, not the class, for the same reason SANDBOX_PROVIDER is one:
 * the orchestrator must boot in tests without opening a TCP connection to
 * anything.
 */
export const RFB_UPSTREAM_FACTORY = 'RFB_UPSTREAM_FACTORY';
