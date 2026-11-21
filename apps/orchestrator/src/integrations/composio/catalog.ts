/**
 * The curation overlay over the deployment's live Composio catalog.
 *
 * The directory itself is the vendor's, listed through the SDK and cached in
 * `ComposioService`; this file carries only what review has added on top of
 * it. D-202 pinned three apps because every offered tool had been read by
 * name — its read/write split drove the session grant and the approval
 * matcher. The catalog an account can install is hundreds of toolkits nobody
 * here has read, so the reviewed lists survive as an overlay rather than a
 * gate: where one exists it still pins the session grant and vouches for its
 * read-only tools; where one does not, the vendor's own `readOnlyHint`
 * behavior tag classifies the tool, and a tool with neither uses the bot's
 * external-action approval policy.
 *
 * An overlay entry carries no auth material and no env var name. Provisioning
 * moved into the install path (`use_composio_managed_auth`), so the
 * deployment supplies exactly one Composio variable — its API key — and an
 * auth config id lives in the `ComposioConnection` row it belongs to.
 */

/** What review has said about one vendor toolkit. */
export type ComposioCuration = {
  /** The vendor toolkit slug this entry curates. */
  readonly toolkit: string;
  /**
   * The exact tool grant the vendor session is pinned to, set-equality
   * enforced. Absent for an unreviewed toolkit: its session enables the
   * toolkit as a whole, vendor-side.
   */
  readonly enabledTools: readonly string[];
  /** The subset of `enabledTools` reviewed as read-only — they do not ask. */
  readonly readTools: readonly string[];
};

function curated(
  toolkit: string,
  readTools: readonly string[],
  writeTools: readonly string[],
): ComposioCuration {
  return { toolkit, enabledTools: [...readTools, ...writeTools], readTools };
}

/** The pilots, carried forward verbatim as the overlay. */
export const COMPOSIO_CURATION: readonly ComposioCuration[] = [
  curated(
    'gmail',
    [
      'GMAIL_FETCH_EMAILS',
      'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
      'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
      'GMAIL_GET_PROFILE',
      'GMAIL_GET_DRAFT',
      'GMAIL_LIST_DRAFTS',
    ],
    [
      'GMAIL_CREATE_EMAIL_DRAFT',
      'GMAIL_UPDATE_DRAFT',
      'GMAIL_SEND_DRAFT',
      'GMAIL_SEND_EMAIL',
      'GMAIL_REPLY_TO_THREAD',
    ],
  ),
  curated(
    'googlecalendar',
    [
      'GOOGLECALENDAR_LIST_CALENDARS',
      'GOOGLECALENDAR_EVENTS_LIST',
      'GOOGLECALENDAR_EVENTS_GET',
      'GOOGLECALENDAR_FREE_BUSY_QUERY',
    ],
    ['GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_PATCH_EVENT', 'GOOGLECALENDAR_DELETE_EVENT'],
  ),
  curated(
    'slack',
    [
      'SLACK_LIST_CONVERSATIONS',
      'SLACK_FETCH_CONVERSATION_HISTORY',
      'SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION',
      'SLACK_SEARCH_MESSAGES',
      'SLACK_RETRIEVE_DETAILED_USER_INFORMATION',
    ],
    ['SLACK_SEND_MESSAGE'],
  ),
];

/** The overlay for a toolkit, or undefined — "unreviewed" is a normal state. */
export function curationFor(toolkit: string): ComposioCuration | undefined {
  return COMPOSIO_CURATION.find((item) => item.toolkit === toolkit);
}

/** Explicit environment only: never inherit an SDK CLI login or organization key. */
export function composioConfiguration(env: NodeJS.ProcessEnv = process.env) {
  return { apiKey: env['COMPOSIO_API_KEY']?.trim() ?? '' };
}
