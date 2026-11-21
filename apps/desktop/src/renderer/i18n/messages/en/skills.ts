export const skills = {
  'skills.skillReviewBody.loadingSkill': 'Loading skill…',
  'skills.skillReviewBody.tryAgain': 'Try again',
  'skills.skillReviewBody.description': 'Description',
  'skills.skillReviewBody.noDescription': 'No description.',
  'skills.skillReviewBody.steps': 'Steps',
  'skills.skillReviewBody.noStepSummaryForThis': 'No step summary for this skill.',
  'skills.skillReviewBody.parameters': 'Parameters',
  'skills.skillReviewBody.noParameters': 'No parameters.',
  'skills.skillReviewBody.optional': 'optional',
  'skills.skillReviewBody.whatShouldChange': 'What should change?',
  'skills.skillReviewBody.eGUseFirefoxInstead':
    'e.g. Use Firefox instead of Chrome, and make the search term a parameter.',
  'skills.skillReviewBody.sayItInYourOwn':
    'Say it in your own words — the compiler applies the change and writes the next version.',
  'skills.skillReviewBody.cancel': 'Cancel',
  'skills.skillReviewBody.updating': 'Updating…',
  'skills.skillReviewBody.updateWithAi': 'Update with AI',
  'skills.skillReviewBody.edit': 'Edit',
  'skills.skillReviewBody.approving': 'Approving…',
  'skills.skillReviewBody.approveSkill': 'Approve skill',
  'skills.skillReviewBody.developerView': 'Developer view',
  'skills.skillReviewBody.source': 'Source',
  'skills.skillReviewBody.skillSource': 'Skill source',
  'skills.skillReviewBody.saving': 'Saving…',
  'skills.skillReviewBody.saveChanges': 'Save changes',
  'skills.skillReviewBody.parametersJsonSchema': 'Parameters (JSON Schema)',
  'skills.skillReviewBody.reviewSkill': 'Review skill',
  'skills.skillReviewBody.close': 'Close',
  'skills.skillReviewState.theScriptCannotBeEmpty': 'The script cannot be empty.',
  'skills.skillReviewState.sayWhatShouldChange': 'Say what should change.',
  'skills.skillReviewState.thisAppIsNotConnected':
    'This app is not connected to a server yet. Sign in from Settings → General.',
  'skills.skillReviewState.theServerCouldNotBe':
    'The server could not be reached. Check your connection and try again.',
  'skills.skillReviewState.yourSessionHasEndedSign':
    'Your session has ended. Sign in again from Settings → General.',
  'skills.skillReviewState.thisSkillNoLongerExists': 'This skill no longer exists.',
  'skills.skillReviewState.theSkillChangedOnThe':
    'The skill changed on the server. Reopen it to see its current state.',
  'skills.skillReviewState.someOfTheseValuesWere':
    'Some of these values were not accepted. Check them and try again.',
  'skills.skillReviewState.theServerSentAnAnswer':
    'The server sent an answer this version of the app cannot read. Updating the app usually fixes it.',
  'skills.skillReviewState.theCompilerCouldNotApply':
    'The compiler could not apply that change. Try wording it differently, or edit the source directly.',
  'skills.skillReviewState.keepTheChangeUnder': {
    one: 'Keep the change under {count} character.',
    other: 'Keep the change under {count} characters.',
  },
  'skills.skillReviewState.version': 'v{version}',
  'skills.skillReviewState.draft': 'Draft',
  'skills.skillReviewState.draftCannotRun': 'This draft cannot run until it is approved.',
  'skills.skillReviewState.approved': 'Approved',
  'skills.skillReviewState.approvedCanRun': 'Approved — this skill can run.',
  'skills.skillReviewState.archived': 'Archived',
  'skills.skillReviewState.archivedCannotRun':
    'Archived skills cannot run. Editing saves a new draft version.',
  'skills.skillReviewState.savedAs': 'Saved as v{version}.',
  'skills.skillReviewState.updatedAs': 'Updated as v{version}.',
  'skills.skillReviewState.skillApproved': 'Skill approved.',
} as const;
