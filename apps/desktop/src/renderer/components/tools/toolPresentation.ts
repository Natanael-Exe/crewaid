import type { PartRenderContext } from '../PartRenderer';
import { safeJson, truncateForDisplay, type FoldedToolPart } from './toolParts';
import { type MessageKey, type PlainKey, t } from '../../i18n/i18n';

export type ToolCardKind = 'computer' | 'connection' | 'file' | 'work' | 'generic';
export type DisplayStatus = FoldedToolPart['status'] | 'incomplete';

const COMPUTER = new Set([
  'shell',
  'process_start',
  'process_output',
  'process_stop',
  'capture_screen',
  'screenshot',
  'mouse_move',
  'mouse_click',
  'mouse_scroll',
  'keyboard',
  'record_screen_start',
  'record_screen_stop',
]);
const FILE = new Set(['fs_read', 'fs_write', 'fs_edit', 'fs_grep', 'fs_glob', 'attach_file']);
const TITLES: Readonly<Record<string, PlainKey>> = {
  shell: 'tools.title.shell',
  process_start: 'tools.title.processStart',
  process_output: 'tools.title.processOutput',
  process_stop: 'tools.title.processStop',
  capture_screen: 'tools.title.captureScreen',
  screenshot: 'tools.title.captureScreen',
  mouse_move: 'tools.title.mouseMove',
  mouse_click: 'tools.title.mouseClick',
  mouse_scroll: 'tools.title.mouseScroll',
  keyboard: 'tools.title.keyboard',
  record_screen_start: 'tools.title.recordStart',
  record_screen_stop: 'tools.title.recordStop',
  fs_read: 'tools.title.fsRead',
  fs_write: 'tools.title.fsWrite',
  fs_edit: 'tools.title.fsEdit',
  fs_grep: 'tools.title.fsGrep',
  fs_glob: 'tools.title.fsGlob',
  attach_file: 'tools.title.attachFile',
  present_visual: 'tools.title.presentVisual',
};

const SOURCES = {
  connection: 'tools.source.connection',
  computer: 'tools.source.computer',
  file: 'tools.source.file',
  work: 'tools.source.work',
  generic: 'tools.source.generic',
} as const satisfies Record<ToolCardKind, MessageKey>;

