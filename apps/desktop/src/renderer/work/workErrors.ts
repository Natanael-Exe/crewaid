import { WorkErrorCodeSchema, type WorkErrorCode } from '@crewaid/shared';
import type { ApiFailure } from '../api';
import { t, type PlainKey } from '../i18n/i18n';

/** The server's own body, when it sent one: `{statusCode, code?, message}`. */
function body(failure: ApiFailure): { code?: unknown; message?: unknown } | null {
  if (typeof failure.detail !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(failure.detail);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** The D-134 refusal code a Work route answered with, if it was one. */
export function workErrorCode(failure: ApiFailure): WorkErrorCode | null {
  const parsed = WorkErrorCodeSchema.safeParse(body(failure)?.code);
  return parsed.success ? parsed.data : null;
}

const SENTENCES: Readonly<Record<WorkErrorCode, PlainKey>> = {
  PROJECT_NOT_EMPTY: 'work.error.projectNotEmpty',
  TASK_UNASSIGNED: 'work.error.taskUnassigned',
  TASK_NOT_STARTABLE: 'work.error.taskNotStartable',
  START_KEY_REUSED: 'work.error.startKeyReused',
};

/**
 * What to tell the user when a Work write fails. The server's refusals are
 * written as sentences for exactly this (a subtask cannot move on its own, a
 * task on a goal is in its project), so a 400 or 409 shows the server's own
 * words; everything else shows the client's normalized message.
 */
export function workFailureText(failure: ApiFailure): string {
  const code = workErrorCode(failure);
  if (code !== null) return t(SENTENCES[code]);
  const message = body(failure)?.message;
  if (
    (failure.code === 'INVALID_REQUEST' || failure.code === 'CONFLICT') &&
    typeof message === 'string' &&
    message !== 'Request payload failed schema validation'
  ) {
    return message;
  }
  return failure.message;
}
