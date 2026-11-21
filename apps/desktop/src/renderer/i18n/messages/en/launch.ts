export const launch = {
  'launch.launchGate.pointThisAppAtAn': 'Point this app at an orchestrator',
  'launch.launchGate.crewaidRunsItsAgentsOn':
    'Crewaid runs its agents on an orchestrator you host. Give this app its address to get started.',
  'launch.launchGate.waitingForTheBrowser': 'Waiting for the browser…',
  'launch.launchGate.changeOrchestratorAddress': 'Change orchestrator address',
  'launch.launchGate.hideCodeEntry': 'Hide code entry',
  'launch.launchGate.pasteACodeInstead': 'Paste a code instead',
  'launch.launchGate.theSignInPageShows':
    'The sign-in page shows a code at the end. Paste it here.',
  'launch.launchGate.pasteTheCodeFromThe': 'Paste the code from the browser',
  'launch.launchGate.useCode': 'Use code',
  'launch.launchGate.crewaid': 'Crewaid',
  'launch.launchGate.connecting': 'Connecting…',
  'launch.launchGate.checkingYourOrchestratorAndWho':
    'Checking your orchestrator and who you are signed in as.',
  'launch.launchGate.orchestratorAddress': 'Orchestrator address',
  'launch.launchGate.checking': 'Checking…',
  'launch.launchGate.continue': 'Continue',
  'launch.launchGate.cancel': 'Cancel',
  'launch.planGate.readingYourPlan': 'Reading your plan…',
  'launch.planGate.yourPlanCouldNotBe': 'Your plan could not be read',
  'launch.planGate.tryAgain': 'Try again',
  'launch.planGate.chooseYourPlan': 'Choose your plan',
  'launch.planGate.yourPlanNeedsAttention': 'Your plan needs attention',
  'launch.planGate.manageBilling': 'Manage billing',
  'launch.planGate.checkAgain': 'Check again',
  'launch.planGate.signOut': 'Sign out',
  'launch.launchGate.signInWithBrowser': 'Sign in with browser',
  'launch.launchState.crewaidIsNotAnswering': 'Crewaid is not answering',
  'launch.launchState.nothingAnsweredAtThatAddress': 'Nothing answered at that address',
  'launch.launchState.signInToCrewaid': 'Sign in to Crewaid',
  'launch.launchState.cannotSignInOnThis': 'Cannot sign in on this machine',
  'launch.launchState.theAppCouldNotReach':
    'The app could not reach its own credential store. Restarting it usually clears this.',
  'launch.launchState.thatSignInDidNot': 'That sign-in did not complete. Try again.',
  'launch.launchState.account': 'Account',
  'launch.launchState.enterTheAddressYourOrchestrator':
    'Enter the address your orchestrator is served from.',
  'launch.launchState.thatIsNotAValid':
    'That is not a valid URL. Include the scheme, e.g. http://localhost:3000',
  'launch.launchState.theAddressHasToBe': 'The address has to be http:// or https://',
  'launch.launchState.nothingAnsweredAtThatAddress2':
    'Nothing answered at that address. Check the orchestrator is running and the port is right.',
  'launch.launchState.somethingAnsweredAtThatAddress':
    'Something answered at that address, but no orchestrator is served there.',
  'launch.launchState.theOrchestratorAnsweredWithAn':
    'The orchestrator answered with an error. It may still be starting up.',
  'launch.launchState.getStartedYouCanChangeFull':
    'Crewaid runs its agents on an orchestrator you host. Give this app its address to get started — you can change it later in Settings.',
  'launch.launchState.unavailableNothingOnThisMachineFull':
    'Check your internet connection. If it is working, Crewaid may be briefly unavailable. Nothing on this machine has been changed.',
  'launch.launchState.machineHasBeenChangedFull':
    'The orchestrator may not be running, or the address may be wrong. Nothing on this machine has been changed.',
  'launch.launchState.inOpensYourBrowserThisFull':
    'Your bots, their computers and your provider keys all belong to an account. Signing in opens your browser; this app never sees your password.',
  'launch.launchState.toSignInWithOnFull':
    'Your credentials could not be read from this machine’s keychain, so there is nothing to sign in with. On Linux this usually means no Secret Service is running.',
  'launch.launchGate.thisMachineCouldNotStore':
    'This machine could not store the address. Check its keychain is available.',
  'launch.planGate.theBrowserDidNotOpen': 'The browser did not open. Try again.',
  'launch.planGate.stripeCouldNotBeReached': 'Stripe could not be reached. Try again in a moment.',
  'launch.launchState.nothingAnsweredOverHttps':
    'Nothing answered over https. A local orchestrator usually serves plain http — try {address}',
  'launch.planGate.finishInYourBrowser':
    'Finish in your browser. This screen moves on by itself once Stripe confirms your plan.',
  'launch.planGate.signedInAs': 'Signed in as {email}.',
} as const;
