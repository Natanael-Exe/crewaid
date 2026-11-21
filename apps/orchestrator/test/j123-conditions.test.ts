import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Principal } from '@crewaid/shared';
import { AttachmentsService } from '../src/attachments/attachments.service.js';
import { UNCLAIMED_TTL_MS } from '../src/attachments/attachments.controller.js';
import { BotsService } from '../src/bots/bots.service.js';
import { MessagesService } from '../src/messages/messages.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn } from './auth-fixture.js';

/**
 * Attachment ownership, multipart limit, and TTL invariants:
 *
 * J1 — attachment ownership from creation. The IDOR chain under
 *   test: user B binds user A's unclaimed upload to B's message and
 *   downloads A's file. Every step of that chain must now fail.
 * J2 — composite-cursor pagination went with the §4.1 history route (D-199);
 *   a thread is read through the chat route's hydrate, in sequence order.
 * J3 — D-020 addendum fences: DELETE answers 409 on claimed, 410 past the
 *   interim TTL, 204 on a fresh unclaimed row (and removes the artifact).
 *
 * Checked out feat/m1-be-j123-fixes; runs against real Postgres.
 */
const DATABASE_URL = process.env['DATABASE_URL'];

/** Whoever this suite signs in as — the principal every HTTP request resolves to. */
let USER_A: string;
const USER_B = 'usr_intruder_b';

/** Bearer token the suite's AuthGuard is configured with (set in beforeAll). */
let ORCH_TOKEN: string;
/** Scratch ARTIFACT_DIR the suite's uploads land in (set in beforeAll). */
let artifactDir: string;
let app: INestApplication;
let bots: BotsService;
let messages: MessagesService;
let attachments: AttachmentsService;
let prisma: PrismaService;

const UPLOAD = {
  originalname: 'a.csv',
  mimetype: 'text/csv',
  buffer: Buffer.from('col1,col2\n1,2\n'),
};

