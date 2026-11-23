import { ToolFields } from './ToolCard';
import type { ResourcePreview as Preview } from './resourcePresentation';
import { useT } from '../../i18n/i18n';

export function ResourcePreview({
  preview,
  showTitle = false,
}: {
  preview: Preview;
  showTitle?: boolean;
}) {
  const t = useT();
  return (
    <div data-resource-preview={preview.kind}>
      {showTitle ? (
        <p className="mb-3 font-medium">
          {preview.kind === 'email'
            ? t('tools.preview.subject', { subject: preview.title })
            : preview.title}
        </p>
      ) : null}
      {preview.fields.length === 0 ? null : <ToolFields fields={preview.fields} />}
      {preview.body === undefined ? null : (
        <div className="mt-3">
          {preview.bodyIsHtml ? (
            <p className="mb-1 text-micro text-muted">{t('tools.preview.htmlSource')}</p>
          ) : null}
          <pre className="crewaid-tool-preview crewaid-resource-body">{preview.body}</pre>
        </div>
      )}
      {preview.receipt === undefined ? null : (
        <p className="mt-3 text-micro text-muted" data-resource-receipt>
          {preview.receipt}
        </p>
      )}
    </div>
  );
}
