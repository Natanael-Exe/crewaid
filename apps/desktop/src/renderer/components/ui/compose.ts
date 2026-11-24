import { cn } from '@heroui/react';
import { composeRenderProps } from 'react-aria-components/composeRenderProps';

/** `cn` that always yields a string, for props typed `className: string`. */
export function cx(...parts: Parameters<typeof cn>): string {
  return cn(...parts) ?? '';
}

/**
 * Merge a component's own classes with a caller's `className`, where the
 * caller may pass React Aria's render-prop form (a function of the
 * component's state). Later classes win, so a caller can override.
 */
export function composeTwRenderProps<T>(
  className: string | ((values: T) => string) | undefined,
  own: string,
): string | ((values: T) => string) {
  return composeRenderProps(className, (callerClassName) => cx(own, callerClassName));
}
