export const connection = {
  'connection.connectionStatus.connected': 'Connected',
  'connection.connectionStatus.liveUpdatesOn': 'Live updates on',
  'connection.connectionStatus.connecting': 'Connecting',
  'connection.connectionStatus.openingLiveUpdates': 'Opening live updates',
  'connection.connectionStatus.reconnecting': 'Reconnecting',
  'connection.connectionStatus.offline': 'Offline',
  'connection.connectionStatus.configureTheOrchestratorToConnect':
    'Configure the orchestrator to connect',
  'connection.wsClient.refusedToSendAnInvalid': 'Refused to send an invalid client event.',
  'connection.wsClient.theLiveConnectionFailed': 'The live connection failed.',
  'connection.wsClient.refusedToSendAnInvalid2': 'Refused to send an invalid screen input event.',
  'connection.wsClient.thisAppIsNotSigned':
    'This app is not signed in yet. Sign in from Settings → General.',
  'connection.wsClient.theServerAddressInSettings':
    'The server address in Settings → General is not valid.',
  'connection.wsClient.receivedAnInvalidServerEvent': 'Received an invalid server event.',
  'connection.connectionStatus.retryingIn': 'Retrying in {seconds}s',
  'connection.wsClient.unsupportedWireVersion':
    'The server sent a wire version {version} frame; this app understands {supported}. Update Crewaid.',
} as const;
