import { VISUAL_MAX_DIFF_CHARS, type VisualDiffBlock } from '@crewaid/shared';
import { useT } from '../../i18n/i18n';
import { CodeView } from '../code/CodeView';
import { parseUnifiedDiff } from '../code/codeRows';
import { formatPreviewInternalPaths } from '../markdown/internalPaths';
import { languageForPath } from '../markdown/highlight';

/**
 * One file's change, as a bot shows "what changed" at the end of a coding
 * task: the path, how many lines went in and out, and the diff highlighted in
 * the file's language.
 */
export function DiffBlock({ block }: { readonly block: VisualDiffBlock }) {
  const t = useT();
  const rows = parseUnifiedDiff(block.diff);
  const added = rows.filter((row) => row.diff === 'addition').length;
  const removed = rows.filter((row) => row.diff === 'deletion').length;
  const language = block.language ?? languageForPath(block.path);
  return (
    <section data-visual-block="diff" className="flex min-w-0 flex-col gap-1.5">
      <header className="flex min-w-0 items-baseline justify-between gap-3">
        <h4 className="crewaid-code m-0 truncate font-mono text-caption font-medium text-foreground">
          {formatPreviewInternalPaths(block.path, t('tools.path'))}
        </h4>
        <span className="shrink-0 font-mono text-micro tabular-nums">
          <span aria-hidden className="text-success">
            +{added}
          </span>{' '}
          <span aria-hidden className="text-danger">
            −{removed}
          </span>
          <span className="sr-only">{t('visuals.diff.changes', { added, removed })}</span>
        </span>
      </header>
      <CodeView rows={rows} language={language} maxChars={VISUAL_MAX_DIFF_CHARS} />
    </section>
  );
}
