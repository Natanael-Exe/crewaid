import { tool } from '../agent/tool-contract.js';
import { NativeToolInputs } from '@crewaid/shared';
import type { Routine } from '@prisma/client';
import type { CreateRoutineBody } from '@crewaid/shared';

import { CONTAINED_BUILTIN, AUTHORITY_BUILTIN } from '../agent/tool-registry.js';
import type { RegisteredTool, ToolContext } from '../agent/tool-registry.js';
import { nextFirings, parseRoutineSchedule } from './routine-schedule.js';

/** What the two tools need from `RoutinesService`, and nothing else. */
export interface BotRoutinesPort {
  create(userId: string, input: CreateRoutineBody, origin: 'BOT'): Promise<Routine>;
  listBotScheduled(userId: string, botId: string): Promise<Routine[]>;
  remove(userId: string, id: string): Promise<void>;
}

/**
 * A bot parks work for later on purpose.
 *
 * M5-BE-19 continues a turn that stopped at a limit; this is the other half
 * of unattended work: "check whether the reply came back tomorrow morning".
 * A routine the bot schedules is an ordinary routine — same scheduler, same
 * runner, same panel — marked `origin: BOT` so the operator can tell it from
 * their own, and bounded by `MAX_BOT_ROUTINES`.
 *
 * Why scheduling asks and cancelling does not
 *
 * `schedule_routine` is `sensitive`: it commits the operator to unattended
 * model calls on a clock, which is exactly "would a careful person want to be
 * asked about this before it happens". `cancel_routine` is `contained`: it
 * can only remove a routine this bot scheduled itself, so the worst it does
 * is undo its own earlier act.
 *
 * Why the result carries the time
 *
 * A model does not know what time it is, and nothing in its prompt says —
 * putting the clock there would break the cached prefix every turn.
 * So the answer to a scheduling call states the current time and the next
 * firings in the routine's own zone. A bot that meant "tomorrow at 9" and
 * wrote a cron that fires tonight reads the mistake in the result and can
 * cancel and reschedule in the same turn.
 */
export function routineTools(deps: BotRoutinesPort, now: () => Date = () => new Date()) {
  const schedule: RegisteredTool = {
    name: 'schedule_routine',
    behavior: AUTHORITY_BUILTIN,
    build: (context: ToolContext) =>
      tool({
        description:
          'Schedule a routine for yourself: a note that will be posted back to you on a ' +
          'schedule, starting a new turn each time — use it to come back to something later ' +
          'on purpose ("check tomorrow at 9 whether the invoice was paid"). It repeats on its ' +
          'cron until cancelled, so for a one-time follow-up pin the day and month and cancel ' +
          'it with cancel_routine once it has done its job. The result tells you the current ' +
          'time and when it will next run; check them. The user can see and delete every ' +
          'routine you schedule.',
        inputSchema: NativeToolInputs.schedule_routine,
        execute: async (input: {
          name: string;
          cron: string;
          timezone?: string | undefined;
          prompt: string;
        }) => {
          try {
            const routine = await deps.create(
              context.userId,
              {
                botId: context.botId,
                name: input.name,
                cron: input.cron,
                ...(input.timezone !== undefined && { timezone: input.timezone }),
                prompt: input.prompt,
              },
              'BOT',
            );
            return scheduledReport(routine, now());
          } catch (error: unknown) {
            const detail = error instanceof Error ? error.message : String(error);
            return `Could not schedule "${input.name}": ${detail}`;
          }
        },
      }),
  };

  const cancel: RegisteredTool = {
    name: 'cancel_routine',
    behavior: CONTAINED_BUILTIN,
    build: (context: ToolContext) =>
      tool({
        description:
          'Cancel a routine you scheduled for yourself with schedule_routine, by its id or its ' +
          'exact name. You can only cancel your own; routines the user set up are theirs.',
        inputSchema: NativeToolInputs.cancel_routine,
        execute: async ({ routine: wanted }: { routine: string }) => {
          const own = await deps.listBotScheduled(context.userId, context.botId);
          const byId = own.find((r) => r.id === wanted);
          const byName = own.filter((r) => r.name === wanted.trim());
          const match = byId ?? (byName.length === 1 ? byName[0] : undefined);
          if (match === undefined) {
            if (byName.length > 1) {
              return (
                `More than one of your routines is called "${wanted}" ` +
                `(${byName.map((r) => r.id).join(', ')}); cancel one by id.`
              );
            }
            return own.length === 0
              ? 'You have no routines of your own to cancel.'
              : `None of your routines is "${wanted}". Yours are: ` +
                  `${own.map((r) => `"${r.name}" (${r.id})`).join(', ')}.`;
          }
          await deps.remove(context.userId, match.id);
          return `Cancelled "${match.name}"; it will not run again.`;
        },
      }),
  };

  return [schedule, cancel];
}

/** The confirmation a scheduling call returns: what, when, and what time it is. */
export function scheduledReport(routine: Routine, now: Date): string {
  const schedule = parseRoutineSchedule(routine.cron, routine.timezone);
  const inZone = (date: Date) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: routine.timezone,
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).format(date);
  const next = nextFirings(schedule, now, 3).map(inZone);
  return (
    `Scheduled "${routine.name}" (${routine.id}) on "${routine.cron}" in ${routine.timezone}. ` +
    `It is now ${inZone(now)}. It will next run: ${next.join('; ')}.`
  );
}
