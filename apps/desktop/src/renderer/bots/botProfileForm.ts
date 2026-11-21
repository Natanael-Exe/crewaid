import type { AvatarShape, Bot, CreateBotBody, UpdateBotBody } from '@crewaid/shared';
import type { ApiFailure } from '../api';
import { t } from '../i18n/i18n';

/**
 * The bot profile form, as pure functions.
 *
 * Both surfaces that write a Bot — the create dialog and the rail's profile
 * pane — share this module, so "what counts as a valid name" is answered once
 * rather than twice with a drift between them. Nothing here touches React or
 * the network; the components own the round trips.
 *
 * The three editable fields map onto PRD §3 columns, not onto the reference
 * app's vocabulary: its "Label" is our `role` and its "Description" is our
 * `systemPrompt`. The labels are cosmetic, the field names are contractual.
 */

export type BotDraft = {
  readonly name: string;
  readonly role: string;
  readonly systemPrompt: string;
  readonly avatarColor: string;
  /** Null until an operator picks one; the mascot is derived from the name. */
  readonly avatarShape: AvatarShape | null;
};

/** The pickable silhouettes, in `AvatarShapeSchema` order. */
export const AVATAR_SHAPES: readonly AvatarShape[] = [
  'circle',
  'square',
  'polygon',
  'egg',
  'bulb',
  'cloud',
  'shield',
  'splat',
];

/**
 * Avatar colours offered by the picker.
 *
 * `Bot.avatarColor` is any `#RRGGBB`, so this list constrains the UI, not the
 * contract — a bot created elsewhere with a colour outside it keeps that
 * colour, and the picker simply shows nothing selected.
 */
export const AVATAR_COLORS = [
  '#e8590c',
  '#f03e3e',
  '#d6336c',
  '#ae3ec9',
  '#4c6ef5',
  '#1098ad',
  '#2f9e44',
  '#8d6e4e',
] as const;

/** Contract limits, restated so the form can refuse before the server does. */
const NAME_MAX = 64;
const ROLE_MAX = 128;

export const NEW_BOT_DRAFT: BotDraft = {
  name: '',
  role: '',
  systemPrompt: '',
  avatarColor: AVATAR_COLORS[4],
  // A new bot has no chosen shape either, so its preview follows the name as
  // it is typed — which is what makes the derived default discoverable.
  avatarShape: null,
};

export function draftFromBot(
  bot: Pick<Bot, 'name' | 'role' | 'systemPrompt' | 'avatarColor' | 'avatarShape'>,
) {
  return {
    name: bot.name,
    role: bot.role,
    systemPrompt: bot.systemPrompt,
    avatarColor: bot.avatarColor,
    avatarShape: bot.avatarShape,
  } satisfies BotDraft;
}

/**
 * The reason this draft cannot be saved, or null.
 *
 * `role` is required because `CreateBotBodySchema` requires it — the reference
 * app marks its equivalent "(optional)", and shipping that label over a
 * required column would turn a validation rule into a server-side surprise.
 */
export function draftIssue(draft: BotDraft): string | null {
  const name = draft.name.trim();
  if (name === '') return t('bots.botProfileForm.nameIsRequired');
  if (name.length > NAME_MAX) return t('bots.nameTooLong', { max: NAME_MAX });

  const role = draft.role.trim();
  if (role === '') return t('bots.botProfileForm.labelIsRequired');
  if (role.length > ROLE_MAX) return t('bots.labelTooLong', { max: ROLE_MAX });

  if (!/^#[0-9a-fA-F]{6}$/.test(draft.avatarColor))
    return t('bots.botProfileForm.pickAnAvatarColour');
  return null;
}

/** True when the draft differs from what is stored. */
export function draftChanged(draft: BotDraft, bot: BotDraft): boolean {
  return (
    draft.name.trim() !== bot.name ||
    draft.role.trim() !== bot.role ||
    draft.systemPrompt !== bot.systemPrompt ||
    draft.avatarColor !== bot.avatarColor ||
    draft.avatarShape !== bot.avatarShape
  );
}

/**
 * Only the fields that actually changed.
 *
 * `PATCH /bots/:id` refuses an empty body, and sending unchanged values would
 * make every save a full overwrite — which loses a concurrent edit from
 * another window for fields the operator never touched.
 */
export function toUpdateBody(draft: BotDraft, bot: BotDraft): UpdateBotBody {
  return {
    ...(draft.name.trim() !== bot.name && { name: draft.name.trim() }),
    ...(draft.role.trim() !== bot.role && { role: draft.role.trim() }),
    ...(draft.systemPrompt !== bot.systemPrompt && { systemPrompt: draft.systemPrompt }),
    ...(draft.avatarColor !== bot.avatarColor && { avatarColor: draft.avatarColor }),
    // `UpdateBotBody` has no null for this field, so clearing a chosen shape
    // is not expressible over REST — the picker offers no "unset" for that
    // reason rather than sending something the contract cannot carry.
    ...(draft.avatarShape !== bot.avatarShape &&
      draft.avatarShape !== null && { avatarShape: draft.avatarShape }),
  };
}

export function toCreateBody(draft: BotDraft): CreateBotBody {
  return {
    name: draft.name.trim(),
    role: draft.role.trim(),
    systemPrompt: draft.systemPrompt,
    avatarColor: draft.avatarColor,
    ...(draft.avatarShape !== null && { avatarShape: draft.avatarShape }),
  };
}

/**
 * What the operator is told when a write fails.
 *
 * `ApiClient` has already stripped the response body, so this maps the codes
 * onto the one thing the operator can act on. NOT_FOUND is phrased as a
 * deletion because that is what it means here: D-010 answers 404 for a
 * foreign row as well as an absent one, and v1 has a single user, so the
 * ambiguity the guard preserves cannot arise in this UI.
 */
export function writeFailureMessage(failure: ApiFailure): string {
  switch (failure.code) {
    case 'CONFIGURATION':
      return t('bots.botProfileForm.thisAppIsNotConnected');
    case 'NETWORK':
      return t('bots.botProfileForm.theServerCouldNotBe');
    case 'UNAUTHORIZED':
      return t('bots.botProfileForm.yourSessionHasEndedSign');
    case 'NOT_FOUND':
      return t('bots.botProfileForm.thisBotNoLongerExists');
    case 'INVALID_REQUEST':
      return t('bots.botProfileForm.someOfTheseValuesWere');
    case 'CONTRACT':
      return t('bots.botProfileForm.theServerSentAnAnswer');
    default:
      return failure.message;
  }
}
