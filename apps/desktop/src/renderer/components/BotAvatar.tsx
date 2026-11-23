import { Avatar } from '@heroui/react';
import { ClayMascot, type MascotActivity } from '@crewaid/brand/clay';
import { mascotHash } from '@crewaid/brand/mascot';
import type { AvatarShape, Bot, BotStatus } from '@crewaid/shared';

/**
 * BotAvatar — the one place that turns `Bot.avatarColor` (hex, contractual)
 * into an avatar. Used by the sidebar rows, the pinned card, the transcript
 * header, and the right rail caption. Both apps share the clay renderer.
 */

const SIZES = {
  xs: 'size-8',
  collapsed: 'size-[34px]',
  row: 'size-[42px]',
  header: 'size-[52px]',
  sm: 'size-6',
  md: 'size-16',
  lg: 'size-[120px]',
} as const;

/*
 * The silhouettes live in `@crewaid/brand`, beside the logo, because the
 * landing site draws the same characters. Their order is `AvatarShapeSchema`'s
 * order, which is what makes `shapeIndex` below a lookup rather than a
 * mapping table.
 */
const SHAPE_ORDER: readonly AvatarShape[] = [
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
 * What the mascot is doing, as its face shows it.
 *
 * Three states, not five: `BotStatus` distinguishes IDLE from
 * AWAITING_APPROVAL from ERROR, and all three are a bot that is NOT working.
 * The dot beside the name already tells those apart in colour; the face is
 * answering one question — is anything happening right now — and giving it
 * five answers would make the two that matter harder to see.
 */
export type { MascotActivity } from '@crewaid/brand/clay';

export function mascotActivity(status: BotStatus | null | undefined): MascotActivity {
  if (status === 'THINKING') return 'thinking';
  if (status === 'ACTING') return 'acting';
  return 'idle';
}

/** A chosen shape's index, or -1 for a value this build does not know. */
function shapeIndex(shape: AvatarShape): number {
  return SHAPE_ORDER.indexOf(shape);
}

function mascotVariant(name: string): number {
  return mascotHash(name) % SHAPE_ORDER.length;
}

export function MascotFace({
  name,
  color,
  shape,
  activity = 'idle',
  detail = false,
}: {
  name: string;
  color: string;
  shape?: AvatarShape | null | undefined;
  /** What it is doing. Drives the eyes; see `app.css` for the keyframes. */
  activity?: MascotActivity;
  /**
   * Whether there is room for the thinking dots.
   *
   * At 24px a dot is under two pixels — present in the markup, illegible on
   * screen, and close enough to the neighbouring row to read as dirt. The
   * eyes carry the state at every size; the dots are what a large avatar can
   * afford to add.
   */
  detail?: boolean;
}) {
  // A stored shape wins; otherwise derive from the name, which is how every
  // bot looked before `avatarShape` existed and how one still looks until an
  // operator picks. An unrecognised value falls back the same way rather than
  // rendering nothing.
  const chosen = shape === null || shape === undefined ? -1 : shapeIndex(shape);
  const variant = chosen === -1 ? mascotVariant(name) : chosen;
  return (
    <ClayMascot
      name={name}
      color={color}
      variant={variant}
      activity={activity}
      detail={detail}
      className="size-full overflow-visible"
    />
  );
}

/**
 * What the avatar needs. `avatarShape`/`avatarUrl` are optional so an
 * in-progress form draft can be previewed with the same component that draws
 * a stored row.
 */
export type AvatarBot = Pick<Bot, 'name' | 'avatarColor'> &
  Partial<Pick<Bot, 'avatarShape' | 'avatarUrl'>>;

export function BotAvatar({
  bot,
  size = 'sm',
  status,
  detail,
}: {
  bot: AvatarBot;
  size?: keyof typeof SIZES;
  /**
   * Optional because a form draft has no status — a bot being edited
   * is not a bot at work, and the preview should hold still.
   */
  status?: BotStatus | null | undefined;
  /**
   * Force the work ring and the thinking dots on or off.
   *
   * Size decides by default, and that is right for a row in a list. The
   * working indicator is the exception: it is a small avatar that is the ONLY
   * thing on its line, with nothing beside it to collide with, and it is the
   * one place where saying "still going" as loudly as possible is the whole
   * job.
   */
  detail?: boolean | undefined;
}) {
  const uploaded = bot.avatarUrl ?? null;
  // Only the two large sizes have room for the thinking dots; every size gets
  // the eyes.
  const detailed = detail ?? (size === 'md' || size === 'lg');

  return (
    <Avatar
      aria-hidden
      className={`shrink-0 overflow-visible rounded-none bg-transparent ${SIZES[size]}`}
      style={{ backgroundColor: 'transparent' }}
    >
      {/* An uploaded picture supersedes the mascot. There is no upload route
          yet, so in practice this is always the fallback — the branch exists
          so the rule lives in the one component that draws an avatar, rather
          than being retrofitted across every call site later. */}
      {uploaded === null ? null : (
        <Avatar.Image src={uploaded} alt="" className="size-full rounded-full object-cover" />
      )}
      <Avatar.Fallback className="overflow-visible bg-transparent">
        <MascotFace
          name={bot.name}
          color={bot.avatarColor}
          shape={bot.avatarShape}
          activity={mascotActivity(status)}
          detail={detailed}
        />
      </Avatar.Fallback>
    </Avatar>
  );
}
