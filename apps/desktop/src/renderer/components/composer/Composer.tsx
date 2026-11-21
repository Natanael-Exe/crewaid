import type { ApprovalMode } from '@crewaid/shared';
import { Button, Tooltip } from '@heroui/react';
import { IconArrowUp, IconSquareFilled } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ToolInfo } from '@crewaid/shared';
import { AttachButton, ComposerDropZone } from '../attachments/AttachmentDropZone';
import { claimableIds, type PendingAttachment } from '../attachments/attachmentState';
import { PendingAttachmentRow } from '../attachments/PendingAttachmentChip';
import { shouldSubmitOnEnter, useAutoGrow } from './autoGrow';
import { useComposerLayout } from './composerLayout';
import {
  botSwitched,
  type ComposerState,
  canSend,
  draftChanged,
  send,
  stop,
} from './composerState';
import { ApprovalModeMenu } from './ApprovalModeMenu';
import { ModelPicker } from './ModelPicker';
import { QueuedMessageList } from './QueuedMessageRow';
import type { QueuedMessage } from '../../state/messageQueue';
import { ToolPalette } from './ToolPalette';
import { useVoiceCapture, type ComposerVoice } from './useVoiceCapture';
import {
  DictationButton,
  VoiceError,
  VoiceMessageButton,
  VoiceMessageStrip,
} from './VoiceControls';
import { activeSlashQuery, applyToolMention, filterTools } from './toolMention';
import {
  NEW_TOPIC_COMMAND,
  commandOfDraft,
  filterCommands,
  withoutSlashToken,
  type ComposerCommand,
} from './composerCommands';
import { BotPalette } from './BotPalette';
import {
  activeBotQuery,
  applyBotMention,
  completedBotMention,
  filterBots,
  isAfterCompletedBotMention,
  type CompletedBotMention,
  type MentionBot,
} from './botMention';
import { useT } from '../../i18n/i18n';

/**
 * Composer — M1-FE-07 + M1-FE-08.
 *
 * Pill per ref-01: `+` attach at left inside, auto-growing textarea, black
 * circular send/stop at right inside. In the idle+empty state that circle
 * records a voice message instead, in the same place and size, so the
 * layout never shifts; dictation sits beside the send/stop control.
 *
 * M1-FE-08 additions: the pill sits inside a DropZone (drop anywhere on it
 * to stage files), the `+` opens the OS picker via FileTrigger, and staged
 * uploads render as chips above the pill. Ready uploads are claimed by the
 * next send via attachmentIds; failed uploads offer Retry.
 *
 * M1-FE-10's model picker sits in the pill's control cluster, right of the
 * draft and left of send/stop.
 *
 * Row layout: one row while the draft fits beside the controls, two rows once
 * it would wrap — the textarea takes a full-width row and `+` / picker / send
 * drop beneath it. The switch is measured (composerLayout.ts) and driven by
 * CSS grid areas, so it re-flows on sidebar/rail resizes and never re-mounts
 * the textarea.
 *
 * All buttons are HeroUI Button (PO requirement 1) — no hand-rolled
 * <button> remains. Auto-grow stays hand-rolled: HeroUI TextArea has no
 * auto-grow (verified M1-FE-02).
 */
