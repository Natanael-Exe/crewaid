import {
  Button,
  Disclosure,
  type ButtonProps,
  type DisclosureContentProps,
  type DisclosureProps,
} from '@heroui/react';
import { createContext, useContext, type ReactNode } from 'react';
import { composeTwRenderProps } from './compose';
import { TextShimmer } from './TextShimmer';

/**
 * A bot's thinking, folded behind one quiet line. While the bot is still
 * thinking the line shimmers; once settled it is a plain disclosure.
 */

const StreamingContext = createContext(false);

export interface ChainOfThoughtRootProps extends DisclosureProps {
  readonly isStreaming?: boolean;
}

export function ChainOfThoughtRoot({
  className,
  isStreaming = false,
  ...props
}: ChainOfThoughtRootProps) {
  return (
    <StreamingContext value={isStreaming}>
      <Disclosure
        data-slot="chain-of-thought"
        data-streaming={isStreaming || undefined}
        className={composeTwRenderProps(className, 'flex flex-col')}
        {...props}
      />
    </StreamingContext>
  );
}

export interface ChainOfThoughtTriggerProps extends Omit<ButtonProps, 'children'> {
  readonly children: ReactNode;
}

export function ChainOfThoughtTrigger({
  children,
  className,
  ...props
}: ChainOfThoughtTriggerProps) {
  const streaming = useContext(StreamingContext);
  return (
    <Disclosure.Heading>
      <Button
        data-slot="chain-of-thought-trigger"
        slot="trigger"
        variant="ghost"
        size="sm"
        className={composeTwRenderProps(className, 'h-auto min-h-0 w-fit gap-1 rounded-md')}
        {...props}
      >
        {streaming ? <TextShimmer>{children}</TextShimmer> : children}
        <Disclosure.Indicator className="size-3.5 text-muted" />
      </Button>
    </Disclosure.Heading>
  );
}

export interface ChainOfThoughtContentProps extends Omit<DisclosureContentProps, 'children'> {
  readonly children: ReactNode;
}

export function ChainOfThoughtContent({
  children,
  className,
  ...props
}: ChainOfThoughtContentProps) {
  return (
    <Disclosure.Content
      data-slot="chain-of-thought-content"
      className={composeTwRenderProps(className, 'min-w-0')}
      {...props}
    >
      <Disclosure.Body>{children}</Disclosure.Body>
    </Disclosure.Content>
  );
}

export const ChainOfThought = Object.assign(ChainOfThoughtRoot, {
  Root: ChainOfThoughtRoot,
  Trigger: ChainOfThoughtTrigger,
  Content: ChainOfThoughtContent,
});
