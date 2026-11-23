import { Modal, ScrollShadow, useOverlayState } from '@heroui/react';
import { IconX } from '@tabler/icons-react';
import { IconButtonTooltip } from '../components/ui';
import { PluginsPane } from './PluginsPane';
import { useT } from '../i18n/i18n';

export function PluginsModal({
  isOpen,
  onOpenChange,
  botId,
  botName,
}: {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly botId: string | null;
  readonly botName: string | null;
}) {
  const t = useT();
  const overlay = useOverlayState({ isOpen, onOpenChange });

  return (
    <Modal state={overlay}>
      <Modal.Backdrop>
        <Modal.Container size="lg" placement="center" className="sm:w-auto">
          <Modal.Dialog
            aria-label={t('plugins.title')}
            className="crewaid-settings-dialog flex max-w-[94vw] flex-col overflow-hidden rounded-card bg-surface p-0"
          >
            <div className="crewaid-settings-header flex shrink-0 items-start justify-between gap-4 px-[30px] pt-[26px] pb-[22px]">
              <div className="min-w-0">
                <Modal.Heading className="text-heading font-semibold text-foreground">
                  {t('plugins.title')}
                </Modal.Heading>
                <p className="mt-1 text-caption leading-[17px] text-muted">
                  {t('plugins.summary')}
                </p>
              </div>
              <IconButtonTooltip
                label={t('plugins.close')}
                variant="ghost"
                size="sm"
                onPress={() => onOpenChange(false)}
                className="crewaid-settings-close size-8 shrink-0 rounded-full text-muted"
              >
                <IconX className="size-4" stroke={1.8} aria-hidden />
              </IconButtonTooltip>
            </div>
            <ScrollShadow
              hideScrollBar={false}
              className="crewaid-settings-body min-h-0 flex-1 overflow-y-auto px-[30px] pb-7"
            >
              <PluginsPane botId={botId} botName={botName} />
            </ScrollShadow>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
