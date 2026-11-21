import { markFor } from '../../settings/pluginMarks';

const IMAGES = import.meta.glob('../../../../../../packages/brand/assets/artifacts/*.{svg,png}', {
  eager: true,
  query: '?url',
  import: 'default',
});
const byName: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(IMAGES).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]),
);

export function fileMark(file: { filename: string; mimeType: string }): string | undefined {
  const ext = file.filename.split('.').at(-1)?.toLowerCase();
  const mime = file.mimeType;
  const name =
    mime === 'application/pdf'
      ? 'pdf'
      : mime === 'text/csv' || ext === 'csv'
        ? 'csv'
        : mime.includes('spreadsheet') || ['xlsx', 'xls', 'ods'].includes(ext ?? '')
          ? 'excel'
          : mime.includes('presentation') || ['pptx', 'ppt', 'odp'].includes(ext ?? '')
            ? 'powerpoint'
            : mime.includes('wordprocessing') || ['docx', 'doc', 'odt'].includes(ext ?? '')
              ? 'word'
              : mime === 'text/markdown' || ext === 'md'
                ? 'markdown'
                : mime.startsWith('image/')
                  ? 'image'
                  : mime.startsWith('video/')
                    ? 'video'
                    : mime === 'application/zip'
                      ? 'zip'
                      : mime.startsWith('text/')
                        ? 'text'
                        : undefined;
  return name === undefined ? undefined : byName[`file_type_${name}.svg`];
}

export function toolMark(toolName: string, kind: string): string | undefined {
  if (kind === 'document') return byName['google-docs.png'];
  if (kind === 'spreadsheet') return byName['google-sheets.png'];
  if (kind === 'slides') return byName['google-slides.png'];
  const slug = toolName.split('__')[0] ?? '';
  const action = toolName.split('__').at(-1) ?? '';
  if (action.startsWith('GMAIL_')) return markFor('gmail');
  return toolName.includes('__') ? markFor(slug) : undefined;
}
