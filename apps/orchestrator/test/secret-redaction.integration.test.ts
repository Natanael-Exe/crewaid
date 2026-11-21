import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * V1-16 — the wire, with a key genuinely in the vault behind it.
 *
 * `credential.service.integration.test.ts` already proves the plaintext never
 * reaches the COLUMN. This is the other end: what a client is handed when the
 * row really does hold a key.
 *
 * ── THE PRESENCE THIS RESTS ON ──────────────────────────────────────────────
 *
 * `hasCredential: true` is not a nice-to-have in these assertions — it is what
 * makes them mean anything. A response with no key in it is the trivial result
 * on a connection that never had one, on a route that returned an empty list,
 * and on a server that refused the request. The case asserts the key IS stored
 * and THEN that nothing about it came back.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

/** Not a real key, and deliberately long enough to be searched for in whole or in part. */
const SECRET = `sk-proj-V116-${randomUUID().replace(/-/g, '')}`;

let app: INestApplication;
let prisma: PrismaService;
let actor: SignedInUser;
let connectionId: string;

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'V1-16 — a key goes in and nothing about it comes back',
  () => {
    beforeAll(async () => {
      // A real keyring, because the point of this suite is a key that was
      // genuinely encrypted. Without it `setCredential` throws and every
      // assertion below would be about a connection that never held one.
      process.env['CREWAID_CREDENTIAL_KEYRING'] = JSON.stringify({
        // 64 hex characters — the keyring refuses anything else, and it says so.
        1: '07'.repeat(32),
      });
      delete process.env['CREWAID_CREDENTIAL_KEY_ACTIVE'];

      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();

      prisma = app.get(PrismaService);
      actor = await signIn(prisma, { label: `v116_${RUN_ID}` });

      const created = await request(app.getHttpServer())
        .post('/api/v1/providers/connections')
        .set(actor.headers)
        .send({ kind: 'openai', name: `v116-${RUN_ID}`, apiKey: SECRET })
        .expect(201);
      connectionId = (created.body as { id: string }).id;
    });

    afterAll(async () => {
      if (prisma !== undefined && actor !== undefined) {
        await signOutAndDelete(prisma, actor.userId);
      }
      delete process.env['CREWAID_CREDENTIAL_KEYRING'];
      await app?.close();
    });

    it('stored the key — without which every assertion below is trivial', async () => {
      const row = await prisma.providerConnection.findUniqueOrThrow({
        where: { id: connectionId },
      });

      expect(row.credentialCiphertext).toBeTypeOf('string');
      expect(row.credentialCiphertext).not.toContain(SECRET);
      expect(row.state).toBe('ACTIVE');
    });

    it('hands back that a key exists, and nothing about what it is', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/providers/connections')
        .set(actor.headers)
        .expect(200);

      const body = JSON.stringify(response.body);
      const connection = (
        response.body as { connections: { id: string; hasCredential: boolean }[] }
      ).connections.find((entry) => entry.id === connectionId);

      // The presence.
      expect(connection?.hasCredential).toBe(true);

      // The absence — whole, and in parts, because a prefix or a suffix is
      // still a leak and a length is still a hint.
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain(SECRET.slice(0, 16));
      expect(body).not.toContain(SECRET.slice(-16));
      // And no ciphertext either: D-083 bars both, so a row that returned its
      // encrypted blob would be just as much a contract break.
      const row = await prisma.providerConnection.findUniqueOrThrow({
        where: { id: connectionId },
      });
      expect(body).not.toContain(row.credentialCiphertext as string);
    });

    it('answers a model list without reaching for the key it would spend', async () => {
      // `GET /models` resolves per caller and reports availability, which
      // means it has been near the vault. The response says whether a turn
      // could run, never what it would run with.
      const response = await request(app.getHttpServer())
        .get('/api/v1/models')
        .set(actor.headers)
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain(SECRET);
    });

    it('says a key is gone the moment it is cleared, and says nothing else', async () => {
      await request(app.getHttpServer())
        .delete(`/api/v1/providers/connections/${connectionId}/credential`)
        .set(actor.headers)
        .expect(204);

      const response = await request(app.getHttpServer())
        .get('/api/v1/providers/connections')
        .set(actor.headers)
        .expect(200);
      const connection = (
        response.body as { connections: { id: string; hasCredential: boolean; state: string }[] }
      ).connections.find((entry) => entry.id === connectionId);

      expect(connection?.hasCredential).toBe(false);
      expect(connection?.state).toBe('NEEDS_CREDENTIAL');

      // Cleared at the source, not merely hidden from the response.
      const row = await prisma.providerConnection.findUniqueOrThrow({
        where: { id: connectionId },
      });
      expect(row.credentialCiphertext).toBeNull();
    });
  },
);