export function readableName(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function toolPresentation(
  name: string,
  context?: PartRenderContext,
): {
  kind: ToolCardKind;
  title: string;
  source: string;
} {
  const info = context?.tools?.get(name);
  const separator = name.indexOf('__');
  const connection = info?.origin === 'mcp' || separator > 0;
  const kind: ToolCardKind = connection
    ? 'connection'
    : FILE.has(name)
      ? 'file'
      : name.startsWith('browser_') || COMPUTER.has(name)
        ? 'computer'
        : /^(task|goal|deliverable)_/.test(name)
          ? 'work'
          : 'generic';
  const source =
    connection && separator > 0 ? readableName(name.slice(0, separator)) : t(SOURCES[kind]);
  const action = (separator > 0 ? name.slice(separator + 2) : name).replace(
    /^(GMAIL|GOOGLEDOCS|GOOGLESHEETS|GOOGLESLIDES)_/i,
    '',
  );
  return {
    kind,
    source: truncateForDisplay(source, 60),
    title: truncateForDisplay(
      info?.label ??
        context?.toolLabels?.get(name) ??
        (TITLES[name] === undefined ? readableName(action) : t(TITLES[name])),
      100,
    ),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Parse only small text results. Large page trees/base64 stay in bounded details. */
export function resultValue(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 16_000) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** These are explicit failure formats emitted by our tool adapters, not guesses from prose. */
export function displayStatus(row: FoldedToolPart, context?: PartRenderContext): DisplayStatus {
  if (
    context?.streaming === false &&
    (row.status === 'running' ||
      (row.status === 'awaiting-approval' && !context.pendingToolCalls?.has(row.toolCallId)))
  )
    return 'incomplete';
  if (row.status !== 'ok') return row.status;
  const value = resultValue(row.output);
  const object = record(value);
  if (
    object?.['isError'] === true ||
    (row.toolName.includes('__') && object?.['successful'] === false)
  )
    return 'error';
  if (typeof value !== 'string') return row.status;
  if (
    (row.toolName === 'shell' && value.startsWith('shell: the turn was cancelled')) ||
    (row.toolName === 'process_start' &&
      value.startsWith('process_start: the turn was cancelled')) ||
    (row.toolName === 'process_output' &&
      value.startsWith('process_output: stopped waiting because the turn was cancelled'))
  )
    return 'incomplete';
  if (row.toolName.startsWith('browser_') && value.startsWith(`${row.toolName.slice(8)} failed:`))
    return 'error';
  if (row.toolName.includes('__') && value.startsWith('The tool reported an error.\n'))
    return 'error';
  // Our own adapters return argument-validation failures as results rather
  // than throwing (mcp-tool-binding, the policy runtime). A receipt must
  // never call that a success.
  if (value.startsWith('INVALID_ARGUMENTS: ')) return 'error';
  if (
    row.toolName === 'shell' &&
    (/^exit [1-9]\d*\b/.test(value) || /^shell: the command was still running/.test(value))
  )
    return 'error';
  if (
    (COMPUTER.has(row.toolName) || FILE.has(row.toolName) || row.toolName.startsWith('browser_')) &&
    (value.startsWith(`${row.toolName} failed:`) ||
      value.startsWith(`${row.toolName} refused:`) ||
      (row.toolName === 'shell' && /^shell ".*" failed:/.test(value)))
  )
    return 'error';
  if (
    row.toolName === 'present_visual' &&
    (value.startsWith('present_visual failed:') || value.startsWith('present_visual refused:'))
  )
    return 'error';
  return row.status;
}

export type PreviewField = {
  label: string;
  value: string;
  /** True when the value is an internal sandbox path hidden behind a hoverable "path" hint. */
  isInternalPath?: boolean;
};
const INTERNAL_PATH_RE = /^\/home\/bot(?:\/|$)/;
const PATH_KEY_RE = /^(path|file_?path|source_?path|dest_?path|target_?path|cwd|dir|directory)$/i;

/** Whether a string is an internal sandbox filesystem path that should not clutter chat faces. */
export function isInternalWorkspacePath(value: string): boolean {
  return INTERNAL_PATH_RE.test(value.trim());
}

/** Final path segment shown in place of a full internal sandbox path. */
export function pathBasename(filePath: string): string {
  const trimmed = filePath.trim().replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '/home/bot') return 'workspace';
  if (/^\/home\/bot\/agents(?:\/[^/]+)?$/.test(trimmed)) return 'workspace';
  if (/^\/home\/bot\/groups(?:\/[^/]+)?$/.test(trimmed)) return 'group folder';
  if (trimmed === '/home/bot/shared') return 'shared folder';
  const parts = trimmed.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

/** Extract the primary file path argument from a tool input object, if any. */
export function toolFilePath(input: unknown): string | undefined {
  const obj = record(input);
  if (obj === undefined) return undefined;
  for (const key of ['path', 'file_path', 'filePath', 'source_path']) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

const OMIT =
  /^(base64|image|images|screenshot|script|content|body|html|raw|payload|headers|access_token|refresh_token|api_key|token)$/i;
export function previewFields(value: unknown): PreviewField[] {
  const entries = Object.entries(record(value) ?? {});
  return entries
    .filter(
      ([key, item]) =>
        !OMIT.test(key) &&
        (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'),
    )
    .slice(0, 5)
    .map(([key, item]) => {
      const raw = String(item);
      const isInternalPath =
        typeof item === 'string' &&
        (isInternalWorkspacePath(raw) || (PATH_KEY_RE.test(key) && raw.trim().startsWith('/')));
      return {
        label: readableName(key),
        value: truncateForDisplay(raw, 240),
        ...(isInternalPath ? { isInternalPath: true } : {}),
      };
    });
}

export function resultPreview(output: unknown): string {
  const value = resultValue(output);
  if (typeof value === 'string') return truncateForDisplay(value, 800);
  const object = record(value);
  // MCP text content is inert text here. Images, links and HTML never load resources.
  if (Array.isArray(object?.['content'])) {
    return truncateForDisplay(
      object['content']
        .slice(0, 3)
        .map((item: unknown) => {
          const part = record(item);
          return part?.['type'] === 'text' && typeof part['text'] === 'string' ? part['text'] : '';
        })
        .filter(Boolean)
        .join('\n'),
      800,
    );
  }
  return value === undefined ? '' : truncateForDisplay(safeJson(value, 2), 800);
}

export function filePreview(row: FoldedToolPart): string | undefined {
  const input = record(row.input);
  if (row.toolName === 'fs_edit') {
    const oldText = typeof input?.['oldText'] === 'string' ? input['oldText'] : undefined;
    const newText = typeof input?.['newText'] === 'string' ? input['newText'] : undefined;
    if (oldText === undefined && newText === undefined) return undefined;
    const diff = [
      ...(oldText === undefined ? [] : oldText.split('\n').map((line) => `- ${line}`)),
      ...(newText === undefined ? [] : newText.split('\n').map((line) => `+ ${line}`)),
    ].join('\n');
    return truncateForDisplay(diff, 1200);
  }
  const value =
    row.toolName === 'fs_write'
      ? input?.['content']
      : row.toolName === 'fs_read' && row.status === 'ok'
        ? resultValue(row.output)
        : undefined;
  return typeof value === 'string' ? truncateForDisplay(value, 1200) : undefined;
}

/**
 * The connected-app actions whose result is something the user keeps or
 * reviews — a draft, a sent email, a created or updated Workspace document.
 * One list, because the card, the receipt and the visibility rule must agree
 * about which actions a transcript keeps in front of the operator.
 */
const USER_OUTPUT_ACTIONS: ReadonlySet<string> = new Set([
  'GMAIL_CREATE_EMAIL_DRAFT',
  'GMAIL_UPDATE_DRAFT',
  'GMAIL_SEND_EMAIL',
  'GMAIL_SEND_DRAFT',
  'GMAIL_REPLY_TO_THREAD',
  'GOOGLEDOCS_CREATE_DOCUMENT',
  'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
  'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
  'GOOGLEDOCS_UPDATE_EXISTING_DOCUMENT',
  'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
  'GOOGLESHEETS_BATCH_UPDATE_SPREADSHEET',
  'GOOGLESHEETS_UPDATE_VALUES_BATCH',
  'GOOGLESHEETS_VALUES_UPDATE',
  'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND',
  'GOOGLESLIDES_CREATE_PRESENTATION',
  'GOOGLESLIDES_CREATE_SLIDES_MARKDOWN',
  'GOOGLESLIDES_BATCH_UPDATE_PRESENTATION',
]);

/** Whether this connected-app action produces a user-facing deliverable. */
export function isResourceAction(name: string): boolean {
  if (name === 'preview_email') return true;
  return USER_OUTPUT_ACTIONS.has(name.split('__').at(-1)?.toUpperCase() ?? '');
}

/**
 * Whether the row is a user-facing deliverable that earns a card, rather than
 * routine work collapsed into a quiet muted line.
 *
 * Cards are reserved for artifacts the user keeps, reviews, or opens directly:
 * email drafts/sends, Google Docs/Sheets/Slides, visuals, and templates.
 * Sandbox file writes (`fs_write`) are intermediate workspace steps and
 * `attach_file` already produces its own AttachmentCard/DocumentPreviewCard,
 * so both collapse into quiet muted lines alongside reads, shell, and browser steps.
 */
export function isUserOutput(row: FoldedToolPart, context?: PartRenderContext): boolean {
  if (row.toolName === 'read_template') return true;
  if (row.toolName === 'preview_email') return true;
  if (row.toolName === 'present_visual') return true;
  const { kind } = toolPresentation(row.toolName, context);
  return kind === 'connection' && isResourceAction(row.toolName);
}
