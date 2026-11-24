import { useEffect, useMemo, useState } from 'react';

import { credentialsProvider } from '../bridge';
import type { TokenCredentials } from '../connection/wsClient';
import { chatEndpoint, ChatEndpointError, type ChatEndpoint } from './chatEndpoint';
import { t } from '../i18n/i18n';

/**
 * This bot's chat endpoint, once the stored credentials have been read.
 *
 * The read is async (it crosses IPC into `safeStorage`) and the stock SSE
 * adapter resolves its URL synchronously, so the endpoint is resolved before a
 * client is built rather than per request. Bot switches derive a new endpoint
 * synchronously; saving credentials increments the shell's revision to reread
 * this bag and remount its chat client.
 *
 * Fails closed, exactly as `ApiClient` and `WsClient` do: an unconfigured
 * store is a configuration state with its own sentence, never a request to a
 * guessed host.
 */
export type ChatEndpointState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly endpoint: ChatEndpoint }
  | { readonly status: 'failed'; readonly message: string };

export function useChatEndpoint(
  botId: string,
  readCredentials: () => Promise<TokenCredentials> = credentialsProvider,
  credentialRevision = 0,
): ChatEndpointState {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; credentials: TokenCredentials; revision: number }
    | { status: 'failed'; message: string }
  >({ status: 'loading' });
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    readCredentials()
      .then((credentials) => {
        if (!live) return;
        setState({ status: 'ready', credentials, revision: credentialRevision });
      })
      .catch((error: unknown) => {
        if (!live) return;
        // A safeStorage or IPC failure can name paths, so its text never
        // reaches the screen — only the one sentence this file owns.
        setState({
          status: 'failed',
          message:
            error instanceof ChatEndpointError
              ? error.message
              : t('chat.useChatEndpoint.orchestratorCredentialsCouldNotBe'),
        });
      });
    return () => {
      live = false;
    };
  }, [readCredentials, credentialRevision]);
  return useMemo(() => {
    if (state.status !== 'ready') return state;
    if (state.revision !== credentialRevision) return { status: 'loading' } as const;
    try {
      return { status: 'ready', endpoint: chatEndpoint(state.credentials, botId) } as const;
    } catch (error) {
      return {
        status: 'failed',
        message:
          error instanceof ChatEndpointError
            ? error.message
            : t('chat.useChatEndpoint.orchestratorCredentialsCouldNotBe'),
      } as const;
    }
  }, [state, botId, credentialRevision]);
}
