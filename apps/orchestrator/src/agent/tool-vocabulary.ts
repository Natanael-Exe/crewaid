/**
 * What a tool is CALLED when a person is reading, as opposed to a model.
 *
 * The two audiences need different words for the same thing. A model needs
 * `browser_read`, because that is the function in the registry it must call
 * and a name is cheaper than a description. A person needs "Read the page" —
 * in Claude Code's `/plan`, `/deploy`, `/status` shape, where the token is
 * something they would have typed anyway.
 *
 * So every built-in gets three user-facing fields, and the palette, the
 * transcript and (later) anything else that shows a tool to a human read
 * them:
 *
 * - `alias` — the slash token a person types and reads: `/read-page`.
 * - `label` — the two-or-three-word name a row shows.
 * - `summary` — one sentence, second person, no jargon: what it does.
 *
 * The INTERNAL name stays the wire contract everywhere it matters: the model
 * calls `browser_read`, a mention typed as `/read-page` is resolved back to
 * `browser_read` before the turn is told about it, and the approval prompt
 * still keys on the real name. This map is a rename of the SUBTITLE, never a
 * rename of the function.
 *
 * Tools this build has never heard of — an MCP server's, a compiled skill's —
 * get an honest fallback: the alias is their own name with dashes, the label
 * its words capitalised, and the summary the first sentence of the
 * description the MODEL was given. That is a worse sentence than a curated
 * one, and still a sentence a person can read.
 */
export interface ToolVocabularyEntry {
  /** The user-facing slash token, without the slash. */
  readonly alias: string;
  /** The name a row shows. */
  readonly label: string;
  /** One sentence for a person: what it does, no jargon. */
  readonly summary: string;
}

const VOCABULARY: Readonly<Record<string, ToolVocabularyEntry>> = {
  preview_email: {
    alias: 'preview-email',
    label: 'Preview an email',
    summary: 'Shows an email draft in chat without saving or sending it.',
  },
  present_visual: {
    alias: 'visual',
    label: 'Present visual',
    summary: 'Shows interactive charts, metrics, comparisons or tables in chat.',
  },
  // The browser
  browser_navigate: {
    alias: 'open-page',
    label: 'Open a page',
    summary: 'Opens a URL in the bot’s browser and waits for it to load.',
  },
  browser_read: {
    alias: 'read-page',
    label: 'Read the page',
    summary: 'Reads the current page as text the bot can act on.',
  },
  browser_click: {
    alias: 'click-page',
    label: 'Click on the page',
    summary: 'Clicks an element from the latest page snapshot.',
  },
  browser_type: {
    alias: 'type-on-page',
    label: 'Type on the page',
    summary: 'Fills an editable field from the latest page snapshot.',
  },
  screenshot: {
    alias: 'page-shot',
    label: 'Page screenshot',
    summary: 'A picture of the page itself — layouts, charts, images.',
  },

  // The machine
  capture_screen: {
    alias: 'screen',
    label: 'See the screen',
    summary: 'A picture of the whole screen, not just the page — aim with it before clicking.',
  },
  record_screen_start: {
    alias: 'record',
    label: 'Start recording',
    summary: 'Records the screen; the video is attached to the reply as evidence.',
  },
  record_screen_stop: {
    alias: 'stop-recording',
    label: 'Stop recording',
    summary: 'Stops the recording and attaches the video to the reply.',
  },
  mouse_move: {
    alias: 'move-mouse',
    label: 'Move the mouse',
    summary: 'Moves the pointer to a pixel position, for hover menus and drags.',
  },
  mouse_click: {
    alias: 'click',
    label: 'Click',
    summary: 'Clicks the screen like a person — canvases, captchas, native dialogs.',
  },
  mouse_scroll: {
    alias: 'scroll',
    label: 'Scroll',
    summary: 'Scrolls the wheel where the pointer is.',
  },
  keyboard: {
    alias: 'type',
    label: 'Type or press keys',
    summary: 'Types text or presses key combinations into the focused window.',
  },

  // The computer
  shell: {
    alias: 'run-command',
    label: 'Run a command',
    summary: 'Runs a shell command on the bot’s computer — always asks first.',
  },
  fs_read: {
    alias: 'read-file',
    label: 'Read a file',
    summary: 'Reads a text file from the bot’s computer.',
  },
  fs_write: {
    alias: 'save-file',
    label: 'Write a file',
    summary: 'Writes or replaces a text file on the bot’s computer.',
  },

  // The team
  create_bot: {
    alias: 'new-bot',
    label: 'Create a bot',
    summary: 'Creates a new teammate bot — always asks first.',
  },
  edit_bot: {
    alias: 'edit-bot',
    label: 'Edit a bot',
    summary: 'Changes a teammate’s name, role, brief or model — always asks first.',
  },
  delete_bot: {
    alias: 'delete-bot',
    label: 'Delete a bot',
    summary: 'Permanently deletes one of your bots — always asks first.',
  },
  send_message: {
    alias: 'message-bot',
    label: 'Message a teammate',
    summary: 'Sends a message to another bot on the team.',
  },
  use_identity: {
    alias: 'use-login',
    label: 'Use a shared login',
    summary: 'Switches this bot onto a shared browser identity.',
  },

  // The board
  board_read: {
    alias: 'board',
    label: 'Read the board',
    summary: 'Reads the team’s shared board.',
  },
  board_add: {
    alias: 'post',
    label: 'Post to the board',
    summary: 'Adds a task or note to the team’s board.',
  },
  board_update: {
    alias: 'update-board',
    label: 'Update the board',
    summary: 'Moves or edits an entry on the team’s board.',
  },

  // Memory
  memory_read: {
    alias: 'notes',
    label: 'Read memory',
    summary: 'Reads what the bot knows beyond this conversation.',
  },
  memory_search: {
    alias: 'search-notes',
    label: 'Search memory',
    summary: 'Looks something up in the bot’s memory.',
  },
  remember: {
    alias: 'remember',
    label: 'Remember this',
    summary: 'Keeps a fact beyond this conversation.',
  },
  forget: {
    alias: 'forget',
    label: 'Forget this',
    summary: 'Drops a fact from the bot’s memory.',
  },

  // Skills and files
  run_skill: {
    alias: 'skill',
    label: 'Run a skill',
    summary: 'Runs one of the bot’s approved skills by name.',
  },
  save_skill: {
    alias: 'save-skill',
    label: 'Save a skill',
    summary: 'Saves a reusable procedure as a skill — always asks first.',
  },
  attach_file: {
    alias: 'attach',
    label: 'Attach a file',
    summary: 'Attaches a file from the computer to the reply.',
  },
};

