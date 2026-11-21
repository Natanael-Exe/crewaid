import { Global, Logger, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module.js';
import { redisConnection } from '../common/queue-config.js';
import { TurnEventsModule } from '../agent/turn-events.module.js';
import { AttachmentsController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';
import { AgentAttachmentService } from '../agent/agent-attachment.service.js';
import { AttachmentReaperService } from './reaper.service.js';
import { ARTIFACT_STORE } from './artifact-store.js';
import { createArtifactStore, readArtifactStorage } from './artifact-store.config.js';
import { readEdition } from '../common/edition.config.js';
import { ArtifactReapProcessor } from './artifact-reap.processor.js';
import {
  ARTIFACT_REAP_INTERVAL,
  ARTIFACT_REAP_JOB,
  ARTIFACT_REAP_ON_QUEUE,
  ArtifactReapScheduler,
  describeReapScheduling,
} from './artifact-reap.queue.js';

/**
 * Read once, at definition, because it selects which providers EXIST: with
 * Redis the reap pass is a BullMQ job, without it the reaper keeps
 * its own timer. A zero interval registers no worker in either case.
 */
const reap = describeReapScheduling();
const reapOnQueue = reap.redisUrl !== null;

/**
 * Where artifact bytes live, decided once at boot. A production cloud
 * server without R2, or any server with only some of its keys, refuses to
 * start here rather than at its first upload.
 */
function artifactStoreFactory() {
  const choice = readArtifactStorage(process.env, readEdition(process.env));
  const logger = new Logger('AttachmentsModule');
  if (choice.kind === 'r2') logger.log(`artifacts are stored in R2 bucket ${choice.bucket}`);
  else if (choice.cloudOutsideProduction)
    logger.warn(
      'cloud edition without R2: artifacts go under ARTIFACT_DIR outside production only',
    );
  else logger.log('artifacts are stored under ARTIFACT_DIR');
  return createArtifactStore(choice);
}

/**
 * D-019 upload/download, D-031 retention and capacity, and the D-220 store
 * every artifact reader and writer goes through.
 *
 * The `forRoot` repeated here is deliberate for the reason `InterbotModule`
 * gives: this module must boot on its own, not only when another feature
 * that happens to open the shared connection is loaded.
 */
@Global()
@Module({
  imports: [
    PrismaModule,
    // `AgentAttachmentService` announces a bot-side claim on the §4.2 bus the
    // moment it lands (`message.attachments`), so the bus has to be resolvable
    // where the service is provided. TurnEventsModule is the extracted leaf
    // that owns it — importing it here is the same dependency the turn service
    // declares, not a new one.
    TurnEventsModule,
    ...(reap.redisUrl === null
      ? []
      : [
          BullModule.forRoot({ connection: redisConnection(reap.redisUrl) }),
          BullModule.registerQueue({ name: ARTIFACT_REAP_JOB }),
        ]),
  ],
  controllers: [AttachmentsController],
  providers: [
    { provide: ARTIFACT_STORE, useFactory: artifactStoreFactory },
    AttachmentsService,
    AttachmentReaperService,
    AgentAttachmentService,
    { provide: ARTIFACT_REAP_ON_QUEUE, useValue: reapOnQueue },
    { provide: ARTIFACT_REAP_INTERVAL, useValue: reap.intervalMs },
    ...(reapOnQueue ? [ArtifactReapScheduler] : []),
    ...(reapOnQueue && reap.intervalMs > 0 ? [ArtifactReapProcessor] : []),
  ],
  exports: [ARTIFACT_STORE, AttachmentsService, AttachmentReaperService, AgentAttachmentService],
})
export class AttachmentsModule {}
