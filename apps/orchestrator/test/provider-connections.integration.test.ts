import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  ListProviderConnectionsResponseSchema,
  ProviderConnectionSchema,
  ProviderModelSchema,
  UserSettingsResponseSchema,
} from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ProviderConnectionsService } from '../src/providers/provider-connections.service.js';
import { signIn } from './auth-fixture.js';

/**
 * V1-05 over real HTTP, through the real guard chain (D-082 … D-085).
 *
 * Two users throughout. A one-user suite passes whether or not the `where`
 * clauses scope anything, so the foreign rows here exist for the whole run and
 * every refusal is asserted against a presence — the row the caller must not
 * reach is fetched successfully by its owner in the same test.
 *
 * Needs DATABASE_URL. Without it every case skips and the run still reports
 * green (CLAUDE.md: a silently skipped test is a dormant guard).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);
const FOREIGN_USER = `usr_provider_http_${RUN_ID}`;
let TOKEN: string;
const KEY = '1'.repeat(64);

let app: INestApplication;
let prisma: PrismaService;
/** The signed-in user this suite acts as, and owns its rows with. */
let ACTOR: string;
let providers: ProviderConnectionsService;

const auth = (): request.Test => request(app.getHttpServer()) as unknown as request.Test;
const api = (path: string): string => `/api/v1${path}`;

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'V1-05 — provider connections over HTTP',
  () => {
    beforeAll(async () => {
      process.env['CREWAID_CREDENTIAL_KEYRING'] = JSON.stringify({ 1: KEY });
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
      // V1-08: a real session for a real user. The suite owns its rows with
      // ACTOR, so nothing here depends on a user somebody else seeded.
      ({ token: TOKEN, userId: ACTOR } = await signIn(prisma, { label: 'providers' }));
      providers = app.get(ProviderConnectionsService);
      // Every endpoint in this suite is fictional, so DNS must not decide the
      // outcome. The resolver is the seam D-085 left for exactly this.
      providers.setAddressResolverForTests((hostname) =>
        hostname === 'private.example.com'
          ? Promise.resolve(['169.254.169.254'])
          : Promise.resolve(['93.184.216.34']),
      );

      await prisma.user.upsert({
        where: { id: ACTOR },
        create: {
          id: ACTOR,
          name: 'Test User',
          email: `${ACTOR}@test.invalid`,
        },
        update: {},
      });
      await prisma.user.upsert({
        where: { id: FOREIGN_USER },
        create: {
          id: FOREIGN_USER,
          name: 'Foreign User',
          email: `provider-http-${RUN_ID}@test.invalid`,
        },
        update: {},
      });
    });

    /**
     * ⚠️ THE BOTS THIS SUITE CREATES BELONG TO THE SINGLETON USER, which every
     * other integration suite also uses — so leaving them behind is not a
     * tidiness issue, it is a defect in somebody else's test. They are named
     * with a run-unique prefix and removed here and in `afterAll`.
     *
     * The first version of this suite left 175 of them in a shared database
     * and broke two unrelated cases that count the singleton's bots.
     */
    const BOT_PREFIX = `provider-ref-${RUN_ID}-`;

    async function clearFixtures(): Promise<void> {
      await prisma.userSettings.deleteMany({
        where: { userId: { in: [ACTOR, FOREIGN_USER] } },
      });
      await prisma.bot.deleteMany({ where: { name: { startsWith: BOT_PREFIX } } });
      await prisma.bot.deleteMany({ where: { userId: FOREIGN_USER } });
      await prisma.providerConnection.deleteMany({
        where: { userId: { in: [ACTOR, FOREIGN_USER] } },
      });
    }

    beforeEach(clearFixtures);

    afterAll(async () => {
      await clearFixtures();
      await prisma.user.deleteMany({ where: { id: FOREIGN_USER } });
      delete process.env['CREWAID_CREDENTIAL_KEYRING'];
      await app.close();
    });

    async function createConnection(body: Record<string, unknown>): Promise<string> {
      const response = await auth()
        .post(api('/providers/connections'))
        .set('Authorization', `Bearer ${TOKEN}`)
        .send(body)
        .expect(201);
      return (response.body as { id: string }).id;
    }

    describe('creating', () => {
      it('creates a built-in connection and conforms to the wire schema', async () => {
        const response = await auth()
          .post(api('/providers/connections'))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ kind: 'openai', name: 'Work OpenAI' })
          .expect(201);

        const parsed = ProviderConnectionSchema.parse(response.body);
        expect(parsed.kind).toBe('openai');
        expect(parsed.authKind).toBe('api_key');
        // D-084: born needing a credential.
        expect(parsed.state).toBe('NEEDS_CREDENTIAL');
        expect(parsed.hasCredential).toBe(false);
        expect(parsed.endpoint).toBeNull();
      });

      it('accepts a key at creation and reports only that one is present', async () => {
        const response = await auth()
          .post(api('/providers/connections'))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ kind: 'anthropic', name: 'Work Anthropic', apiKey: 'sk-ant-0123456789' })
          .expect(201);

        const parsed = ProviderConnectionSchema.parse(response.body);
        expect(parsed.hasCredential).toBe(true);
        expect(parsed.state).toBe('ACTIVE');
        expect(parsed.credentialSetAt).not.toBeNull();
        // D-083: the key is nowhere in the response, under any field name.
        expect(JSON.stringify(response.body)).not.toContain('sk-ant-0123456789');
      });

      it('refuses a second connection for the same built-in kind', async () => {
        await createConnection({ kind: 'openai', name: 'First' });
        await auth()
          .post(api('/providers/connections'))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ kind: 'openai', name: 'Second' })
          .expect(409);
      });

      it('allows many custom connections', async () => {
        await createConnection({
          kind: 'custom',
          name: 'Vendor A',
          endpoint: 'https://a.example.com/v1',
        });
        await createConnection({
          kind: 'custom',
          name: 'Vendor B',
          endpoint: 'https://b.example.com/v1',
        });
        const response = await auth()
          .get(api('/providers/connections'))
          .set('Authorization', `Bearer ${TOKEN}`)
          .expect(200);
        expect(ListProviderConnectionsResponseSchema.parse(response.body).connections).toHaveLength(
          2,
        );
      });

      it('stores the same normalised endpoint whether created or edited', async () => {
        // `admitEndpoint` returns a parsed URL so the stored value is one form
        // rather than whatever was typed. `create` used it and `update` threw
        // it away, so `https://a.example.com` came back with a trailing slash
        // on creation and without one after an edit — the same endpoint, two
        // spellings, and any caller comparing them sees a change that did not
        // happen.
        const id = await createConnection({
          kind: 'custom',
          name: 'Vendor',
          endpoint: 'https://a.example.com',
        });
        const created = await prisma.providerConnection.findUniqueOrThrow({ where: { id } });

        await auth()
          .patch(api(`/providers/connections/${id}`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ endpoint: 'https://a.example.com' })
          .expect(200);

        const edited = await prisma.providerConnection.findUniqueOrThrow({ where: { id } });
        expect(edited.endpoint).toBe(created.endpoint);
      });

      it('refuses an endpoint that resolves into a private range — D-085', async () => {
        await auth()
          .post(api('/providers/connections'))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ kind: 'custom', name: 'Evil', endpoint: 'https://private.example.com/v1' })
          .expect(400);

        // And nothing was left behind: the endpoint is admitted BEFORE the
        // row exists, so a refusal has nothing to clean up.
        expect(await prisma.providerConnection.count({ where: { userId: ACTOR } })).toBe(0);
      });

      it('refuses a built-in with an endpoint, and a custom without one', async () => {
        for (const body of [
          { kind: 'openai', name: 'X', endpoint: 'https://a.example.com/v1' },
          { kind: 'custom', name: 'Y' },
        ]) {
          await auth()
            .post(api('/providers/connections'))
            .set('Authorization', `Bearer ${TOKEN}`)
            .send(body)
            .expect(400);
        }
      });
    });

    describe('credentials', () => {
      it('answers 503 and NAMES the variable when the keyring is misconfigured', async () => {
        // The vault reads its keyring lazily on purpose, so an orchestrator
        // with none still serves the settings pages an operator would use to
        // fix it. The cost is that the failure arrives at a request — and it
        // arrived as a bare 500, which the desktop renders as "Something went
        // wrong. Try again." on the one screen where trying again can never
        // work, because nothing in the app changes an environment variable.
        const { CredentialService } = await import('../src/credentials/credential.service.js');
        const credentials = app.get(CredentialService);
        const previous = process.env['CREWAID_CREDENTIAL_KEYRING'];
        const id = await createConnection({ kind: 'openai', name: 'Misconfigured' });

        // The exact shape an operator produces by pasting `openssl rand -hex 32`
        // straight in: 64 valid hex characters that are not the JSON the
        // keyring wants.
        process.env['CREWAID_CREDENTIAL_KEYRING'] = 'a'.repeat(64);
        credentials.resetKeyringForTests();
        try {
          const response = await auth()
            .put(api(`/providers/connections/${id}/credential`))
            .set('Authorization', `Bearer ${TOKEN}`)
            .send({ apiKey: 'sk-live-0123456789' })
            .expect(503);

          expect(response.body.code).toBe('SERVER_MISCONFIGURED');
          expect(response.body.message).toContain('CREWAID_CREDENTIAL_KEYRING');
          // The message says the SHAPE and never a value: a parse error that
          // echoed its input would put every key in the ring into the report.
          expect(response.body.message).not.toContain('a'.repeat(64));
        } finally {
          if (previous === undefined) delete process.env['CREWAID_CREDENTIAL_KEYRING'];
          else process.env['CREWAID_CREDENTIAL_KEYRING'] = previous;
          credentials.resetKeyringForTests();
        }
      });

      it('writes a key with 204 and no body', async () => {
        const id = await createConnection({ kind: 'openai', name: 'Work' });
        const response = await auth()
          .put(api(`/providers/connections/${id}/credential`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ apiKey: 'sk-live-0123456789' })
          .expect(204);
        // Nothing to diff against what was sent, so nothing to conclude about
        // whether the key round-trips.
        expect(response.body).toEqual({});
      });

      it('never returns the key on any route, and never stores it in the clear', async () => {
        const id = await createConnection({ kind: 'openai', name: 'Work' });
        await auth()
          .put(api(`/providers/connections/${id}/credential`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ apiKey: 'sk-live-canary-value' })
          .expect(204);

        const list = await auth()
          .get(api('/providers/connections'))
          .set('Authorization', `Bearer ${TOKEN}`)
          .expect(200);
        const body = JSON.stringify(list.body);
        expect(body).not.toContain('sk-live-canary-value');

        const row = await prisma.providerConnection.findUniqueOrThrow({ where: { id } });
        expect(row.credentialCiphertext).not.toBeNull();
        expect(row.credentialCiphertext).not.toContain('sk-live-canary-value');

        // ⚠️ AND THE CIPHERTEXT IS NOT ON THE WIRE EITHER. D-083 says neither
        // plaintext NOR ciphertext, and a plaintext-only canary passes against
        // a handler that returns the encrypted blob — which is a real leak: it
        // is offline-attackable, and it is exactly what a `select` that forgot
        // to exclude the column would produce.
        expect(body, 'the stored ciphertext reached the client').not.toContain(
          row.credentialCiphertext!,
        );
        // Nor the key version, which tells an attacker which key to target
        // during a rotation.
        for (const field of ['credentialCiphertext', 'credentialKeyVersion']) {
          expect(body, `${field} reached the client`).not.toContain(field);
        }
      });

      it('clearing a key is never refused for a reference — it is the revocation path', async () => {
        const id = await createConnection({
          kind: 'openai',
          name: 'Work',
          apiKey: 'sk-live-0123456789',
        });
        const modelId = await addModel(id);
        await pointBotAt(ACTOR, modelId);

        // Deleting the model would be refused (asserted below); clearing the
        // key must not be, or someone removing a leaked key is told to go and
        // repoint three bots first.
        await auth()
          .delete(api(`/providers/connections/${id}/credential`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .expect(204);

        const row = await prisma.providerConnection.findUniqueOrThrow({ where: { id } });
        expect(row.credentialCiphertext).toBeNull();
        expect(row.state).toBe('NEEDS_CREDENTIAL');
      });

      it('refuses to activate a connection that has no key', async () => {
        const id = await createConnection({ kind: 'openai', name: 'Work' });
        await auth()
          .patch(api(`/providers/connections/${id}`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ state: 'ACTIVE' })
          .expect(400);
      });
    });

    describe('models', () => {
      it('creates a model and conforms to the wire schema', async () => {
        const id = await createConnection({ kind: 'openai', name: 'Work' });
        const response = await auth()
          .post(api(`/providers/connections/${id}/models`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({
            upstreamModelId: 'gpt-5.1',
            label: 'GPT-5.1',
            contextWindow: 400_000,
            capabilities: { tools: true, vision: true, reasoning: true },
          })
          .expect(201);
        const parsed = ProviderModelSchema.parse(response.body);
        expect(parsed.upstreamModelId).toBe('gpt-5.1');
        expect(parsed.capabilities.vision).toBe(true);
      });

      it('refuses a duplicate upstream id on the same connection', async () => {
        const id = await createConnection({ kind: 'openai', name: 'Work' });
        await addModel(id, 'gpt-5.1');
        await auth()
          .post(api(`/providers/connections/${id}/models`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({
            upstreamModelId: 'gpt-5.1',
            label: 'Again',
            contextWindow: 1000,
            capabilities: { tools: true, vision: false, reasoning: false },
          })
          .expect(409);
      });

      it('allows the same upstream id on a different connection', async () => {
        // Two connections may legitimately serve `gpt-5.1` — one OpenAI, one
        // a proxy. The uniqueness is per connection, not global.
        const a = await createConnection({ kind: 'openai', name: 'Direct' });
        const b = await createConnection({
          kind: 'custom',
          name: 'Proxy',
          endpoint: 'https://proxy.example.com/v1',
        });
        await addModel(a, 'gpt-5.1');
        await addModel(b, 'gpt-5.1');
      });

      it('renames a model without repointing the bots that use it — D-082', async () => {
        const id = await createConnection({ kind: 'openai', name: 'Work' });
        const modelId = await addModel(id, 'gpt-5.1');
        const botId = await pointBotAt(ACTOR, modelId);

        await auth()
          .patch(api(`/providers/models/${modelId}`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ upstreamModelId: 'gpt-5.2', label: 'GPT-5.2' })
          .expect(200);

        // The row id is the identity, so the bot still points at the model.
        const bot = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
        expect(bot.modelId).toBe(modelId);
      });
    });

    describe('referential integrity', () => {
      it('refuses to delete a model a bot still points at', async () => {
        const id = await createConnection({ kind: 'openai', name: 'Work' });
        const modelId = await addModel(id);
        await pointBotAt(ACTOR, modelId);

        const response = await auth()
          .delete(api(`/providers/models/${modelId}`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .expect(409);
        // The message names the bot, because "in use" without saying by what
        // leaves the operator to go and look.
        expect(JSON.stringify(response.body)).toContain('still in use');
      });

      it('refuses to delete a model that is the user’s default', async () => {
        const id = await createConnection({ kind: 'openai', name: 'Work' });
        const modelId = await addModel(id);
        await auth()
          .patch(api('/settings'))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ defaultModelId: modelId })
          .expect(200);

        await auth()
          .delete(api(`/providers/models/${modelId}`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .expect(409);
      });

      it('refuses to delete a connection whose model is still referenced', async () => {
        const id = await createConnection({ kind: 'openai', name: 'Work' });
        const modelId = await addModel(id);
        await pointBotAt(ACTOR, modelId);

        await auth()
          .delete(api(`/providers/connections/${id}`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .expect(409);
      });

      it('allows the delete once the reference moves', async () => {
        // Asserted against the refusal above: without this, the 409 could be
        // an unconditional refusal and nothing here would notice.
        const id = await createConnection({ kind: 'openai', name: 'Work' });
        const modelId = await addModel(id);
        const botId = await pointBotAt(ACTOR, modelId);

        await prisma.bot.update({ where: { id: botId }, data: { modelId: 'default' } });
        await auth()
          .delete(api(`/providers/connections/${id}`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .expect(204);
      });

      it('does not count ANOTHER user’s bot as a reference', async () => {
        // The reference check is scoped too. A foreign bot whose `modelId`
        // string happens to match must not be able to pin this user's model
        // in place — that is a denial-of-service on somebody else's settings.
        const id = await createConnection({ kind: 'openai', name: 'Work' });
        const modelId = await addModel(id);
        await pointBotAt(FOREIGN_USER, modelId);

        await auth()
          .delete(api(`/providers/models/${modelId}`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .expect(204);
      });
    });

    describe('owner scoping', () => {
      let foreignConnection: string;
      let foreignModel: string;

      beforeEach(async () => {
        foreignConnection = (
          await prisma.providerConnection.create({
            data: { userId: FOREIGN_USER, kind: 'OPENAI', name: 'theirs' },
          })
        ).id;
        foreignModel = (
          await prisma.providerModel.create({
            data: {
              connectionId: foreignConnection,
              upstreamModelId: 'gpt-5.1',
              label: 'Theirs',
              contextWindow: 1000,
            },
          })
        ).id;
      });

      it('never lists another user’s connection', async () => {
        // Against a presence: the foreign row exists throughout.
        expect(
          await prisma.providerConnection.count({ where: { userId: FOREIGN_USER } }),
        ).toBeGreaterThan(0);

        const response = await auth()
          .get(api('/providers/connections'))
          .set('Authorization', `Bearer ${TOKEN}`)
          .expect(200);
        const ids = ListProviderConnectionsResponseSchema.parse(response.body).connections.map(
          (connection) => connection.id,
        );
        expect(ids).not.toContain(foreignConnection);
      });

      it('404s on every direct-by-id route for a foreign connection', async () => {
        // Each request is BUILT inside the loop. Building all four up front
        // starts four supertest ephemeral servers before any is awaited, and
        // the later ones answer ECONNREFUSED — a failure that looks like the
        // route refusing when it is the harness.
        const routes: readonly (() => request.Test)[] = [
          () =>
            auth()
              .patch(api(`/providers/connections/${foreignConnection}`))
              .send({ name: 'mine' }),
          () => auth().delete(api(`/providers/connections/${foreignConnection}`)),
          () =>
            auth()
              .put(api(`/providers/connections/${foreignConnection}/credential`))
              .send({ apiKey: 'sk-stolen-0123456789' }),
          () => auth().delete(api(`/providers/connections/${foreignConnection}/credential`)),
        ];
        for (const route of routes) {
          await route().set('Authorization', `Bearer ${TOKEN}`).expect(404);
        }
      });

      it('404s on a foreign model, the same as on one that does not exist', async () => {
        const absent = 'pm_does_not_exist';
        await auth()
          .patch(api(`/providers/models/${foreignModel}`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ label: 'mine' })
          .expect(404);
        await auth()
          .patch(api(`/providers/models/${absent}`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ label: 'mine' })
          .expect(404);
      });

      it('refuses a foreign model as a default', async () => {
        await auth()
          .patch(api('/settings'))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ defaultModelId: foreignModel })
          .expect(404);
      });

      it('leaves the foreign row untouched after every refusal', async () => {
        const before = await prisma.providerConnection.findUniqueOrThrow({
          where: { id: foreignConnection },
        });
        await auth()
          .patch(api(`/providers/connections/${foreignConnection}`))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ name: 'renamed by an outsider' })
          .expect(404);
        const after = await prisma.providerConnection.findUniqueOrThrow({
          where: { id: foreignConnection },
        });
        expect(after.name).toBe(before.name);
      });
    });

    describe('settings', () => {
      it('answers with no default before one is chosen, rather than 404', async () => {
        const response = await auth()
          .get(api('/settings'))
          .set('Authorization', `Bearer ${TOKEN}`)
          .expect(200);
        expect(UserSettingsResponseSchema.parse(response.body).settings.defaultModelId).toBeNull();
      });

      it('sets and clears the default', async () => {
        const id = await createConnection({ kind: 'openai', name: 'Work' });
        const modelId = await addModel(id);

        const set = await auth()
          .patch(api('/settings'))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ defaultModelId: modelId })
          .expect(200);
        expect(UserSettingsResponseSchema.parse(set.body).settings.defaultModelId).toBe(modelId);

        // Null clears; an absent field would have left it alone.
        const cleared = await auth()
          .patch(api('/settings'))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ defaultModelId: null })
          .expect(200);
        expect(UserSettingsResponseSchema.parse(cleared.body).settings.defaultModelId).toBeNull();
      });

      it('keeps a choice and a detection apart, and one field never resets another (D-234)', async () => {
        const patch = (body: object) =>
          auth().patch(api('/settings')).set('Authorization', `Bearer ${TOKEN}`).send(body);

        await patch({ systemLanguage: 'de', systemTimezone: 'UTC' }).expect(200);
        const chosen = await patch({ language: 'fr', timezone: 'Europe/Paris' }).expect(200);
        expect(UserSettingsResponseSchema.parse(chosen.body).settings).toMatchObject({
          language: 'fr',
          timezone: 'Europe/Paris',
          systemLanguage: 'de',
          systemTimezone: 'UTC',
        });

        // Back to "Follow System": the detection a second computer reported survives.
        const followed = await patch({ language: null }).expect(200);
        expect(UserSettingsResponseSchema.parse(followed.body).settings).toMatchObject({
          language: null,
          timezone: 'Europe/Paris',
          systemLanguage: 'de',
        });
      });

      it('refuses a language it does not ship and a zone it cannot schedule in', async () => {
        const patch = (body: object) =>
          auth().patch(api('/settings')).set('Authorization', `Bearer ${TOKEN}`).send(body);
        await patch({ language: 'fr-FR' }).expect(400);
        await patch({ timezone: 'Mars/Olympus_Mons' }).expect(400);
        await patch({ systemTimezone: 'EDT' }).expect(400);
      });
    });

    // ── helpers ────────────────────────────────────────────────────────────

    async function addModel(connectionId: string, upstream = 'gpt-5.1'): Promise<string> {
      const response = await auth()
        .post(api(`/providers/connections/${connectionId}/models`))
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({
          upstreamModelId: upstream,
          label: upstream,
          contextWindow: 200_000,
          capabilities: { tools: true, vision: false, reasoning: false },
        })
        .expect(201);
      return (response.body as { id: string }).id;
    }

    async function pointBotAt(userId: string, modelId: string): Promise<string> {
      const bot = await prisma.bot.create({
        data: {
          userId,
          name: `${BOT_PREFIX}${randomUUID().slice(0, 8)}`,
          role: 'fixture',
          avatarColor: '#8B6F47',
          systemPrompt: '',
          modelId,
        },
      });
      return bot.id;
    }
  },
);