async function newBotFor(userId: string, prefix: string) {
  return bots.create(userId, {
    name: `${prefix}-${randomUUID().slice(0, 8)}`,
    role: 'R',
    avatarColor: '#123456',
    systemPrompt: 'x',
  });
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'J1-J3 review conditions',
  () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    beforeAll(async () => {
      // Attachment storage resolves ARTIFACT_DIR on every `store` (D-019), and
      // this suite stores uploads directly through the service — so the
      // variable has to exist before the first J1 case, not only in the one
      // test that asserts the DELETE removal. A scratch directory, the way the
      // reaper suite does it; CI sets the variable itself, and this overrides
      // it only inside this worker.
      artifactDir = await mkdtemp(path.join(tmpdir(), 'crewaid-artifacts-j123-'));
      process.env['ARTIFACT_DIR'] = artifactDir;

      // M1-BE-01 / V1-08: the real AuthGuard runs here as it does in
      // production — APP_GUARD on this module, and a real session token on
      // every HTTP request. There is no test-only principal seam: over HTTP
      // the principal is whoever the session belongs to (USER_A), and
      // cross-principal cases are exercised by calling services directly with
      // a different userId, which is the exact privilege split the guard
      // enforces (HTTP can never become USER_B).
      const { Test } = await import('@nestjs/testing');
      const { APP_GUARD } = await import('@nestjs/core');
      const { AuthGuard } = await import('../src/auth/auth.guard.js');
      const moduleRef = await Test.createTestingModule({
        imports: [
          (await import('../src/bots/bots.module.js')).BotsModule,
          (await import('../src/attachments/attachments.module.js')).AttachmentsModule,
        ],
        providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(new FakeProvider())
        .compile();

      app = moduleRef.createNestApplication();
      await app.init();

      bots = app.get(BotsService);
      messages = app.get(MessagesService);
      attachments = app.get(AttachmentsService);
      prisma = app.get(PrismaService);

      // V1-08: a real session for a real user, in place of the static
      // ORCH_API_TOKEN every request used to carry.
      ({ token: ORCH_TOKEN, userId: USER_A } = await signIn(prisma, { label: 'j123' }));
      await prisma.user.upsert({
        where: { id: USER_B },
        create: { id: USER_B, name: 'Test User', email: 'intruder-b@test.local' },
        update: {},
      });
    });

    afterAll(async () => {
      // Both fixture users go, with their cascaded bots and attachments.
      // USER_B exists only to exercise cross-principal IDOR protection, and
      // USER_A is this suite's own signed-in user rather than a seeded one —
      // so unlike before V1-08, nothing here has to be left behind.
      delete process.env['ARTIFACT_DIR'];
      if (prisma !== undefined) {
        await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
      }
      await app?.close();
    });

    // ── J1 / D-021 ──────────────────────────────────────────────────────────

    it('J1: upload persists the uploading principal as ownerId', async () => {
      const stored = await attachments.store({ userId: USER_A }, UPLOAD);
      expect(stored.ownerId).toBe(USER_A);
    });

    it('J1: user B cannot claim user A\u2019s unclaimed upload (the IDOR chain, step 1)', async () => {
      const botB = await newBotFor(USER_B, 'victim-bot');
      const uploadedByA = await attachments.store({ userId: USER_A }, UPLOAD);

      await expect(
        messages.createUserMessage(USER_B, botB.id, {
          content: 'stealing the upload',
          attachmentIds: [uploadedByA.id],
        }),
      ).rejects.toThrow('Unknown, foreign, or already-attached attachment id');

      // The row is untouched: still unclaimed, still A's.
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: uploadedByA.id } });
      expect(row.messageId).toBeNull();
      expect(row.ownerId).toBe(USER_A);
    });

    it('J1: even if B had claimed it, B cannot download A\u2019s unclaimed file (step 2)', async () => {
      const uploadedByA = await attachments.store({ userId: USER_A }, UPLOAD);

      // A can download their own unclaimed upload (the second ownership arm).
      const own = await attachments.openForDownload(USER_A, uploadedByA.id);
      expect(own.attachment.id).toBe(uploadedByA.id);

      // B cannot — foreign unclaimed rows are a non-leaking 404.
      await expect(attachments.openForDownload(USER_B, uploadedByA.id)).rejects.toThrow(
        'Attachment not found',
      );
    });

    it('J1: claimed attachment remains downloadable via the message path, not just ownership', async () => {
      const bot = await newBotFor(USER_B, 'claimer-bot');
      const uploaded = await attachments.store({ userId: USER_B }, UPLOAD);
      const message = await messages.createUserMessage(USER_B, bot.id, {
        content: 'legit claim',
        attachmentIds: [uploaded.id],
      });
      expect(message.attachments[0]!.id).toBe(uploaded.id);

      // The claimer downloads through the message ownership arm.
      const resolved = await attachments.openForDownload(USER_B, uploaded.id);
      expect(resolved.attachment.id).toBe(uploaded.id);

      // A third party with no relation gets a non-leaking 404.
      await expect(attachments.openForDownload(USER_A, uploaded.id)).rejects.toThrow(
        'Attachment not found',
      );
    });

    it('J1: stale ownerId cannot authorize a claimed legacy row', async () => {
      const botB = await newBotFor(USER_B, 'legacy-claim-b');
      const messageB = await messages.createUserMessage(USER_B, botB.id, {
        content: 'legacy destination',
      });
      const uploadedByA = await attachments.store({ userId: USER_A }, UPLOAD);

      // Reproduce a malformed/legacy state that predates D-021: owner A's row
      // is already claimed into B's conversation. Once claimed, message
      // ownership is the sole authorization arm; stale ownerId must not grant A.
      await prisma.attachment.update({
        where: { id: uploadedByA.id },
        data: { messageId: messageB.id },
      });

      await expect(attachments.openForDownload(USER_A, uploadedByA.id)).rejects.toThrow(
        'Attachment not found',
      );
      const resolvedForB = await attachments.openForDownload(USER_B, uploadedByA.id);
      expect(resolvedForB.attachment.id).toBe(uploadedByA.id);
    });

    // ── J3 ──────────────────────────────────────────────────────────────────

    it('J3: DELETE on a claimed attachment answers HTTP 409 and keeps the row', async () => {
      const bot = await newBotFor(USER_A, 'j3-claimed');
      const uploaded = await attachments.store({ userId: USER_A }, UPLOAD);
      await messages.createUserMessage(USER_A, bot.id, {
        content: 'claim',
        attachmentIds: [uploaded.id],
      });

      await request(app.getHttpServer())
        .delete(`/attachments/${uploaded.id}`)
        .set('authorization', `Bearer ${ORCH_TOKEN}`) // was x-test-user: USER_A — real guard now (M1-BE-01)
        .expect(409);

      const row = await prisma.attachment.findUnique({ where: { id: uploaded.id } });
      expect(row).not.toBeNull();
    });

    it('J3: DELETE loses a concurrent claim race with 409 and preserves the claimed row', async () => {
      const bot = await newBotFor(USER_A, 'j3-race');
      const message = await messages.createUserMessage(USER_A, bot.id, {
        content: 'race destination',
      });
      const uploaded = await attachments.store({ userId: USER_A }, UPLOAD);

      const realDelete = prisma.attachment.delete.bind(prisma.attachment);
      const realDeleteMany = prisma.attachment.deleteMany.bind(prisma.attachment);
      let claimInjected = false;
      const injectConcurrentClaim = async () => {
        if (!claimInjected) {
          claimInjected = true;
          await prisma.attachment.update({
            where: { id: uploaded.id },
            data: { messageId: message.id },
          });
        }
      };

      // The old implementation calls delete({id}); the corrected one calls an
      // atomic deleteMany predicate. Inject at either seam so this regression
      // stays red before the fix and exercises the conditional write after it.
      const deleteDuringClaim = async (args: Parameters<typeof realDelete>[0]) => {
        await injectConcurrentClaim();
        return realDelete(args);
      };
      const deleteManyDuringClaim = async (args: Parameters<typeof realDeleteMany>[0]) => {
        await injectConcurrentClaim();
        return realDeleteMany(args);
      };
      vi.spyOn(prisma.attachment, 'delete').mockImplementationOnce(
        deleteDuringClaim as unknown as typeof realDelete,
      );
      vi.spyOn(prisma.attachment, 'deleteMany').mockImplementationOnce(
        deleteManyDuringClaim as unknown as typeof realDeleteMany,
      );

      await expect(
        attachments.removeUnclaimed(USER_A, uploaded.id, UNCLAIMED_TTL_MS),
      ).rejects.toThrow('claimed by a message');

      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: uploaded.id } });
      expect(row.messageId).toBe(message.id);
    });

    it('J3: DELETE on an expired unclaimed attachment answers HTTP 410', async () => {
      const uploaded = await attachments.store({ userId: USER_A }, UPLOAD);
      // Force it past the TTL.
      await prisma.attachment.update({
        where: { id: uploaded.id },
        data: { createdAt: new Date(Date.now() - UNCLAIMED_TTL_MS - 60_000) },
      });

      await request(app.getHttpServer())
        .delete(`/attachments/${uploaded.id}`)
        .set('authorization', `Bearer ${ORCH_TOKEN}`)
        .expect(410);
    });

    it('J3: GET download of an expired unclaimed attachment answers HTTP 410', async () => {
      const uploaded = await attachments.store({ userId: USER_A }, UPLOAD);
      await prisma.attachment.update({
        where: { id: uploaded.id },
        data: { createdAt: new Date(Date.now() - UNCLAIMED_TTL_MS - 60_000) },
      });

      await request(app.getHttpServer())
        .get(`/attachments/${uploaded.id}/download`)
        .set('authorization', `Bearer ${ORCH_TOKEN}`)
        .expect(410);
    });

    it('J3: DELETE on a fresh unclaimed attachment answers HTTP 204 and removes it', async () => {
      const uploaded = await attachments.store({ userId: USER_A }, UPLOAD);

      await request(app.getHttpServer())
        .delete(`/attachments/${uploaded.id}`)
        .set('authorization', `Bearer ${ORCH_TOKEN}`)
        .expect(204);

      const row = await prisma.attachment.findUnique({ where: { id: uploaded.id } });
      expect(row).toBeNull();
    });

    it('J3: a foreign principal cannot delete the upload — 404 without leaking existence', async () => {
      // Over HTTP the guard can only ever produce the singleton principal
      // (M1-BE-01) — that IS the privilege boundary, so HTTP-as-USER_B is no
      // longer expressible and must not be faked. The non-leak property is
      // enforced in the service, where userId enters: assert it directly for
      // the foreign user, and over HTTP as the authenticated owner for the
      // control arm.
      const uploadedByA = await attachments.store({ userId: USER_A }, UPLOAD);

      await expect(
        attachments.removeUnclaimed(USER_B, uploadedByA.id, UNCLAIMED_TTL_MS),
      ).rejects.toThrow('Attachment not found');

      // Control arm: the same request over HTTP, authenticated as A, is 204.
      await request(app.getHttpServer())
        .delete(`/attachments/${uploadedByA.id}`)
        .set('authorization', `Bearer ${ORCH_TOKEN}`)
        .expect(204);

      const row = await prisma.attachment.findUnique({ where: { id: uploadedByA.id } });
      expect(row).toBeNull();
    });
  },
);
