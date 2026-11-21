import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ArtifactStore } from '../src/attachments/artifact-store.js';
import { AttachmentsModule } from '../src/attachments/attachments.module.js';
import { AttachmentReaperService } from '../src/attachments/reaper.service.js';
import { AttachmentsService } from '../src/attachments/attachments.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const USER_ID = 'usr_crewaid_singleton_v1';
const MEBIBYTE = 1024 * 1024;

/** An R2-shaped store held in memory: proves a path needs no ARTIFACT_DIR. */
function memoryStore(): ArtifactStore & { readonly objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    kind: 'r2',
    objects,
    put: (key, bytes) => {
      objects.set(key, Buffer.from(bytes));
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(objects.get(key) ?? null),
    open: (key) => {
      const bytes = objects.get(key);
      return Promise.resolve(bytes === undefined ? null : Readable.from([bytes]));
    },
    delete: (key) => {
      objects.delete(key);
      return Promise.resolve();
    },
  };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition was not met before timeout');
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M2-BE-13 artifact retention and capacity (real db)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let defaultReaper: AttachmentReaperService;
    let artifactDir: string;
    let claimMessageId = '';
    let testBotId = '';
    const trackedAttachmentIds: string[] = [];
    const trackedUserIds: string[] = [];

    beforeAll(async () => {
      artifactDir = await mkdtemp(path.join(tmpdir(), 'crewaid-artifacts-reaper-'));
      process.env['ARTIFACT_DIR'] = artifactDir;
      process.env['ARTIFACT_REAP_INTERVAL_MS'] = '0';
      process.env['ARTIFACT_REAP_ON_BOOT'] = 'false';
      process.env['ARTIFACT_MAX_TOTAL_MB'] = '1000000';
      process.env['ARTIFACT_MIN_FREE_MB'] = '0';

      const { Test } = await import('@nestjs/testing');
      const moduleRef = await Test.createTestingModule({ imports: [AttachmentsModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      defaultReaper = app.get(AttachmentReaperService);

      await prisma.user.upsert({
        where: { id: USER_ID },
        create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
        update: {},
      });
      const bot = await prisma.bot.create({
        data: {
          userId: USER_ID,
          name: `reaper-test-${randomUUID().slice(0, 8)}`,
          role: 'R',
          avatarColor: '#123456',
          systemPrompt: 'reaper test bot',
        },
      });
      testBotId = bot.id;
      const conversation = await prisma.conversation.create({ data: { botId: bot.id } });
      const message = await prisma.message.create({
        data: { conversationId: conversation.id, author: 'USER', content: 'claim anchor' },
      });
      claimMessageId = message.id;
    });

    it('retries a failed object deletion and a cascade after the reaper restarts', async () => {
      const store = memoryStore();
      const first = new AttachmentReaperService(prisma, false, store);
      const attachments = new AttachmentsService(prisma, first, store);
      const upload = {
        originalname: 'proof.txt',
        mimetype: 'text/plain',
        buffer: Buffer.from('proof'),
      };
      const dropped = await attachments.store({ userId: USER_ID }, upload);
      vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('storage unavailable'));
      await attachments.removeUnclaimed(USER_ID, dropped.id, 86_400_000);
      expect(
        await prisma.artifactDeletion.findUnique({ where: { storageKey: dropped.storageKey } }),
      ).toBeTruthy();
      expect(store.objects.has(dropped.storageKey)).toBe(true);

      const linked = await attachments.store({ userId: USER_ID }, upload);
      const bot = await prisma.bot.create({
        data: {
          userId: USER_ID,
          name: 'cascade',
          role: 'R',
          systemPrompt: 'test',
          avatarColor: '#123456',
        },
      });
      const conversation = await prisma.conversation.create({ data: { botId: bot.id } });
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          author: 'USER',
          content: 'file',
          attachments: { connect: { id: linked.id } },
        },
      });
      await prisma.bot.delete({ where: { id: bot.id } });
      expect(
        await prisma.artifactDeletion.findUnique({ where: { storageKey: linked.storageKey } }),
      ).toBeTruthy();
      await new AttachmentReaperService(prisma, false, store).sweep();
      for (const { storageKey } of [linked, dropped]) {
        expect(await prisma.artifactDeletion.findUnique({ where: { storageKey } })).toBeNull();
        expect(store.objects.has(storageKey)).toBe(false);
      }
    });

    afterAll(async () => {
      if (trackedAttachmentIds.length > 0) {
        await prisma?.attachment
          .deleteMany({ where: { id: { in: trackedAttachmentIds } } })
          .catch(() => undefined);
      }
      if (testBotId !== '') {
        await prisma?.bot.deleteMany({ where: { id: testBotId } }).catch(() => undefined);
      }
      if (trackedUserIds.length > 0) {
        await prisma?.attachment
          .deleteMany({ where: { ownerId: { in: trackedUserIds } } })
          .catch(() => undefined);
        await prisma?.user
          .deleteMany({ where: { id: { in: trackedUserIds } } })
          .catch(() => undefined);
      }
      await app?.close();
      if (artifactDir !== undefined) {
        await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
      }
      delete process.env['ARTIFACT_DIR'];
      delete process.env['ARTIFACT_MAX_TOTAL_MB'];
      delete process.env['ARTIFACT_MAX_USER_MB'];
      delete process.env['ARTIFACT_MIN_FREE_MB'];
      delete process.env['ARTIFACT_REAP_INTERVAL_MS'];
      delete process.env['ARTIFACT_REAP_ON_BOOT'];
    });

    function configuredReaper(options: {
      maxTotalMb?: number;
      maxUserMb?: number;
      minFreeMb?: number;
      intervalMs?: number;
      onBoot?: boolean;
      store?: ArtifactStore;
    }): AttachmentReaperService {
      process.env['ARTIFACT_MAX_TOTAL_MB'] = String(options.maxTotalMb ?? 1_000_000);
      process.env['ARTIFACT_MAX_USER_MB'] = String(options.maxUserMb ?? 1_000_000);
      process.env['ARTIFACT_MIN_FREE_MB'] = String(options.minFreeMb ?? 0);
      process.env['ARTIFACT_REAP_INTERVAL_MS'] = String(options.intervalMs ?? 0);
      process.env['ARTIFACT_REAP_ON_BOOT'] = String(options.onBoot ?? false);
      return options.store === undefined
        ? new AttachmentReaperService(prisma)
        : new AttachmentReaperService(prisma, false, options.store);
    }

    async function freshUser(): Promise<string> {
      const id = `usr_d220_${randomUUID()}`;
      await prisma.user.create({ data: { id, name: 'D-220', email: `${id}@test.invalid` } });
      trackedUserIds.push(id);
      return id;
    }

    async function seedAttachment(options: {
      ageHours: number;
      claimedByMessageId?: string;
      filename?: string;
      sizeBytes?: number;
    }): Promise<{ id: string; absolutePath: string }> {
      const filename = `${randomUUID()}-${options.filename ?? 'seed.bin'}`;
      const storageKey = path.posix.join('reaper-test', filename);
      const absolutePath = path.join(artifactDir, storageKey);
      const sizeBytes = options.sizeBytes ?? 1024;
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, Buffer.alloc(sizeBytes, 1));

      const row = await prisma.attachment.create({
        data: {
          ownerId: USER_ID,
          messageId: options.claimedByMessageId ?? null,
          filename,
          mimeType: 'application/octet-stream',
          sizeBytes,
          storageKey,
          createdAt: new Date(Date.now() - options.ageHours * 60 * 60 * 1000),
        },
      });
      trackedAttachmentIds.push(row.id);
      return { id: row.id, absolutePath };
    }

    it('physically deletes only expired unclaimed uploads and is idempotent', async () => {
      const expired = await seedAttachment({ ageHours: 25, filename: 'expired.bin' });
      const young = await seedAttachment({ ageHours: 1, filename: 'young.bin' });
      const claimed = await seedAttachment({
        ageHours: 25,
        claimedByMessageId: claimMessageId,
        filename: 'claimed.bin',
      });

      const firstPass = await defaultReaper.sweep();
      expect(firstPass.deleted).toBeGreaterThanOrEqual(1);
      expect(firstPass.failed).toBe(0);
      await expect(defaultReaper.sweep()).resolves.toEqual({ deleted: 0, failed: 0 });

      expect(await prisma.attachment.findUnique({ where: { id: expired.id } })).toBeNull();
      await expect(access(expired.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await prisma.attachment.findUnique({ where: { id: young.id } })).not.toBeNull();
      expect(await prisma.attachment.findUnique({ where: { id: claimed.id } })).not.toBeNull();
      await expect(access(young.absolutePath)).resolves.toBeUndefined();
      await expect(access(claimed.absolutePath)).resolves.toBeUndefined();
    });

    it('preserves a file when a message claim wins the row lock', async () => {
      const candidate = await seedAttachment({ ageHours: 25, filename: 'claim-race.bin' });
      let releaseClaim!: () => void;
      let reportLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        reportLocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });

      const claim = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Attachment" WHERE "id" = ${candidate.id} FOR UPDATE`;
        reportLocked();
        await release;
        await tx.attachment.update({
          where: { id: candidate.id },
          data: { messageId: claimMessageId },
        });
      });
      await locked;
      const sweep = defaultReaper.sweep();
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseClaim();
      await claim;

      await expect(sweep).resolves.toEqual({ deleted: 0, failed: 0 });
      expect(
        (await prisma.attachment.findUniqueOrThrow({ where: { id: candidate.id } })).messageId,
      ).toBe(claimMessageId);
      await expect(access(candidate.absolutePath)).resolves.toBeUndefined();
    });

    it('keeps the row for retry when physical deletion fails', async () => {
      const candidate = await seedAttachment({ ageHours: 25, filename: 'unlink-failure.bin' });
      await unlink(candidate.absolutePath);
      await mkdir(candidate.absolutePath);

      const result = await defaultReaper.sweep();

      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(await prisma.attachment.findUnique({ where: { id: candidate.id } })).not.toBeNull();
      await expect(access(candidate.absolutePath)).resolves.toBeUndefined();

      await prisma.attachment.delete({ where: { id: candidate.id } });
      await rm(candidate.absolutePath, { recursive: true });
    });

    it('runs an awaited startup pass and then periodic passes', async () => {
      const startupCandidate = await seedAttachment({ ageHours: 25, filename: 'startup.bin' });
      const reaper = configuredReaper({ intervalMs: 25, onBoot: true });

      await reaper.onApplicationBootstrap();
      expect(await prisma.attachment.findUnique({ where: { id: startupCandidate.id } })).toBeNull();
      await expect(access(startupCandidate.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' });

      const periodicCandidate = await seedAttachment({ ageHours: 25, filename: 'periodic.bin' });
      await waitFor(
        async () =>
          (await prisma.attachment.findUnique({ where: { id: periodicCandidate.id } })) === null,
      );
      await expect(access(periodicCandidate.absolutePath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      reaper.onModuleDestroy();
    });

    it('serializes concurrent uploads so only one can consume the remaining quota', async () => {
      const aggregate = await prisma.attachment.aggregate({ _sum: { sizeBytes: true } });
      const baseline = aggregate._sum.sizeBytes ?? 0;
      const maxTotalMb = Math.ceil(baseline / MEBIBYTE) + 1;
      const headroom = maxTotalMb * MEBIBYTE - baseline;
      const incomingBytes = Math.floor(headroom * 0.6);
      const reaper = configuredReaper({ maxTotalMb });
      const attachments = new AttachmentsService(prisma, reaper);
      const upload = {
        originalname: 'quota.bin',
        mimetype: 'application/zip',
        buffer: Buffer.alloc(incomingBytes, 2),
      };

      const results = await Promise.allSettled([
        attachments.store({ userId: USER_ID }, upload),
        attachments.store({ userId: USER_ID }, upload),
      ]);
      const accepted = results.filter((result) => result.status === 'fulfilled');
      const refused = results.filter((result) => result.status === 'rejected');

      expect(accepted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      if (accepted[0]?.status === 'fulfilled') trackedAttachmentIds.push(accepted[0].value.id);
      expect(refused[0]).toMatchObject({
        reason: { status: 507, response: { code: 'ARTIFACT_CAPACITY' } },
      });
    });

    it('reserves the free-space floor for the incoming bytes', async () => {
      const reaper = configuredReaper({ minFreeMb: 1_000_000_000 });
      const attachments = new AttachmentsService(prisma, reaper);

      await expect(
        attachments.store(
          { userId: USER_ID },
          {
            originalname: 'disk-pressure.bin',
            mimetype: 'application/zip',
            buffer: Buffer.from('x'),
          },
        ),
      ).rejects.toMatchObject({
        status: 507,
        response: { code: 'ARTIFACT_CAPACITY' },
      });
    });

    it('releases a quota reservation when the filesystem write fails', async () => {
      const normalArtifactDir = artifactDir;
      const blockedArtifactDir = await mkdtemp(path.join(tmpdir(), 'crewaid-artifacts-blocked-'));
      const day = new Date().toISOString().slice(0, 10);
      await writeFile(path.join(blockedArtifactDir, day), 'blocks the required directory');
      process.env['ARTIFACT_DIR'] = blockedArtifactDir;
      const filename = `write-failure-${randomUUID()}.zip`;
      const before = await prisma.attachment.count({ where: { ownerId: USER_ID, filename } });

      try {
        const reaper = configuredReaper({});
        const attachments = new AttachmentsService(prisma, reaper);
        await expect(
          attachments.store(
            { userId: USER_ID },
            {
              originalname: filename,
              mimetype: 'application/zip',
              buffer: Buffer.from('cannot be written'),
            },
          ),
        ).rejects.toThrow();

        expect(await prisma.attachment.count({ where: { ownerId: USER_ID, filename } })).toBe(
          before,
        );
      } finally {
        process.env['ARTIFACT_DIR'] = normalArtifactDir;
        await rm(blockedArtifactDir, { recursive: true, force: true });
      }
    });

    it('caps each user separately, and an R2 store skips the host-wide cap (D-220)', async () => {
      const store = memoryStore();
      // A host-wide cap of 1 MiB that the disk store would hit on the second
      // user's upload. Every row in this database counts toward it, so a
      // store that still applied it would refuse even the first upload.
      const reaper = configuredReaper({ maxUserMb: 1, maxTotalMb: 1, store });
      const attachments = new AttachmentsService(prisma, reaper, store);
      const upload = {
        originalname: 'per-user.zip',
        mimetype: 'application/zip',
        buffer: Buffer.alloc(Math.floor(0.6 * MEBIBYTE), 3),
      };
      const userA = await freshUser();
      const userB = await freshUser();

      await expect(attachments.store({ userId: userA }, upload)).resolves.toMatchObject({
        ownerId: userA,
      });
      await expect(attachments.store({ userId: userA }, upload)).rejects.toMatchObject({
        status: 507,
        response: { code: 'ARTIFACT_CAPACITY' },
      });
      await expect(attachments.store({ userId: userB }, upload)).resolves.toMatchObject({
        ownerId: userB,
      });
      expect(store.objects.size).toBe(2);
    });

    it('stores, serves, feeds the model and deletes with no ARTIFACT_DIR (D-220)', async () => {
      const store = memoryStore();
      const savedDir = process.env['ARTIFACT_DIR'];
      delete process.env['ARTIFACT_DIR'];
      try {
        const reaper = configuredReaper({ store });
        const attachments = new AttachmentsService(prisma, reaper, store);
        const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

        // Upload, then download through the uploader's arm.
        const image = await attachments.store(
          { userId: USER_ID },
          { originalname: 'shot.png', mimetype: 'image/png', buffer: png },
        );
        trackedAttachmentIds.push(image.id);
        expect(store.objects.get(image.storageKey)).toEqual(png);
        const opened = await attachments.openForDownload(USER_ID, image.id);
        expect(await readAll(opened.stream)).toEqual(png);

        // Claimed by a message, the image reaches a vision model's input.
        await prisma.attachment.update({
          where: { id: image.id },
          data: { messageId: claimMessageId },
        });
        await expect(
          attachments.forModel(USER_ID, testBotId, claimMessageId, true),
        ).resolves.toContainEqual({
          filename: image.filename,
          mimeType: 'image/png',
          kind: 'FILE',
          data: png,
        });

        // An unclaimed upload deleted by hand leaves the store too.
        const dropped = await attachments.store(
          { userId: USER_ID },
          { originalname: 'drop.txt', mimetype: 'text/plain', buffer: Buffer.from('drop') },
        );
        await attachments.removeUnclaimed(USER_ID, dropped.id, 60_000);
        expect(store.objects.has(dropped.storageKey)).toBe(false);

        // And an expired one is reaped from it.
        const expired = await attachments.store(
          { userId: USER_ID },
          { originalname: 'old.txt', mimetype: 'text/plain', buffer: Buffer.from('old') },
        );
        trackedAttachmentIds.push(expired.id);
        await prisma.attachment.update({
          where: { id: expired.id },
          data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
        });
        expect(store.objects.has(expired.storageKey)).toBe(true);
        await reaper.sweep();
        expect(await prisma.attachment.findUnique({ where: { id: expired.id } })).toBeNull();
        expect(store.objects.has(expired.storageKey)).toBe(false);
      } finally {
        if (savedDir !== undefined) process.env['ARTIFACT_DIR'] = savedDir;
      }
    });
  },
);
