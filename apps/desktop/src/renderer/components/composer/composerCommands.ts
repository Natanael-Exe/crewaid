import { activeSlashQuery } from './toolMention';
import { t } from '../../i18n/i18n';

/**
 * Commands the `/` palette runs in the app instead of inserting into the
 * message.
 *
 * A tool mention is TEXT: it travels in the message and the model reads it.
 * A command is an ACTION on the conversation, and nothing about it is sent
 * to the model, so picking one removes what was typed rather than completing
 * it. They share the palette because `/` is where a person already looks for
 * things to do, and they sit above the tools because there are few of them.
 */
export type ComposerCommand = {
  /** What is typed after the slash. */
  readonly name: string;
  readonly label: string;
  readonly summary: string;
};

export const NEW_TOPIC_COMMAND: ComposerCommand = {
  name: 'new',
  get label() {
    return t('composer.command.newTopic');
  },
  get summary() {
    return t('composer.command.newTopic.hint');
  },
};

/** The commands whose name or label starts with what was typed. */
export function filterCommands(
  commands: readonly ComposerCommand[],
  query: string,
): readonly ComposerCommand[] {
  const needle = query.toLowerCase();
  if (needle === '') return commands;
  return commands.filter(
    (command) =>
      command.name.toLowerCase().startsWith(needle) ||
      command.label.toLowerCase().startsWith(needle),
  );
}

/**
 * The draft with the active `/query` taken out, and where the caret goes.
 * Only the token: words typed around it are the operator's and stay.
 */
export function withoutSlashToken(
  draft: string,
  caret: number,
): { readonly draft: string; readonly caret: number } {
  const active = activeSlashQuery(draft, caret);
  if (active === null) return { draft, caret };
  return { draft: `${draft.slice(0, active.start)}${draft.slice(caret)}`, caret: active.start };
}

/**
 * The command a whole draft names, or null. Typing `/new` and pressing Enter
 * with the palette dismissed must still run it: sent as text it would reach
 * the model as a message about nothing.
 */
export function commandOfDraft(
  commands: readonly ComposerCommand[],
  draft: string,
): ComposerCommand | null {
  const trimmed = draft.trim();
  return commands.find((command) => trimmed === `/${command.name}`) ?? null;
}
