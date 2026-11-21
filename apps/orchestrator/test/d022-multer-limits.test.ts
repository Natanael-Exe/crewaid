import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete } from './auth-fixture.js';

/**
 * D-022 — Multer upload limits are deliberate config, not library defaults.
 *
 * Ratified: { fileSize: 25 MiB, files: 5 } per request; overflow answers 413
 * (Payload Too Large), never a raw Multer error. These tests prove the limits
 * are actually wired: an oversized body and an over-count field set must both
 * 413, and a legitimate small upload must still 201.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const TWENTY_SIX_MIB = 26_214_400;

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')('D-022 multipart limits', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let actorId: string;

  beforeAll(async () => {
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module.js');
    const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // Required whenever AppModule boots: WsGateway needs the §4.2 adapter
    // before init, or SocketModule falls back to socket.io and hard-exits.
    app.useWebSocketAdapter(new CrewaidWsAdapter(app));
    app.setGlobalPrefix('api/v1');
    await app.init();

    // V1-08: the uploads below are owned by whoever the session resolves to,
    // so this suite signs in as its own user rather than sharing a seeded one.
    prisma = app.get(PrismaService);
    ({ token, userId: actorId } = await signIn(prisma, { label: 'd022' }));
  });

  afterAll(async () => {
    if (prisma !== undefined && actorId !== undefined) {
      // Attachments cascade from User, so this takes the uploaded rows with it.
      await signOutAndDelete(prisma, actorId);
    }
    await app?.close();
  });

  const auth = (req: request.Test): request.Test => req.set('authorization', `Bearer ${token}`);

  it('accepts a small legitimate upload (201)', async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post('/api/v1/attachments')
        .field('filename', 'small.txt')
        .attach('file', Buffer.from('hello crewaid'), {
          filename: 'small.txt',
          contentType: 'text/plain',
        }),
    );
    expect(res.status).toBe(201);
    expect(res.body.sizeBytes).toBe(13);
  });

  it('rejects a file over 25 MiB with 413', async () => {
    const big = Buffer.alloc(TWENTY_SIX_MIB + 1, 0x61);
    const res = await auth(
      request(app.getHttpServer())
        .post('/api/v1/attachments')
        .attach('file', big, { filename: 'big.bin', contentType: 'application/octet-stream' }),
    );
    expect(res.status).toBe(413);
  });

  it('rejects more than 5 files in one request with 413', async () => {
    let req = request(app.getHttpServer()).post('/api/v1/attachments');
    for (let i = 0; i < 6; i += 1) {
      req = req.attach('file', Buffer.from(`part-${i}`), `part-${i}.txt`);
    }
    const res = await auth(req);
    expect(res.status).toBe(413);
  });

  it('rejects a body padded with text fields, and an oversized one, with 413', async () => {
    // Multer's own default is unlimited fields of 1 MB each, buffered before
    // the handler runs; a file needs none of them.
    let padded = request(app.getHttpServer()).post('/api/v1/attachments');
    for (let i = 0; i < 1500; i += 1) padded = padded.field(`f${i}`, 'x');
    padded = padded.attach('file', Buffer.from('hello'), 'small.txt');
    expect((await auth(padded)).status).toBe(413);

    const oversized = await auth(
      request(app.getHttpServer())
        .post('/api/v1/attachments')
        .field('filename', 'x'.repeat(64 * 1024))
        .attach('file', Buffer.from('hello'), 'small.txt'),
    );
    expect(oversized.status).toBe(413);
  });
});
