import { Dropdown, Tooltip } from '@heroui/react';
import {
  IconCheck,
  // IconChevronDown,
  IconHandStop,
  IconShieldCheck,
  IconShieldExclamation,
  type Icon,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import type { ApprovalMode } from '@crewaid/shared';
import { updateBot, useApiClient } from '../../api';
import { t, useT } from '../../i18n/i18n';

/** One mode as the menu presents it. */
export type ApprovalModeOption = {
  readonly id: ApprovalMode;
  readonly label: string;
  readonly description: string;
  readonly icon: Icon;
  /** Full access is drawn in the warning colour, in the menu and on the button. */
  readonly warns: boolean;
};

/** D-144's three modes, least trusting first. */
export const APPROVAL_MODES: readonly ApprovalModeOption[] = [
  {
    id: 'ASK',
    get label() {
      return t('composer.approval.ask');
    },
    get description() {
      return t('composer.approval.ask.hint');
    },
    icon: IconHandStop,
    warns: false,
  },
  {
    id: 'AUTO',
    get label() {
      return t('composer.approval.auto');
    },
    get description() {
      return t('composer.approval.auto.hint');
    },
    icon: IconShieldCheck,
    warns: false,
  },
  {
    id: 'FULL',
    get label() {
      return t('composer.approval.full');
    },
    get description() {
      return t('composer.approval.full.hint');
    },
    icon: IconShieldExclamation,
    warns: true,
  },
];

export function approvalModeOption(mode: ApprovalMode): ApprovalModeOption {
  return APPROVAL_MODES.find((option) => option.id === mode) ?? APPROVAL_MODES[1]!;
}

/**
 * How this bot's actions are approved, from the composer: an icon
 * that shows the current mode, and a menu of the three.
 *
 * The choice is saved on the bot, because approvals are decided on the
 * orchestrator for every turn the bot runs, including a routine's or one
 * another bot started while nobody is watching. A turn reads the mode when
 * it starts, so a change applies from the next message.
 */
export function ApprovalModeMenu({
  botId,
  mode,
  onModeChange,
}: {
  botId: string;
  mode: ApprovalMode;
  /** After the server has the new mode, so the shell can re-read the bot. */
  onModeChange?: (() => void) | undefined;
}) {
  const t = useT();
  const client = useApiClient();
  // Shown at once, and put back if the server refuses it.
  const [current, setCurrent] = useState<ApprovalMode>(mode);
  useEffect(() => setCurrent(mode), [mode]);
  const option = approvalModeOption(current);
  const Glyph = option.icon;

  const choose = (next: ApprovalMode) => {
    if (next === current) return;
    const previous = current;
    setCurrent(next);
    updateBot(client, botId, { approvalMode: next })
      .then(() => onModeChange?.())
      .catch(() => setCurrent(previous));
  };

  return (
    <Dropdown>
      <Tooltip>
        <Tooltip.Trigger>
          <Dropdown.Trigger
            aria-label={t('composer.approval.label', { mode: option.label })}
            data-approval-mode={current}
            className={`ms-1 flex h-8 shrink-0 items-center gap-0.5 rounded-full px-1.5 outline-none data-[hovered]:bg-background-secondary data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus/40 ${
              option.warns ? 'text-warning' : 'text-muted'
            }`}
          >
            <Glyph className="size-4" stroke={1.8} />
            {/* <IconChevronDown className="size-2.5" stroke={1.8} /> */}
          </Dropdown.Trigger>
        </Tooltip.Trigger>
        <Tooltip.Content>{option.label}</Tooltip.Content>
      </Tooltip>
      <Dropdown.Popover
        placement="top start"
        className="crewaid-bot-context w-[340px] rounded-xl p-1"
      >
        <p className="px-2 pt-1.5 pb-1 text-[12px] text-muted">{t('composer.approval.question')}</p>
        <Dropdown.Menu
          aria-label={t('composer.approval.question')}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set([current])}
          onSelectionChange={(keys) => {
            const [key] = keys === 'all' ? [] : [...keys];
            if (key === 'ASK' || key === 'AUTO' || key === 'FULL') choose(key);
          }}
        >
          {APPROVAL_MODES.map((candidate) => {
            const ItemGlyph = candidate.icon;
            return (
              <Dropdown.Item
                key={candidate.id}
                id={candidate.id}
                textValue={candidate.label}
                className="items-start gap-2.5 rounded-lg py-2"
              >
                <ItemGlyph
                  className={`mt-0.5 size-[18px] shrink-0 ${candidate.warns ? 'text-warning' : 'text-muted'}`}
                  stroke={1.8}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-[13px] font-medium ${candidate.warns ? 'text-warning' : 'text-foreground'}`}
                  >
                    {candidate.label}
                  </span>
                  <span
                    className={`block text-[12px] leading-[17px] ${
                      candidate.warns ? 'text-warning/85' : 'text-muted'
                    }`}
                  >
                    {candidate.description}
                  </span>
                </span>
                {candidate.id === current ? (
                  <IconCheck
                    aria-hidden
                    className={`mt-0.5 size-4 shrink-0 ${candidate.warns ? 'text-warning' : 'text-accent'}`}
                    stroke={2}
                  />
                ) : null}
              </Dropdown.Item>
            );
          })}
        </Dropdown.Menu>
        <p className="border-t border-separator px-2 pt-1.5 pb-1 text-[11px] text-muted">
          {t('composer.approval.applies')}
        </p>
      </Dropdown.Popover>
    </Dropdown>
  );
}
