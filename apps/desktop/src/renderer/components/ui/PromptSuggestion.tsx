import { Button, type ButtonProps } from '@heroui/react';
import { IconChevronRight } from '@tabler/icons-react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from './compose';

/**
 * Tappable replies and starting points offered under a message. Each one is a
 * HeroUI Button, so a screen's own button styling (the welcome's glass pills)
 * applies to it like any other button.
 */

export function PromptSuggestionRoot({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="prompt-suggestion"
      className={cx('flex flex-col gap-2', className)}
      {...props}
    />
  );
}

export function PromptSuggestionItems({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="prompt-suggestion-items"
      className={cx('flex flex-wrap gap-2', className)}
      {...props}
    />
  );
}

export interface PromptSuggestionItemProps extends Omit<ButtonProps, 'children'> {
  readonly children: ReactNode;
  readonly showEndIcon?: boolean;
}

export function PromptSuggestionItem({
  children,
  className,
  showEndIcon = true,
  ...props
}: PromptSuggestionItemProps) {
  return (
    <Button
      data-slot="prompt-suggestion-item"
      variant="secondary"
      className={cx('h-auto min-h-9 max-w-full justify-start rounded-full text-start', className)}
      {...props}
    >
      <span className="min-w-0">{children}</span>
      {showEndIcon ? (
        <IconChevronRight aria-hidden className="size-3.5 shrink-0 text-muted rtl:-scale-x-100" />
      ) : null}
    </Button>
  );
}

export const PromptSuggestion = Object.assign(PromptSuggestionRoot, {
  Root: PromptSuggestionRoot,
  Items: PromptSuggestionItems,
  Item: PromptSuggestionItem,
});
