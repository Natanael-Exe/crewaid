import type { ComponentPropsWithRef } from 'react';
import { cx } from './compose';

/**
 * Text that a highlight sweeps across while work is in progress. The sweep
 * lives in components.css (`.crewaid-shimmer`); under reduced motion it is
 * plain text.
 */
export function TextShimmer({ className, ...props }: ComponentPropsWithRef<'span'>) {
  return <span data-slot="text-shimmer" className={cx('crewaid-shimmer', className)} {...props} />;
}
