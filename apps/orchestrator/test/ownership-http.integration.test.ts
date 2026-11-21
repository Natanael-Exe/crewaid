import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AttachmentsService } from '../src/attachments/attachments.service.js';
import { OwnershipService } from '../src/ownership/ownership.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn } from './auth-fixture.js';

/**
 * D-010/D-026 over real HTTP, through the real guard chain.
 *
 * Every other ownership test drives `canActivate` with an ExecutionContext the
 * test itself builds. That proves the guard's logic and nothing about its
 * wiring: whether `@OwnedResource` survives Nest's decorator pipeline, whether
 * Reflector reads it off the handler APP_GUARD is invoked with, and whether the
 * guard runs after AuthGuard has attached a principal are all assumptions until
 * a request goes through the stack.
 *
 * Status codes alone cannot show this. AttachmentsService scopes its own
 * queries by userId, so a foreign row answers 404 whether or not the guard
 * runs — asserting the 404 tests the pair and isolates neither. The two cases
 * that pin the wiring are the ones that watch the lookup: that a marked route
 * consults ownership at all, and that a null verdict refuses a row the service
 * would otherwise have served.
 *
 * Needs DATABASE_URL and ARTIFACT_DIR — without the latter, AttachmentsService
 * refuses to construct and every case here fails as a 500 whose cause appears
 * only in the Nest log.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);
/** Not the singleton: the row this principal must never reach. */
const FOREIGN_USER = `usr_ownership_http_${RUN_ID}`;
let TOKEN: string;
let app: INestApplication;
let prisma: PrismaService;
/** The signed-in user this suite acts as, and owns its rows with. */
let ACTOR: string;
let attachments: AttachmentsService;
let ownership: OwnershipService;
let foreignAttachmentId = '';
/** Scratch ARTIFACT_DIR the suite's uploads land in (set in beforeAll). */
let artifactDir: string;

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'D-026 — the ownership marker fences real requests',
  () => {
    beforeAll(async () => {
      // The two cases that store an upload need ARTIFACT_DIR (D-019); without
      // it those stores 500 and the wiring assertions fail on a cause that has
      // nothing to do with the guard. A scratch directory, the way the reaper
      // suite does it — CI may set the variable, and this overrides it only
      // inside this worker.
      artifactDir = await mkdtemp(path.join(tmpdir(), 'crewaid-artifacts-ownership-http-'));
      process.env['ARTIFACT_DIR'] = artifactDir;

      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      // AppModule carries WsGateway; without the §4.2 adapter SocketModule
      // falls back to socket.io and hard-exits during init.
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();

      prisma = app.get(PrismaService);
      // V1-08: a real session for a real user. The suite owns its rows with
      // ACTOR, so nothing here depends on a user somebody else seeded.
      ({ token: TOKEN, userId: ACTOR } = await signIn(prisma, { label: 'ownership' }));
      attachments = app.get(AttachmentsService);
      // The same singleton the APP_GUARD instance holds — OwnershipModule is
      // @Global and the provider is a singleton, so spying here observes the
      // guard's own calls.
      ownership = app.get(OwnershipService);

      await prisma.user.upsert({
        where: { id: ACTOR },
        create: { id: ACTOR, name: 'Test User', email: `${ACTOR}@test.invalid` },
        update: {},
      });
      await prisma.user.upsert({
        where: { id: FOREIGN_USER },
        create: {
          id: FOREIGN_USER,
          name: 'Test User',
          email: `ownership-http-${RUN_ID}@test.local`,
        },
        update: {},
      });

      // A row the HTTP principal does not own. No artifact on disk: the guard
      // must refuse before anything tries to read one.
      foreignAttachmentId = (
        await prisma.attachment.create({
          data: {
            ownerId: FOREIGN_USER,
            filename: 'not-yours.csv',
            mimeType: 'text/csv',
            sizeBytes: 4,
            storageKey: `ownership-http/${RUN_ID}.csv`,
          },
        })
      ).id;
    });

    afterAll(async () => {
      // FOREIGN_USER exists only for this suite; PRD §3/R7 expects exactly one
      // seeded User, so it and its cascaded rows go with the suite.
      delete process.env['ARTIFACT_DIR'];
      await prisma?.user.deleteMany({ where: { id: FOREIGN_USER } }).catch(() => undefined);
      await app?.close();
    });

    const authed = (): string => `Bearer ${TOKEN}`;

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each([
      ['GET', (id: string) => `/api/v1/attachments/${id}/download`],
      ['DELETE', (id: string) => `/api/v1/attachments/${id}`],
    ])("%s refuses another principal's row with 404", async (method, path) => {
      const res = await request(app.getHttpServer())
        [method === 'GET' ? 'get' : 'delete'](path(foreignAttachmentId))
        .set('authorization', authed());

      // 404, not 403: a distinguishable status would confirm the id exists.
      // End-to-end behaviour only — the service scopes too, so this stays green
      // if the guard is removed. The lookup cases below are what isolate it.
      expect(res.status).toBe(404);
    });

    it.each([
      ['GET', (id: string) => `/api/v1/attachments/${id}/download`],
      ['DELETE', (id: string) => `/api/v1/attachments/${id}`],
    ])('%s answers an unknown id with the same 404', async (method, path) => {
      const res = await request(app.getHttpServer())
        [method === 'GET' ? 'get' : 'delete'](path('cmtnonexistentrow00000000'))
        .set('authorization', authed());

      expect(res.status).toBe(404);
    });

    it('still lets the owning principal through to the handler', async () => {
      // The complement that makes the 404s above meaningful: a guard that
      // refused everything would pass every assertion so far.
      const owned = await attachments.store(
        { userId: ACTOR },
        {
          originalname: 'mine.csv',
          mimetype: 'text/csv',
          buffer: Buffer.from('a,b\n1,2\n'),
        },
      );

      const res = await request(app.getHttpServer())
        .get(`/api/v1/attachments/${owned.id}/download`)
        .set('authorization', authed());

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('mine.csv');

      await prisma.attachment.deleteMany({ where: { id: owned.id } });
    });

    it('consults ownership for a marked route, through the real pipeline', async () => {
      const lookup = vi.spyOn(ownership, 'findOwned');

      await request(app.getHttpServer())
        .get(`/api/v1/attachments/${foreignAttachmentId}/download`)
        .set('authorization', authed());

      // The whole D-026 mechanism in one assertion: the decorator survived
      // compilation, Reflector found it on the handler, and the guard resolved
      // it to the right family and id.
      expect(lookup).toHaveBeenCalledWith('attachment', ACTOR, foreignAttachmentId);
    });

    it('does not consult ownership for a route carrying no marker', async () => {
      const lookup = vi.spyOn(ownership, 'findOwned');

      const res = await request(app.getHttpServer())
        .get('/api/v1/bots')
        .set('authorization', authed());

      expect(res.status).toBe(200);
      expect(lookup).not.toHaveBeenCalled();
    });

    it('refuses a row the service would have served when ownership says no', async () => {
      const owned = await attachments.store(
        { userId: ACTOR },
        { originalname: 'guarded.csv', mimetype: 'text/csv', buffer: Buffer.from('a\n1\n') },
      );
      // Proven servable above; the only difference here is the guard's verdict.
      vi.spyOn(ownership, 'findOwned').mockResolvedValue(null);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/attachments/${owned.id}/download`)
        .set('authorization', authed());

      expect(res.status).toBe(404);

      await prisma.attachment.deleteMany({ where: { id: owned.id } });
    });

    it('rejects an unauthenticated request before ownership is consulted', async () => {
      const res = await request(app.getHttpServer()).get(
        `/api/v1/attachments/${foreignAttachmentId}/download`,
      );

      // AuthGuard runs first; a 404 here would mean ownership answered for an
      // anonymous caller, which is the wrong boundary reporting the failure.
      expect(res.status).toBe(401);
    });
  },
);
