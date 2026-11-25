import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCircleCheck,
  IconInfoCircle,
} from '@tabler/icons-react';
import type { VisualCalloutBlock, VisualTone } from '@crewaid/shared';

const TONE_ICON_CLASS: Record<VisualTone, string> = {
  info: 'text-accent-soft-foreground',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

const TONE_SURFACE_CLASS: Record<VisualTone, string> = {
  info: 'border-separator bg-surface-secondary',
  success: 'border-success/25 bg-success/8',
  warning: 'border-warning/30 bg-warning/10',
  danger: 'border-danger/25 bg-danger/8',
};

function ToneIcon({ tone }: { readonly tone: VisualTone }) {
  const cls = `mt-0.5 size-4 shrink-0 ${TONE_ICON_CLASS[tone]}`;
  switch (tone) {
    case 'success':
      return <IconCircleCheck aria-hidden className={cls} />;
    case 'warning':
      return <IconAlertTriangle aria-hidden className={cls} />;
    case 'danger':
      return <IconAlertCircle aria-hidden className={cls} />;
    case 'info':
      return <IconInfoCircle aria-hidden className={cls} />;
  }
}

export function CalloutBlock({ block }: { readonly block: VisualCalloutBlock }) {
  return (
    <section
      data-visual-block="callout"
      data-tone={block.tone}
      className={`flex items-start gap-2.5 rounded-[12px] border px-3.5 py-3 ${TONE_SURFACE_CLASS[block.tone]}`}
    >
      <ToneIcon tone={block.tone} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h4 className="m-0 text-footnote font-semibold text-foreground">{block.title}</h4>
        <p className="m-0 text-caption leading-relaxed text-foreground/90">{block.body}</p>
        {block.points !== undefined && block.points.length > 0 ? (
          <ul className="m-0 mt-1 flex list-disc flex-col gap-0.5 ps-4 text-caption leading-snug text-muted">
            {block.points.map((point, idx) => (
              <li key={idx}>{point}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
