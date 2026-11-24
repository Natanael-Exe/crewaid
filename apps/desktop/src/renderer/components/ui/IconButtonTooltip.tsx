import { Button, Tooltip, type ButtonProps } from '@heroui/react';
import type { ReactNode } from 'react';

type Placement = 'top' | 'bottom' | 'left' | 'right';

export interface IconButtonTooltipProps extends Omit<ButtonProps, 'isIconOnly'> {
  readonly label: string;
  readonly tooltip?: string;
  readonly placement?: Placement;
  readonly children: ReactNode;
}

/**
 * HeroUI Design Taste primitive: every icon-only action button carries both
 * an accessible `aria-label` and a paired `Tooltip` describing the action.
 */
export function IconButtonTooltip({
  label,
  tooltip,
  placement = 'bottom',
  children,
  variant = 'ghost',
  size = 'sm',
  ...props
}: IconButtonTooltipProps) {
  return (
    <Tooltip delay={400}>
      <Button isIconOnly aria-label={label} variant={variant} size={size} {...props}>
        {children}
      </Button>
      <Tooltip.Content placement={placement}>{tooltip ?? label}</Tooltip.Content>
    </Tooltip>
  );
}
