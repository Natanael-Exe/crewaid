export const screen = {
  'screen.screenCard.viewFullScreen': 'View full screen',
  'screen.screenCard.open': 'Open',
  'screen.screenCard.someoneElseIsInControl': 'Someone else is in control',
  'screen.screenCard.closeFullScreen': 'Close full screen',
  'screen.screenCard.connectingToDisplay': 'Connecting to display…',
  'screen.screenCard.reconnectDisplay': 'Reconnect display',
  'screen.screenCard.takeControl': 'Take control',
  'screen.screenCard.handBack': 'Hand back',
  'screen.screenCard.cancel': 'Cancel',
  'screen.screenCard.handControlBackAndStop':
    'Hand control back and stop teaching first. This returns the bot to its private profile so another bot can reuse the shared login.',
  'screen.screenCard.releaseSharedLogin': 'Release shared login',
  'screen.recordingCardState.teachATask': 'Teach a task',
  'screen.recordingCardState.stop': 'Stop',
  'screen.recordingCardState.discardDraft': 'Discard draft',
  'screen.recordingCardState.discard': 'Discard',
  'screen.recordingCardState.reviewDraft': 'Review draft',
  'screen.recordingCardState.recording': 'Recording',
  'screen.recordingCardState.stopping': 'Stopping',
  'screen.recordingCardState.draftSkillIsReady': 'Draft skill is ready.',
  'screen.recordingCardState.recordingFinished': 'Recording finished.',
  'screen.screenCard.youAreInControlBot':
    'You are in control. Bot screen actions are paused. Background programs can keep running.',
  'screen.screenCard.theBotHasControlAgain':
    'The bot has control again. Background programs can keep running.',
  'screen.screenCard.clickTakeControlAboveTo':
    'Click “Take control” above to interact with this computer.',
  'screen.screenCard.theComputerIsNotRunning': 'The computer is not running.',
  'screen.screenCard.sharedLoginReleasedTheNext':
    'Shared login released. The next browser opens privately.',
  'screen.screenCard.handTheScreenBackStop':
    'Hand the screen back, stop teaching, and wait for running actions to finish; then retry.',
  'screen.screenCardState.noBotSelected': 'No bot selected',
  'screen.screenCardState.wakingTheComputer': 'Waking the computer…',
  'screen.screenCardState.thisComputerIsAsleep': 'This computer is asleep.',
  'screen.screenCardState.openComputer': 'Open computer',
  'screen.screenCardState.tryAgain': 'Try again',
  'screen.screenStreamClient.theDisplayCouldNotBe': 'The display could not be opened.',
  'screen.screenStreamClient.theDisplayDisconnected': 'The display disconnected.',
  'screen.screenCard.theLoginReleaseCouldNot':
    'The login release could not be confirmed. Retry before transferring it.',
  'screen.recordingCardState.startingRecording': 'Starting recording…',
  'screen.recordingCardState.compilingSkill': 'Compiling skill…',
  'screen.recordingCardState.stoppedAtTimeLimit':
    'Stopped at the 20-minute limit. The trace covers only what was captured up to that point.',
  'screen.recordingCardState.stoppedAtEventLimit':
    'Stopped at the 5,000-event limit. The trace covers only what was captured up to that point.',
  'screen.recordingCardState.capturedPointer': 'pointer',
  'screen.recordingCardState.capturedKey': 'key',
  'screen.recordingCardState.capturedTyping': 'typing',
  'screen.recordingCardState.events': { one: '{count} event', other: '{count} events' },
  'screen.recordingCardState.eventsWithKind': {
    one: '{count} event · {kind}',
    other: '{count} events · {kind}',
  },
  'screen.recordingCardState.draftSkillNamedIsReady': 'Draft skill “{name}” is ready.',
  'screen.screenCardState.botsScreen': "{botName}'s screen",
  'screen.screenCardState.machineFailed':
    'Something went wrong with this computer. If it keeps happening, contact your team.',
  'screen.seatControlState.botIsUsing': 'The bot is using this computer',
  'screen.seatControlState.waitingForBot': 'Waiting for the bot to finish its step…',
  'screen.seatControlState.youAreInControl': 'You are in control. Bot screen actions are paused.',
  'screen.seatControlState.someoneElseInControl': 'Someone else is in control',
} as const;
