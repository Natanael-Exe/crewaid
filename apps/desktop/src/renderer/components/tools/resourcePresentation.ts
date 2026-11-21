import {
  isResourceAction,
  resultValue,
  type DisplayStatus,
  type PreviewField,
} from './toolPresentation';
import { truncateForDisplay } from './toolParts';
import { t } from '../../i18n/i18n';

export type ResourceKind = 'email' | 'document' | 'spreadsheet' | 'slides';
export type ResourcePreview = {
  kind: ResourceKind;
  title: string;
  fields: PreviewField[];
  body?: string;
  bodyIsHtml?: boolean;
  receipt?: string;
  url?: string;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === 'string');
    if (strings.length > 0) return strings.slice(0, 8).join(', ');
  }
  return undefined;
}
function first(object: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = text(object[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Only the producing actions a bot ran for the user render as resource cards. */
export function resourcePreview(
  name: string,
  input: unknown,
  output: unknown,
  status: DisplayStatus,
): ResourcePreview | undefined {
  if (!isResourceAction(name)) return undefined;
  const action = name.split('__').at(-1)?.toUpperCase() ?? '';
  const args = record(input);
  const value = resultValue(output);
  const wrapper = record(value);
  const result = record(resultValue(wrapper['data'] ?? value));
  const success = status === 'ok';
  if (action.startsWith('GMAIL_') || action === 'PREVIEW_EMAIL') {
    const previewOnly = action === 'PREVIEW_EMAIL';
    const draft = previewOnly || (action.includes('DRAFT') && action !== 'GMAIL_SEND_DRAFT');
    const fields: PreviewField[] = [];
    for (const [label, keys] of [
      ['tools.email.from', ['from_email', 'sender']],
      ['tools.email.to', ['recipient_email', 'to']],
      ['tools.email.alsoTo', ['extra_recipients']],
      ['tools.email.cc', ['cc']],
      ['tools.email.bcc', ['bcc']],
    ] as const) {
      const field = first(args, keys);
      if (field !== undefined)
        fields.push({ label: t(label), value: truncateForDisplay(field, 500) });
    }
    const body = first(args, ['body', 'message_body', 'messageText', 'snippet']);
    const subject = first(args, ['subject']);
    // A send-draft receipt may contain only an id. Do not invent its recipients or body.
    return {
      kind: 'email',
      title: truncateForDisplay(
        subject ?? (draft ? t('tools.email.draft') : t('tools.email')),
        160,
      ),
      fields,
      ...(body === undefined
        ? {}
        : { body: truncateForDisplay(body, 20_000), bodyIsHtml: args['is_html'] === true }),
      ...(success
        ? {
            receipt: previewOnly
              ? t('tools.email.previewOnly')
              : draft
                ? t('tools.email.draftSaved')
                : t('tools.email.sent'),
          }
        : {}),
    };
  }
  const kind: ResourceKind | undefined =
    /^GOOGLEDOCS_(CREATE_DOCUMENT|CREATE_DOCUMENT_MARKDOWN|UPDATE_DOCUMENT_MARKDOWN|UPDATE_EXISTING_DOCUMENT)$/.test(
      action,
    )
      ? 'document'
      : /^GOOGLESHEETS_(CREATE_GOOGLE_SHEET1|BATCH_UPDATE_SPREADSHEET|UPDATE_VALUES_BATCH|VALUES_UPDATE|SPREADSHEETS_VALUES_APPEND)$/.test(
            action,
          )
        ? 'spreadsheet'
        : /^GOOGLESLIDES_(CREATE_PRESENTATION|CREATE_SLIDES_MARKDOWN|BATCH_UPDATE_PRESENTATION)$/.test(
              action,
            )
          ? 'slides'
          : undefined;
  if (kind === undefined) return undefined;
  const properties = record(result['properties']);
  const title = first(result, ['title']) ?? first(properties, ['title']) ?? first(args, ['title']);
  const body = first(args, ['text', 'markdown_text', 'markdown']);
  const fields: PreviewField[] = [];
  const range = first(result, ['updatedRange']) ?? first(args, ['range']);
  if (range !== undefined)
    fields.push({ label: t('tools.resource.range'), value: truncateForDisplay(range, 240) });
  if (typeof result['updatedCells'] === 'number')
    fields.push({ label: t('tools.resource.cellsUpdated'), value: String(result['updatedCells']) });
  if (Array.isArray(result['slides']))
    fields.push({ label: t('tools.resource.slides'), value: String(result['slides'].length) });
  const url = first(result, ['documentUrl', 'spreadsheetUrl', 'presentationUrl', 'url']);
  return {
    kind,
    title: truncateForDisplay(
      title ??
        t(
          (
            {
              document: 'tools.resource.document',
              spreadsheet: 'tools.resource.spreadsheet',
              slides: 'tools.resource.presentation',
            } as const
          )[kind],
        ),
      160,
    ),
    fields,
    ...(body === undefined ? {} : { body: truncateForDisplay(body, 1200) }),
    ...(success
      ? {
          receipt: action.includes('CREATE')
            ? t('tools.resource.created')
            : t('tools.resource.updated'),
        }
      : {}),
    ...(success && safeResourceUrl(url, kind) !== undefined
      ? { url: safeResourceUrl(url, kind)! }
      : {}),
  };
}

/** Open returned Google resource locations only; never load thumbnails or follow arbitrary hosts. */
export function safeResourceUrl(value: string | undefined, kind: ResourceKind): string | undefined {
  if (value === undefined || kind === 'email') return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'docs.google.com' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== ''
    )
      return undefined;
    const path = { document: 'document', spreadsheet: 'spreadsheets', slides: 'presentation' }[
      kind
    ];
    return new RegExp(`^/${path}/d/[a-zA-Z0-9_-]+(?:/|$)`).test(url.pathname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
