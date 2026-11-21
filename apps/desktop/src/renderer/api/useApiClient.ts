import { useMemo } from 'react';
import { credentialsProvider } from '../bridge';
import { ApiClient, type ApiClientOptions } from './apiClient';

/**
 * `ApiClient` holds no per-instance state — credentials are read per request —
 * so components may each hold their own without coordination. The hook exists
 * to give them a stable identity across renders (an effect dependency on a
 * fresh client would re-run every render) and one place to swap the transport
 * in a test.
 *
 * There is deliberately no base-URL context beside it. One existed to render
 * download links without an IPC read per card; those links could not carry the
 * bearer and so always answered 401, and a resolved origin has no other
 * caller — every route is reached through the client, which resolves its own.
 */
export function useApiClient(options?: Partial<ApiClientOptions>): ApiClient {
  const provider = options?.credentialsProvider ?? credentialsProvider;
  const fetchFn = options?.fetchFn;
  return useMemo(
    () => new ApiClient({ credentialsProvider: provider, ...(fetchFn ? { fetchFn } : {}) }),
    [provider, fetchFn],
  );
}
