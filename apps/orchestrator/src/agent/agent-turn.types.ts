import type { TurnStatus } from '@prisma/client';

/**
 * The turn statuses that mean a bot has a turn in progress.
 *
 * `interrupted` is a turn parked on a person: not using its desktop, so
 * the idle sweep may stop the machine, but very much alive — it
 * holds its trigger and its draft, and it resumes the moment somebody
 * answers. So every question of the form "is this bot working?" — may a new
 * message start a turn, may the chat be cleared, which rows does boot
 * recovery interrupt — must ask about both, and asks here so none of them
 * can drift from the others.
 */
export const LIVE_TURN_STATUSES: readonly TurnStatus[] = ['running', 'interrupted'];