export function Composer({
  botId,
  botModelId,
  botApprovalMode,
  onApprovalModeChanged,
  botName,
  streaming,
  queued,
  onQueue,
  onEditQueued,
  onRemoveQueued,
  onSendQueuedNow,
  onMoveQueued,
  pending,
  onSend,
  onStop,
  onNewTopic,
  onFiles,
  onRemovePending,
  onRetryPending,
  onModelChanged,
  tools,
  bots,
  catalogVersion,
  voice,
  seed,
  placeholder,
}: {
  botId: string;
  botModelId: string;
  /** How this bot's actions are approved, as stored on the bot. */
  botApprovalMode: ApprovalMode;
  /** After a new mode is saved, so the shell can re-read the bot. */
  onApprovalModeChanged?: (() => void) | undefined;
  botName: string;
  streaming: boolean;
  /**
   * What is waiting to be sent when this turn ends. Rendered above the
   * pill; the composer itself only knows how to add to it.
   */
  queued?: readonly QueuedMessage[] | undefined;
  onQueue?: ((text: string, attachmentIds: string[]) => void) | undefined;
  onEditQueued?: ((localId: string, text: string) => void) | undefined;
  onRemoveQueued?: ((localId: string) => void) | undefined;
  onSendQueuedNow?: ((localId: string) => void) | undefined;
  onMoveQueued?: ((from: number, to: number) => void) | undefined;
  /** Staged uploads (chips row). Empty in seed-only mode. */
  pending: PendingAttachment[];
  onSend: (text: string, attachmentIds: string[]) => void;
  onStop: () => void;
  /**
   * `/new`. Runs in the app with no model call; absent, the palette
   * does not offer it and `/new` is ordinary text.
   */
  onNewTopic?: (() => void) | undefined;
  onFiles: (files: File[]) => void;
  onRemovePending: (localId: string) => void;
  onRetryPending: (localId: string) => void;
  /** The picker already wrote `Bot.modelId`; the shell re-reads the row. */
  onModelChanged?: (() => void) | undefined;
  /**
   * The orchestrator's tool directory (GET /tools), for the `/` palette.
   * Optional so the composer degrades to a plain text box when the directory
   * could not be read — typing `/` then just types a slash.
   */
  tools?: readonly ToolInfo[] | undefined;
  /** Other bots on the team, for the `@` picker. */
  bots?: readonly MentionBot[] | undefined;
  /**
   * Bumped when settings closes — the model catalog is edited behind that
   * modal, and the picker's mount-time read must not outlive the edit.
   */
  catalogVersion?: number | undefined;
  /**
   * Dictation and voice messages. Absent where there is no account to
   * listen with, which leaves the voice-message circle disabled in its slot.
   */
  voice?: ComposerVoice | undefined;
  /**
   * Text placed in the box for the person to edit and send, such as a
   * welcome example. Each new `nonce` replaces the draft and focuses it; it is
   * never sent on its own.
   */
  seed?: { readonly text: string; readonly nonce: number } | null | undefined;
  /** Replaces "Message {bot}" where the moment calls for a warmer prompt. */
  placeholder?: string | undefined;
}) {
  const t = useT();
  // Seed-era state machine instance; M1-FE-06 replaces `streaming` with real
  // bot status, but the transitions stay identical.
  const [state, setState] = useState<ComposerState>(() => ({
    mode: streaming ? 'active' : 'idle',
    draft: '',
  }));

  const [taRef] = useAutoGrow(state.draft);

  useEffect(() => {
    if (!seed) return;
    setState((current) => (seed.text === '' ? current : draftChanged(current, seed.text)));
    taRef.current?.focus();
    // Keyed on the nonce alone: the same example chosen twice is two requests.
  }, [seed?.nonce]);

  // Dictated words land at the caret, like typing them would.
  const insertDictation = useCallback(
    (text: string) => {
      const textarea = taRef.current;
      setState((current) => {
        const caret = textarea?.selectionEnd ?? current.draft.length;
        const before = current.draft.slice(0, caret);
        const after = current.draft.slice(caret);
        const lead = before === '' || /\s$/.test(before) ? '' : ' ';
        const trail = after === '' || /^\s/.test(after) ? '' : ' ';
        pendingCaret.current = caret + lead.length + text.length;
        return draftChanged(current, `${before}${lead}${text}${trail}${after}`);
      });
      textarea?.focus();
    },
    [taRef],
  );
  const capture = useVoiceCapture(voice, insertDictation);
  const recordingMessage = capture.purpose === 'message';
  // Runs after useAutoGrow so the width probe restores the height auto-grow
  // just applied (see composerLayout.ts).
  const { pillRef, attachRef, controlsRef, stacked } = useComposerLayout(state.draft, taRef);

  // ── The `/` tool and `@` bot palettes ─────────────────────────────────────
  //
  // Open while the caret sits in a `/token` (see toolMention.ts). The query
  // and its position are kept, not recomputed on every render, so a re-render
  // that did not move the caret cannot close or re-anchor the palette under
  // the operator.
  const [palette, setPalette] = useState<{
    readonly kind: 'tool' | 'bot';
    readonly query: string;
    readonly start: number;
    readonly selected: number;
  } | null>(null);
  const commands = useMemo<readonly ComposerCommand[]>(
    () => (onNewTopic === undefined ? [] : [NEW_TOPIC_COMMAND]),
    [onNewTopic],
  );
  const matchingCommands = palette?.kind !== 'tool' ? [] : filterCommands(commands, palette.query);
  const matchingTools =
    palette?.kind !== 'tool' || tools === undefined ? [] : filterTools(tools, palette.query);
  const matchingBots =
    palette?.kind !== 'bot' || bots === undefined ? [] : filterBots(bots, palette.query);
  const pendingCaret = useRef<number | null>(null);
  // A picked mention ends at its trailing space. Without remembering that
  // boundary, the next keystroke reparses `@John hello` as one ever-growing
  // bot query and reopens the palette with no matches.
  const completedMention = useRef<CompletedBotMention | null>(null);

  const refreshPalette = useCallback(
    (draft: string, caret: number) => {
      const slash = activeSlashQuery(draft, caret);
      const mention = activeBotQuery(draft, caret);
      const completed = completedMention.current;
      if (slash === null && isAfterCompletedBotMention(draft, caret, mention, completed)) {
        setPalette(null);
        return;
      }
      // Editing the inserted token itself makes it a query again.
      if (completed !== null && draft.slice(completed.start, completed.end) !== completed.value) {
        completedMention.current = null;
      }
      const active = slash ?? mention;
      const kind = slash !== null ? 'tool' : 'bot';
      // The `/` palette opens for commands alone too, so `/new` works in a
      // shell whose tool directory could not be read.
      const available =
        kind === 'tool' ? (tools?.length ?? 0) + commands.length : (bots?.length ?? 0);
      if (active === null || available === 0) {
        setPalette(null);
        return;
      }
      setPalette((current) =>
        current !== null &&
        current.kind === kind &&
        current.query === active.query &&
        current.start === active.start
          ? current
          : { kind, query: active.query, start: active.start, selected: 0 },
      );
    },
    [bots, commands, tools],
  );

  // The pick lands after the state update: the caret is placed once React has
  // committed the new draft, so the operator keeps typing mid-sentence.
  useEffect(() => {
    if (pendingCaret.current === null) return;
    const textarea = taRef.current;
    if (textarea !== null) {
      textarea.selectionStart = pendingCaret.current;
      textarea.selectionEnd = pendingCaret.current;
    }
    pendingCaret.current = null;
  }, [state.draft, taRef]);

  // A press anywhere except the palette itself dismisses it — Escape and
  // Enter are the keyboard ways out, this is the pointer one. Presses inside
  // the pill are left to the caret logic above: clicking back into the
  // `/token` keeps the palette, moving the caret out of it closes it.
  const paletteOpen = palette !== null;
  useEffect(() => {
    if (!paletteOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target instanceof Element && target.closest('[data-tool-palette], [data-bot-palette]'))
        return;
      if (pillRef.current?.contains(target)) return;
      setPalette(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [paletteOpen, pillRef]);

  const pickTool = useCallback(
    (tool: ToolInfo) => {
      const textarea = taRef.current;
      const caret = textarea?.selectionStart ?? state.draft.length;
      // The ALIAS goes into the message — what the palette showed is what the
      // operator reads back; the orchestrator resolves it to the tool.
      const applied = applyToolMention(state.draft, caret, tool.alias);
      setState((current) => draftChanged(current, applied.draft));
      pendingCaret.current = applied.caret;
      setPalette(null);
    },
    [state.draft, taRef],
  );

  /** A command acts; the `/token` that named it is removed, not completed. */
  const runCommand = useCallback(
    (command: ComposerCommand) => {
      const textarea = taRef.current;
      const caret = textarea?.selectionStart ?? state.draft.length;
      const applied = withoutSlashToken(state.draft, caret);
      setState((current) => draftChanged(current, applied.draft));
      pendingCaret.current = applied.caret;
      setPalette(null);
      if (command.name === NEW_TOPIC_COMMAND.name) onNewTopic?.();
    },
    [onNewTopic, state.draft, taRef],
  );

  const pickBot = useCallback(
    (bot: MentionBot) => {
      const textarea = taRef.current;
      const caret = textarea?.selectionStart ?? state.draft.length;
      const applied = applyBotMention(state.draft, caret, bot.name);
      completedMention.current = completedBotMention(bot.name, applied.caret);
      setState((current) => draftChanged(current, applied.draft));
      pendingCaret.current = applied.caret;
      setPalette(null);
    },
    [state.draft, taRef],
  );

  // V1-13: the picker has already written `Bot.modelId` by the time this
  // fires, so the only thing left to do is let the shell re-read the row.
  // Keeping a copy here is what made two writers possible.
  const handleModelChange = useCallback(() => {
    onModelChanged?.();
  }, [onModelChanged]);

  // Keep the machine honest if the parent-driven streaming flag changes
  // (bot switch, completed turn).
  if (streaming !== (state.mode === 'active')) {
    setState(botSwitched(state, streaming));
  }

  // D-022: the send gate accepts text OR ≥1 ready attachment; the shared
  // schema's refine enforces the same rule server-side. The empty-nothing
  // case never reaches the network.
  const readyIds = claimableIds(Object.fromEntries(pending.map((p) => [p.localId, p])));

  /**
   * CC-45. While the bot is working, a draft is QUEUED rather than sent.
   *
   * The server would take it — it defers a message that arrives mid-turn and
   * answers it when the current one settles (M5-BE-16) — and that is exactly
   * what makes queueing here worth doing: a posted message is already in the
   * transcript and in the model's next prompt, so "wait, not like that" stops
   * being expressible. Held on this side it can still be edited, dropped or
   * reordered, and `Send now` on the row is how an operator opts into the
   * server's deferral deliberately.
   */
  /**
   * Whether a new draft joins the queue instead of going straight out.
   *
   * It is not simply "is the bot busy". A queue that still has items in it
   * IS the order, right up until it empties: the drain posts one message per
   * turn, so between the turn ending and the next one starting there is a
   * moment when the bot looks idle and two messages are outstanding. Sending
   * directly in that window would put the new message ahead of ones typed
   * before it.
   */
  const queueing = onQueue !== undefined && (state.mode === 'active' || (queued?.length ?? 0) > 0);

  const submit = () => {
    const text = state.draft.trim();
    // Before the queue: `/new` typed during a turn is an instruction to the
    // app, not a message to hold until the bot is free.
    const command = readyIds.length === 0 ? commandOfDraft(commands, text) : null;
    if (command !== null) {
      setState((current) => draftChanged(current, ''));
      if (command.name === NEW_TOPIC_COMMAND.name) onNewTopic?.();
      return;
    }
    if (queueing) {
      if (text === '' && readyIds.length === 0) return;
      onQueue(text, readyIds);
      setState((current) => draftChanged(current, ''));
      return;
    }
    const next = send(state, readyIds.length > 0);
    if (!next) return;
    setState(next);
    const pill = pillRef.current;
    if (
      pill !== null &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
      pill.closest('[data-reduce-motion="true"]') === null
    ) {
      for (const animation of pill.getAnimations()) animation.cancel();
      const duration =
        Number.parseFloat(getComputedStyle(pill).getPropertyValue('--motion-enter')) || 220;
      pill.animate(
        [
          { transform: 'translateY(0)' },
          { transform: 'translateY(1px)', offset: 0.35 },
          { transform: 'translateY(0)' },
        ],
        { duration, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    }
    onSend(text, readyIds);
  };

  const handleStop = () => {
    setState(stop(state));
    onStop();
  };

  return (
    <div className="mx-auto w-full max-w-[900px]">
      <QueuedMessageList
        items={queued ?? []}
        onEdit={(localId, text) => onEditQueued?.(localId, text)}
        onRemove={(localId) => onRemoveQueued?.(localId)}
        onSendNow={(localId) => onSendQueuedNow?.(localId)}
        onMove={(from, to) => onMoveQueued?.(from, to)}
      />
      <PendingAttachmentRow items={pending} onRemove={onRemovePending} onRetry={onRetryPending} />
      <ComposerDropZone onFiles={onFiles}>
        <div className="relative">
          {palette?.kind === 'tool' ? (
            <ToolPalette
              commands={matchingCommands}
              tools={matchingTools}
              selected={palette.selected}
              onPickCommand={runCommand}
              onPick={pickTool}
              onSelectedChanged={(index) => setPalette({ ...palette, selected: index })}
            />
          ) : palette?.kind === 'bot' ? (
            <BotPalette
              bots={matchingBots}
              selected={palette.selected}
              onPick={pickBot}
              onSelectedChanged={(index) => setPalette({ ...palette, selected: index })}
            />
          ) : null}
          <div
            ref={pillRef}
            data-composer-stacked={stacked || undefined}
            className={`crewaid-composer-pill gap-2.5 border border-field-border bg-surface ps-4 pe-2 py-2 ${
              // `rounded-full` resolves to half the height, so a stacked pill
              // would bow its corners into the text. 23px is the inline pill's
              // own radius (36px picker trigger + py-1 + border = 46px tall),
              // which keeps the corner curvature identical across the switch.
              stacked ? 'rounded-[23px]' : 'rounded-full'
            }`}
          >
            <div ref={attachRef} data-composer-slot="attach" className="flex items-center">
              <AttachButton onFiles={onFiles} />
              <ApprovalModeMenu
                key={botId}
                botId={botId}
                mode={botApprovalMode}
                onModeChange={onApprovalModeChanged}
              />
            </div>
            {/* One line is 7 + 22 + 7 = 36px, the height of the row the model
                picker sets. The pill aligns its slots to the bottom so a long
                draft grows upward, and at 36px a single line's text sits on
                the row's centre line with the icons beside it. */}
            <VoiceMessageStrip capture={capture} />
            <textarea
              dir="auto"
              data-composer-slot={recordingMessage ? undefined : 'text'}
              hidden={recordingMessage}
              ref={taRef}
              aria-label={t('composer.message', { bot: botName })}
              placeholder={
                queueing
                  ? t('composer.queueing')
                  : (placeholder ?? t('composer.message', { bot: botName }))
              }
              rows={1}
              value={state.draft}
              onChange={(e) => {
                const next = e.target.value;
                const caret = e.target.selectionStart ?? next.length;
                setState((s) => draftChanged(s, next));
                refreshPalette(next, caret);
              }}
              onSelect={(e) => {
                // Moving the caret with arrows (palette closed) re-evaluates the
                // query, so landing back inside a `/token` reopens the palette.
                const caret = e.currentTarget.selectionStart ?? state.draft.length;
                refreshPalette(state.draft, caret);
              }}
              onKeyDown={(e) => {
                // The palette owns navigation keys while it is open — the same
                // keys the pill would otherwise read as "submit" or "nothing".
                if (palette !== null) {
                  const count =
                    palette.kind === 'tool'
                      ? matchingCommands.length + matchingTools.length
                      : matchingBots.length;
                  if (e.key === 'ArrowDown' && count > 0) {
                    e.preventDefault();
                    setPalette({ ...palette, selected: (palette.selected + 1) % count });
                    return;
                  }
                  if (e.key === 'ArrowUp' && count > 0) {
                    e.preventDefault();
                    setPalette({
                      ...palette,
                      selected: (palette.selected - 1 + count) % count,
                    });
                    return;
                  }
                  if ((e.key === 'Enter' || e.key === 'Tab') && count > 0) {
                    e.preventDefault();
                    if (palette.kind === 'tool') {
                      const command = matchingCommands[palette.selected];
                      const picked = matchingTools[palette.selected - matchingCommands.length];
                      if (command !== undefined) runCommand(command);
                      else if (picked !== undefined) pickTool(picked);
                    } else {
                      const picked = matchingBots[palette.selected];
                      if (picked !== undefined) pickBot(picked);
                    }
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setPalette(null);
                    return;
                  }
                }
                if (shouldSubmitOnEnter(e.nativeEvent)) {
                  e.preventDefault();
                  // CC-45: Enter during a turn queues instead of doing nothing,
                  // which is what it did before — the keystroke was swallowed
                  // and the draft just sat there.
                  if (state.mode === 'idle' || queueing) submit();
                }
              }}
              className="max-h-[160px] min-h-[24px] min-w-0 resize-none overflow-hidden bg-transparent px-1 py-[7px] text-[14px] leading-[22px] text-field-foreground outline-none placeholder:text-field-placeholder"
            />
            <div
              ref={controlsRef}
              data-composer-slot="controls"
              className="flex min-w-0 items-center gap-1"
            >
              <ModelPicker
                key={botId}
                botId={botId}
                botModelId={botModelId}
                catalogVersion={catalogVersion}
                onModelChange={handleModelChange}
              />
              <DictationButton voice={voice} capture={capture} />
              {recordingMessage ? (
                <VoiceMessageButton voice={voice} capture={capture} />
              ) : state.mode === 'active' ? (
                <Tooltip>
                  <Tooltip.Trigger>
                    <Button
                      variant="primary"
                      isIconOnly
                      aria-label={t('composer.stop')}
                      onPress={handleStop}
                      className="crewaid-compose-action me-0.5 size-8 shrink-0 rounded-full"
                    >
                      <IconSquareFilled className="size-4" />
                    </Button>
                  </Tooltip.Trigger>
                  <Tooltip.Content>{t('composer.stop.hint')}</Tooltip.Content>
                </Tooltip>
              ) : canSend(state, readyIds.length > 0) ? (
                <Tooltip>
                  <Tooltip.Trigger>
                    <Button
                      variant="primary"
                      isIconOnly
                      aria-label={t('composer.send')}
                      onPress={submit}
                      className="crewaid-compose-action me-0.5 size-8 shrink-0 rounded-full"
                    >
                      <IconArrowUp className="size-4" stroke={1.8} />
                    </Button>
                  </Tooltip.Trigger>
                  <Tooltip.Content>{t('composer.send.hint')}</Tooltip.Content>
                </Tooltip>
              ) : (
                <VoiceMessageButton voice={voice} capture={capture} />
              )}
            </div>
          </div>
        </div>
      </ComposerDropZone>
      <VoiceError capture={capture} />
    </div>
  );
}
