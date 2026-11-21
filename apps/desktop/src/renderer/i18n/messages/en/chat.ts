export const chat = {
  'chat.chatFailure.thisConversationOrAFile':
    'This conversation, or a file on the message, is no longer here. Open the bot again and resend.',
  'chat.chatFailure.theBotIsWaitingFor':
    'The bot is waiting for your answer above. Answer it first, then send this.',
  'chat.chatFailure.theBotIsStillWorking':
    'The bot is still working on your last message. Send this when it finishes.',
  'chat.chatFailure.thatRequestWasAlreadyAnswered':
    'That request was already answered, maybe in another window.',
  'chat.chatThread.earlierMessagesCouldNotLoad': 'Earlier messages could not load.',
  'chat.useChatEndpoint.orchestratorCredentialsCouldNotBe':
    'Orchestrator credentials could not be read.',
  'chat.chatFailure.historyFailed':
    'This conversation could not load. Check your connection, then open it again.',
  'chat.chatFailure.runDisconnected':
    'Lost the connection to this reply. Open the conversation again to pick it back up.',
  'chat.chatFailure.runFailed': 'The bot could not finish this. Ask it to carry on.',
  'chat.chatFailure.messageUnreachable':
    'Could not reach the server, so your message was not sent. Check your connection and try again.',
  'chat.chatFailure.answerUnreachable':
    'Could not reach the server, so your answer was not sent. Check your connection and try again.',
  'chat.chatFailure.messageNotSent': 'Your message could not be sent. Try again.',
  'chat.chatFailure.answerNotSent': 'Your answer could not be sent. Try again.',
  'chat.chatEndpoint.credentialsNotConfigured': 'Orchestrator credentials are not configured.',
  'chat.chatEndpoint.urlNotValid': 'The orchestrator URL is not valid.',
  'chat.chatEndpoint.urlMustUseHttp': 'The orchestrator URL must use HTTP or HTTPS.',
} as const;
