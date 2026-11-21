import { useEffect, useSyncExternalStore } from 'react';
import type { CrewaidChat } from './crewaidChat';

/** React reads the SDK's state; the SDK remains the only streamed-message reducer. */
export function useAguiChat(connection: CrewaidChat) {
  const state = useSyncExternalStore(
    connection.subscribe,
    connection.getSnapshot,
    connection.getSnapshot,
  );
  useEffect(() => {
    connection.start();
    return () => connection.dispose();
  }, [connection]);
  return {
    ...state,
    setMessages: connection.setMessages,
    appendStored: connection.appendStored,
    sendMessage: connection.sendMessage,
    stop: connection.stop,
    loadOlderMessages: connection.loadOlderMessages,
  };
}