/** `capture_screen` → `capture-screen`. The fallback's alias. */
function dashed(name: string): string {
  return name
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** `capture_screen` → `Capture screen`. The fallback's label. */
function words(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The first sentence of a model-facing description, or the whole of a short one. */
function firstSentence(description: string): string {
  const sentence = description.split(/(?<=[.!?])\s/)[0]?.trim() ?? '';
  return sentence === '' ? description.trim() : sentence;
}

/**
 * The user-facing entry for one tool.
 *
 * `modelDescription` is what the model was told — used only for the fallback,
 * so a tool registered by an MCP server or a skill gets a readable summary
 * instead of a blank row.
 */
export function vocabularyFor(name: string, modelDescription: string): ToolVocabularyEntry {
  const curated = VOCABULARY[name];
  if (curated !== undefined) return curated;
  return {
    alias: dashed(name),
    label: words(name),
    summary: firstSentence(modelDescription),
  };
}

/**
 * Resolve a token a user typed back to the tool the registry knows.
 *
 * Three spellings reach here, and all three must work:
 * - the ALIAS the palette showed (`read-page`),
 * - the internal NAME a power user learned from an earlier version
 * (`browser_read`),
 * - the dashed fallback alias of a tool with no curated entry — an MCP
 * server's or a skill's (`some-custom-tool`).
 *
 * `knownNames` is the live registry, so the caller's question ("may this bot
 * call it?") and this lookup cannot disagree. `null` when nothing matches —
 * a `/` token that names no tool is the user's prose, and the caller leaves
 * it alone.
 */
export function resolveToolToken(token: string, knownNames: readonly string[]): string | null {
  if (knownNames.includes(token)) return token;
  const curated = toolNameForToken(token);
  if (curated !== null && knownNames.includes(curated)) return curated;
  for (const name of knownNames) {
    if (dashed(name) === token) return name;
  }
  return null;
}

/**
 * Resolve a token through the CURATED map only.
 *
 * The two-spelling lookup without a registry behind it, for callers that ask
 * a question the registry cannot answer (a test, a summary). Callers that
 * decide whether a tool may run should use `resolveToolToken`, which is
 * fenced by the live registry.
 */
export function toolNameForToken(token: string): string | null {
  if (Object.hasOwn(VOCABULARY, token)) return token;
  for (const [name, entry] of Object.entries(VOCABULARY)) {
    if (entry.alias === token) return name;
  }
  return null;
}
