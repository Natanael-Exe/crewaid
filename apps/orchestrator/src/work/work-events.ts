import { Inject, Injectable, Logger } from '@nestjs/common';
import { TurnEventBus } from '../agent/turn-event.bus.js';

/**
 * The four Work invalidations, announced after the write commits, to
 * the windows of the user who owns the record and nobody else's.
 *
 * Observational: the rows are durable either way, and a window that missed a
 * frame refetches after it reconnects. So nothing here may throw into the
 * request that caused it — a frame that cannot be built is logged and dropped,
 * the rule `TurnEventBus` already applies to every other frame.
 */
@Injectable()
export class WorkEvents {
  private readonly logger = new Logger(WorkEvents.name);

  constructor(@Inject(TurnEventBus) private readonly bus: TurnEventBus) {}

  task(userId: string, taskId: string, deleted = false): void {
    this.send(userId, 'task.changed', { taskId, ...(deleted && { deleted: true }) });
  }

  project(userId: string, projectId: string, deleted = false): void {
    this.send(userId, 'project.changed', { projectId, ...(deleted && { deleted: true }) });
  }

  goal(userId: string, goalId: string, deleted = false): void {
    this.send(userId, 'goal.changed', { goalId, ...(deleted && { deleted: true }) });
  }

  deliverable(userId: string, deliverableId: string, deleted = false): void {
    this.send(userId, 'deliverable.changed', { deliverableId, ...(deleted && { deleted: true }) });
  }

  private send(
    userId: string,
    type: 'task.changed' | 'project.changed' | 'goal.changed' | 'deliverable.changed',
    payload: Record<string, unknown>,
  ): void {
    try {
      this.bus.emitWorkChanged(userId, type, payload);
    } catch (error) {
      this.logger.warn(
        `${type} could not be announced: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
