import { IconChevronRight } from '@tabler/icons-react';
import type { ComponentPropsWithRef, ComponentType, ReactNode } from 'react';
import { Button as ButtonPrimitive } from 'react-aria-components/Button';
import { cx } from './compose';

/**
 * A grouped card of rows divided by hairlines: a muted leading icon, a label
 * (and optional description), and a trailing chevron or control. The shape of
 * an index screen, where each row opens something or toggles in place.
 *
 * Rows that open something are buttons, so they are reached with Tab and named
 * by their label; a list of a handful of destinations does not need a grid's
 * arrow-key contract.
 */
export function ListView({ className, children, ...props }: ComponentPropsWithRef<'ul'>) {
  return (
    <ul className={cx('crewaid-list-view', className)} {...props}>
      {children}
    </ul>
  );
}

type IconComponent = ComponentType<{
  className?: string;
  stroke?: number;
  'aria-hidden'?: boolean;
}>;

export interface ListViewItemProps {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly icon?: IconComponent;
  /** A control or value shown at the end instead of the chevron. */
  readonly trailing?: ReactNode;
  /** Makes the row a button with a chevron. */
  readonly onPress?: () => void;
  readonly tone?: 'default' | 'danger';
  /** Lets a screen return focus to the row it opened. */
  readonly id?: string;
  readonly className?: string;
}

function ListViewItem({
  label,
  description,
  icon: Icon,
  trailing,
  onPress,
  tone = 'default',
  id,
  className,
}: ListViewItemProps) {
  const body = (
    <>
      {Icon === undefined ? null : (
        <Icon className="crewaid-list-view-icon size-[18px] shrink-0" stroke={1.7} aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-callout font-medium">{label}</span>
        {description === undefined ? null : (
          <span className="block truncate text-caption text-muted">{description}</span>
        )}
      </span>
      {trailing ??
        (onPress === undefined ? null : (
          <IconChevronRight
            className="crewaid-list-view-chevron size-4 shrink-0 rtl:-scale-x-100"
            stroke={1.8}
            aria-hidden
          />
        ))}
    </>
  );
  return (
    <li className={cx('crewaid-list-view-item', className)} data-tone={tone}>
      {onPress === undefined ? (
        <div id={id} className="crewaid-list-view-row">
          {body}
        </div>
      ) : (
        <ButtonPrimitive
          {...(id === undefined ? {} : { id })}
          className="crewaid-list-view-row"
          onPress={onPress}
        >
          {body}
        </ButtonPrimitive>
      )}
    </li>
  );
}

ListView.Item = ListViewItem;
