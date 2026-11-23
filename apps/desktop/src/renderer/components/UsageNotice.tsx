import { Button } from '@heroui/react';
import { IconX } from '@tabler/icons-react';
import type { UsageNoticePayload } from '@crewaid/shared';
import { usageNoticeText } from '../settings/billingState';
import { useT } from '../i18n/i18n';
import { IconButtonTooltip } from './ui';

/**
 * A plan-use notice in the sidebar's footer: 80% or 100% of this
 * period's computer time or included model use. Beside the account, because
 * the plan is the account's — not in a transcript, which is a bot's.
 */
export function UsageNotice({
  notice,
  onOpenPlan,
  onDismiss,
}: {
  notice: UsageNoticePayload;
  onOpenPlan: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const urgent = notice.level === 100;
  return (
    <div
      role="status"
      className={`mb-1.5 flex items-start gap-2 rounded-[10px] px-2.5 py-2 text-caption leading-[16px] ${
        urgent ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-foreground'
      }`}
    >
      <div className="min-w-0 flex-1">
        <p>{usageNoticeText(notice)}</p>
        <Button
          variant="ghost"
          size="sm"
          onPress={onOpenPlan}
          className="-ms-1.5 mt-1 h-6 rounded-md px-1.5 text-caption font-medium"
        >
          {t('usageNotice.plan')}
        </Button>
      </div>
      <IconButtonTooltip
        label={t('usageNotice.dismiss')}
        onPress={onDismiss}
        className="size-6 shrink-0 rounded-md text-muted"
      >
        <IconX className="size-3.5" stroke={1.8} />
      </IconButtonTooltip>
    </div>
  );
}
