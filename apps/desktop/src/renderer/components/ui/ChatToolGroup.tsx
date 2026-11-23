import {
  Disclosure,
  type DisclosureContentProps,
  type DisclosureProps,
  type DisclosureTriggerProps,
} from '@heroui/react';
import { createContext, useContext, type ReactNode } from 'react';
import { composeTwRenderProps } from './compose';
import { TextShimmer } from './TextShimmer';

/**
 * A collapsible run of routine tool calls in the transcript: one quiet line
 * that opens onto the calls, indented under a hairline like a bot's thinking.
 * While the turn is still working the label shimmers, so a folded group never
 * looks finished before it is.
 */

const ActiveContext = createContext(false);

export interface ChatToolGroupRootProps extends DisclosureProps {
  readonly active?: boolean;
}

export function ChatToolGroupRoot({ active = false, className, ...props }: ChatToolGroupRootProps) {
  return (
    <ActiveContext value={active}>
      <Disclosure
        data-slot="chat-tool-group"
        data-active={active || undefined}
        className={composeTwRenderProps(className, 'flex flex-col')}
        {...props}
      />
    </ActiveContext>
  );
}

export interface ChatToolGroupTriggerProps extends Omit<DisclosureTriggerProps, 'children'> {
  readonly children: ReactNode;
}

export function ChatToolGroupTrigger({ children, className, ...props }: ChatToolGroupTriggerProps) {
  const active = useContext(ActiveContext);
  return (
    <Disclosure.Heading>
      <Disclosure.Trigger
        data-slot="chat-tool-group-trigger"
        className={composeTwRenderProps(
          className,
          'inline-flex w-fit items-center gap-1 rounded-md py-0.5 text-caption text-muted outline-none data-[hovered=true]:text-foreground data-[focus-visible=true]:outline-2 data-[focus-visible=true]:outline-focus',
        )}
        {...props}
      >
        <span>{active ? <TextShimmer>{children}</TextShimmer> : children}</span>
        <Disclosure.Indicator className="size-3.5 shrink-0 text-muted" />
      </Disclosure.Trigger>
    </Disclosure.Heading>
  );
}

export interface ChatToolGroupContentProps extends Omit<DisclosureContentProps, 'children'> {
  readonly children: ReactNode;
}

export function ChatToolGroupContent({ children, className, ...props }: ChatToolGroupContentProps) {
  return (
    <Disclosure.Content
      data-slot="chat-tool-group-content"
      className={composeTwRenderProps(className, 'min-w-0')}
      {...props}
    >
      <Disclosure.Body>
        <div className="mt-1 flex flex-col gap-1.5 border-s-2 border-separator ps-2.5">
          {children}
        </div>
      </Disclosure.Body>
    </Disclosure.Content>
  );
}

export const ChatToolGroup = Object.assign(ChatToolGroupRoot, {
  Root: ChatToolGroupRoot,
  Trigger: ChatToolGroupTrigger,
  Content: ChatToolGroupContent,
});
