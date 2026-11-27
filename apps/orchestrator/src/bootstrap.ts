import { NestFactory } from '@nestjs/core';
import { Logger, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NEST_APP_OPTIONS } from './nest-app-options.js';
import { TaskStartService } from './work/task-start.service.js';
import { RecordingsService } from './recordings/recordings.service.js';
import { SkillRunService } from './skills/skill-run.service.js';
import { ChatSendService } from './chat/chat-send.service.js';
import { describeQueueConfig } from './skills/skill-compile.queue.js';
import { CrewaidWsAdapter } from './ws/crewaid-ws.adapter.js';
import { StructuredLogger } from './logging/structured-logger.js';
import { messageKeyring } from './credentials/message-cipher.js';
import { sealStoredMessages } from './messages/seal-stored-messages.js';
import { createPrismaClient } from './prisma/prisma-client.factory.js';

/**
 * Boots an orchestrator around `rootModule`: `AppModule` from `main.ts`, or
 * `CloudAppModule` from `ee/main.ts` (D-238). One startup path for both, so the
 * recovery sweeps below cannot drift between the editions.
 *
 * Global prefix: REST mounts everything under /api/v1. `/health` is registered
 * without the prefix (liveness probes target the bare path) and is guard-exempt.
 *
 * WS: WebSocket single endpoint at /ws with ?token= — CrewaidWsAdapter's ws
 * verifyClient hook rejects bad/missing credentials with HTTP 401 during the
 * Upgrade, before a socket is established. The gateway keeps a defense-in-depth
 * check for nonstandard adapters.
 *
 * Multer upload limits ({ fileSize: 25 MiB, files: 5 }) are deliberate
 * config on the FileInterceptor, and MulterErrorFilter maps limit violations
 * to 413 — never the library-default 400.
 *
 * dist/ is the only supported boot path: `tsx src/main.ts` runs esbuild,
 * which emits no design:paramtypes, so Nest DI fails at bootstrap (500 on
 * every route). Build with tsc, run `node dist/main.js`.
 */
export async function bootstrap(rootModule: Type<unknown>): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(rootModule, NEST_APP_OPTIONS);
  app.useLogger(app.get(StructuredLogger));
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.useWebSocketAdapter(new CrewaidWsAdapter(app, app.get(StructuredLogger)));
  app.enableShutdownHooks();
  // A Start brief committed just before the last process died has no
  // turn yet.
  await app.get(TaskStartService).recoverPendingStarts();
  // A RECORDING row whose tee died with the last process captures nothing
  // and still counts as work to the idle sweep, so it would pin that bot's
  // container open for this process's whole life.
  await app.get(RecordingsService).recoverInterruptedRecordings();

  // A PENDING/RUNNING skill run is claimed in memory and executed by this
  // process alone, and — unlike a recording — §8 does not count its row as
  // work, so nothing else would ever revisit it. Left alone it says RUNNING
  // forever; the sweep settles it FAILED with the reason.
  await app.get(SkillRunService).recoverInterruptedRuns();

  // An AGENT_TURN whose producer died mid-flight stays `running` holding the
  // one-active-run fence: every later message is refused RUN_BUSY and every
  // queued trigger deferred behind a run that will never answer. The
  // expired-lease sweep claims those rows and resumes their owned producer.
  // Keep sweeping: a quick restart can precede the dead worker's lease expiry.
  await app.get(ChatSendService).startRecovery();

  // The `skill.compile` queue and worker are wired by `SkillsModule`, and
  // BullModule closes both through `enableShutdownHooks` above. Said once here
  // rather than discovered per recording: everything else in the orchestrator
  // works without Redis, and an operator should learn that this feature does
  // not before they teach a task rather than from a failed recording.
  const bootLogger = new Logger('Bootstrap');
  const compiles = describeQueueConfig();
  if (compiles.redisUrl === null) {
    bootLogger.warn('REDIS_URL is not set: recordings will not compile into skills');
  } else if (!compiles.workerEnabled) {
    bootLogger.warn(
      'SKILL_COMPILE_WORKER is false: this process queues compiles but runs none of them',
    );
  }

  // A `COMPILING` row left by a previous process has no job behind it until
  // one is added again, so the sweep re-queues them — or settles the ones the
  // queue refuses FAILED, with the refusal as the reason.
  // Deliberately not awaited: the sweep talks to Redis, and a queue that is
  // slow to come up must not hold the whole orchestrator at the door — every
  // other feature works without Redis. It finishes when Redis answers.
  void app
    .get(RecordingsService)
    .recoverStrandedCompilations()
    .catch((error: unknown) => {
      bootLogger.error(
        `stranded compile recovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

  // New messages are sealed as they are written. Rows from before that,
  // or still under a key since rotated out, are sealed here, so the promise
  // holds for what was already stored without an operator step. Not awaited,
  // like the sweep above: it reads the whole backlog once, and each row is
  // replaced only if it still holds what was read. Its own client, because it
  // has to see what is stored rather than what the sealing client would open.
  const sealing = messageKeyring();
  if (sealing !== null) {
    const stored = createPrismaClient();
    void sealStoredMessages(stored, sealing)
      .then((sealed) => {
        if (sealed.messages + sealed.runEvents > 0) {
          bootLogger.log(
            `sealed ${String(sealed.messages)} stored message(s) and ${String(sealed.runEvents)} run event(s)`,
          );
        }
        if (sealed.unreadable > 0) {
          bootLogger.error(
            `${String(sealed.unreadable)} stored row(s) are sealed under a key that is not in CREWAID_CREDENTIAL_KEYRING`,
          );
        }
      })
      .catch((error: unknown) => {
        bootLogger.error(
          `sealing stored messages failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => void stored.$disconnect());
  }

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port);
  bootLogger.log(`Orchestrator listening on :${port}`);
}
