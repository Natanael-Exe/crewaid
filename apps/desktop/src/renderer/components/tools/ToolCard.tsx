import type { ReactNode } from 'react';
import { Card, Spinner } from '@heroui/react';
import {
  IconCheck,
  IconCircleCheckFilled,
  IconCircleX,
  IconFileText,
  IconPlugConnected,
  IconScreenShare,
  IconShieldCheck,
  IconTool,
  IconClipboardList,
  IconMail,
  IconTable,
  IconPresentation,
} from '@tabler/icons-react';
import type { ResourceKind } from './resourcePresentation';
import type { DisplayStatus, ToolCardKind, PreviewField } from './toolPresentation';
import { type PlainKey, useT } from '../../i18n/i18n';

// A Map, because a status the wire adds before this build knows it (a part
// arrives as `complete`) has no label and must render none rather than throw.
const LABEL: ReadonlyMap<string, PlainKey> = new Map<DisplayStatus | 'answered', PlainKey>([
  ['running', 'tools.status.running'],
  ['awaiting-approval', 'tools.status.awaiting'],
  ['ok', 'tools.status.ok'],
  ['error', 'tools.status.error'],
  ['denied', 'tools.status.denied'],
  ['incomplete', 'tools.status.incomplete'],
  ['answered', 'tools.status.answered'],
]);
const ICON = {
  computer: IconScreenShare,
  connection: IconPlugConnected,
  file: IconFileText,
  work: IconClipboardList,
  generic: IconTool,
  approval: IconShieldCheck,
  email: IconMail,
  document: IconFileText,
  spreadsheet: IconTable,
  slides: IconPresentation,
} as const;

/**
 * The row's identity mark: a brand logo when the action has one, the kind
 * glyph otherwise. `line` sizes it for the quiet one-line entries of a work
 * log; `card` is the transcript card's header mark.
 */
export function ToolMark({
  kind,
  mark,
  variant = 'card',
}: {
  kind: ToolCardKind | ResourceKind | 'approval';
  mark?: string | undefined;
  variant?: 'card' | 'line';
}) {
  const Icon = ICON[kind];
  return (
    <span className={mark === undefined ? 'crewaid-tool-icon' : 'crewaid-tool-mark'}>
      {mark === undefined ? (
        <Icon aria-hidden className={variant === 'line' ? 'size-4' : 'size-[20px]'} stroke={1.6} />
      ) : (
        <img
          src={mark}
          alt=""
          aria-hidden
          className={variant === 'line' ? 'size-5 object-contain' : 'size-8 object-contain'}
        />
      )}
    </span>
  );
}

/**
 * How an action ended, in words as well as in a marker — the glyph is
 * aria-hidden decoration and colour is not a state. `dense` is the settled
 * success a card shows as the green check alone: a delivered card says "Done"
 * where a screen reader hears it, and the reader sees the check.
 */
export function ToolStatusTag({
  status,
  dense = false,
  count,
}: {
  status: DisplayStatus | 'answered';
  dense?: boolean | undefined;
  /** How many identical runs this row stands in for. */
  count?: number | undefined;
}) {
  const t = useT();
  const label = LABEL.get(status);
  return (
    <span className="crewaid-tool-status text-micro" data-status={status}>
      {count === undefined || count < 2 ? null : (
        <span className="crewaid-tool-count tabular-nums" title={t('tools.ranTimes', { count })}>
          ×{count}
        </span>
      )}
      {status === 'running' ? (
        <Spinner size="sm" color="current" aria-hidden className="size-3" />
      ) : status === 'ok' && dense ? (
        <IconCircleCheckFilled aria-hidden className="size-[18px] text-success" />
      ) : status === 'ok' ? (
        <IconCheck aria-hidden className="size-3" />
      ) : status === 'error' ? (
        <IconCircleX aria-hidden className="size-3" />
      ) : null}
      <span className={dense && status === 'ok' ? 'sr-only' : ''}>
        {label === undefined ? null : t(label)}
      </span>
    </span>
  );
}

/** Shared presentation only. Execution and approval state stay in native messages/bindings. */
export function ToolCard({
  title,
  source,
  kind,
  status,
  children,
  mark,
  count,
}: {
  title: string;
  source: string;
  kind: ToolCardKind | ResourceKind | 'approval';
  status: DisplayStatus | 'answered';
  children: ReactNode;
  mark?: string | undefined;
  count?: number | undefined;
}) {
  const compact = kind === 'document' || kind === 'spreadsheet' || kind === 'slides';
  return (
    <Card
      variant="default"
      className="crewaid-tool-card"
      data-tool-card={kind}
      data-card-status={status}
    >
      {compact ? (
        <>
          <Card.Header className="flex-row items-center justify-between gap-3">
            <ToolMark kind={kind} mark={mark} />
            <Card.Description className="text-micro">{source}</Card.Description>
          </Card.Header>
          <div className="flex items-start justify-between gap-2">
            <Card.Title className="text-callout font-medium leading-5">{title}</Card.Title>
            <ToolStatusTag status={status} dense count={count} />
          </div>
        </>
      ) : (
        <Card.Header className="flex-row items-start gap-3">
          <ToolMark kind={kind} mark={mark} />
          <div className="min-w-0 flex-1">
            <Card.Description className="mb-1 text-micro">{source}</Card.Description>
            <Card.Title className="text-callout font-medium leading-5">{title}</Card.Title>
          </div>
          <ToolStatusTag status={status} dense={compact} count={count} />
        </Card.Header>
      )}
      <Card.Content className="text-caption leading-[18px]">{children}</Card.Content>
    </Card>
  );
}

export function ToolFields({ fields }: { fields: readonly PreviewField[] }): ReactNode {
  return (
    <dl className="crewaid-tool-fields">
      {fields.map((field) => (
        <div key={field.label}>
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}
