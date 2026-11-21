import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CredentialService } from '../src/credentials/credential.service.js';
import {
  DefaultModelUnsetError,
  ModelNeedsCredentialError,
  ModelResolutionService,
  UnknownModelError,
} from '../src/models/model-resolution.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { IncludedModelsUnavailableError } from '../src/models/included-models.port.js';
import { ScriptedAdapter } from './mod-02-tanstack-harness.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = '7'.repeat(64);

/**
 * V1-06 / D-086 — resolution is owner-scoped, and that is a property of the
 * ROWS a caller can reach.
 *
 * The suite this replaces (`models.test.ts`'s registry cases) juggled three
 * environment variables and asserted that a `provider:model` string produced
 * a model object. None of that can express the thing that now matters: whose
 * connection served it, and whether somebody else's model is reachable.
 *
 * So there are two users for the whole run, and every refusal is asserted
 * against a presence — the row the caller must not reach resolves fine for
 * its owner in the same test.
 */
describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'ModelResolutionService (real database)',
  () => {
    let prisma: PrismaService;
    let models: ModelResolutionService;

    const owner = `mr-owner-${randomUUID()}`;
    const other = `mr-other-${randomUUID()}`;
    let ownerConnection: string;
    let ownerModel: string;
    let otherModel: string;

    beforeAll(async () => {
      process.env['CREWAID_CREDENTIAL_KEYRING'] = JSON.stringify({ 1: KEY });
      delete process.env['CREWAID_CREDENTIAL_KEY_ACTIVE'];

      prisma = new PrismaService();
      await prisma.$connect();
      const credentials = new CredentialService(prisma);
      models = new ModelResolutionService(prisma, credentials);

      for (const [id, name] of [
        [owner, 'Owner'],
        [other, 'Other'],
      ] as const) {
        await prisma.user.create({ data: { id, name, email: `${id}@test.invalid` } });
      }

      ownerConnection = (
        await prisma.providerConnection.create({
          data: { userId: owner, kind: 'OPENAI', name: 'Work OpenAI' },
        })
      ).id;
      await credentials.setCredential(owner, ownerConnection, 'sk-owner-live-key');
      ownerModel = (
        await prisma.providerModel.create({
          data: {
            connectionId: ownerConnection,
            upstreamModelId: 'gpt-5.1',
            label: 'GPT-5.1',
            contextWindow: 400_000,
            supportsVision: true,
          },
        })
      ).id;

      const otherConnection = await prisma.providerConnection.create({
        data: { userId: other, kind: 'OPENAI', name: 'Their OpenAI' },
      });
      await credentials.setCredential(other, otherConnection.id, 'sk-other-live-key');
      otherModel = (
        await prisma.providerModel.create({
          data: {
            connectionId: otherConnection.id,
            upstreamModelId: 'gpt-5.1',
            label: 'Their GPT-5.1',
            contextWindow: 400_000,
          },
        })
      ).id;
    });

    beforeEach(async () => {
      await prisma.userSettings.deleteMany({ where: { userId: { in: [owner, other] } } });
      await prisma.providerConnection.updateMany({
        where: { id: ownerConnection },
        data: { state: 'ACTIVE' },
      });
    });

    afterAll(async () => {
      await prisma.userSettings.deleteMany({ where: { userId: { in: [owner, other] } } });
      await prisma.providerConnection.deleteMany({ where: { userId: { in: [owner, other] } } });
      await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
      delete process.env['CREWAID_CREDENTIAL_KEYRING'];
      await prisma.$disconnect();
    });

    it('resolves a model this user owns, with its connection and capabilities', async () => {
      const resolved = await models.resolveText(owner, ownerModel);
      expect(resolved.modelId).toBe(ownerModel);
      expect(resolved.connectionId).toBe(ownerConnection);
      expect(resolved.connectionName).toBe('Work OpenAI');
      expect(resolved.kind).toBe('openai');
      expect(resolved.upstreamModelId).toBe('gpt-5.1');
      expect(resolved.capabilities.vision).toBe(true);
      expect(resolved.adapter).toBeDefined();
    });

    it('resolves the controlled TanStack path through the same owned model and vault', async () => {
      const resolved = await models.resolveText(owner, ownerModel);
      expect(resolved).toMatchObject({
        modelId: ownerModel,
        connectionId: ownerConnection,
        kind: 'openai',
        upstreamModelId: 'gpt-5.1',
      });
      expect(resolved.adapter.model).toBe('gpt-5.1');
      expect(Object.keys(resolved)).not.toEqual(expect.arrayContaining(['apiKey', 'credential']));
      await expect(models.resolveText(other, otherModel)).resolves.toBeDefined();
      await expect(models.resolveText(owner, otherModel)).rejects.toBeInstanceOf(UnknownModelError);
      await expect(models.resolveText(owner, 'missing')).rejects.toBeInstanceOf(UnknownModelError);
    });

    it('a disabled connection cannot resolve a TanStack adapter', async () => {
      await prisma.providerConnection.update({
        where: { id: ownerConnection },
        data: { state: 'DISABLED' },
      });
      await expect(models.resolveText(owner, ownerModel)).rejects.toBeInstanceOf(
        ModelNeedsCredentialError,
      );
    });
    it('an included model resolves only through the meter, and is unavailable without one', async () => {
      const connection = await prisma.providerConnection.create({
        data: {
          userId: owner,
          kind: 'CREWAID',
          name: 'Included fixture',
        },
      });
      const model = await prisma.providerModel.create({
        data: {
          connectionId: connection.id,
          upstreamModelId: 'fixture',
          label: 'Included',
          contextWindow: 10000,
        },
      });
      const metered = new ScriptedAdapter();
      const meter = {
        ensureFor: vi.fn(),
        languageModel: vi.fn(),
        textAdapter: vi.fn(async () => metered),
      };
      const withMeter = new ModelResolutionService(prisma, new CredentialService(prisma), meter);
      const withoutMeter = new ModelResolutionService(prisma, new CredentialService(prisma));
      try {
        const resolved = await withMeter.resolveText(owner, model.id);
        expect(resolved.adapter).toBe(metered);
        expect(resolved.kind).toBe('openrouter');
        expect(meter.textAdapter).toHaveBeenCalledWith(owner, 'fixture');
        expect(meter.languageModel).not.toHaveBeenCalled();
        await expect(withoutMeter.resolveText(owner, model.id)).rejects.toBeInstanceOf(
          IncludedModelsUnavailableError,
        );
      } finally {
        await prisma.providerConnection.delete({ where: { id: connection.id } });
      }
    });

    it('never carries the credential on what it returns — D-083', () => {
      // A structural assertion, not a spot check: the key is consumed by
      // `buildTextAdapter` and there is no field on ResolvedTextModel it could
      // travel in. This fails the moment someone adds one "just for logging".
      const forbidden = /key|secret|token|credential|password/;
      return models.resolveText(owner, ownerModel).then((resolved) => {
        for (const field of Object.keys(resolved)) {
          expect(field.toLowerCase(), `${field} looks like credential material`).not.toMatch(
            forbidden,
          );
        }
        expect(JSON.stringify(resolved.capabilities)).not.toContain('sk-owner');
      });
    });

    describe('owner scoping', () => {
      it('refuses another user’s model, and says nothing about whose it was', async () => {
        // Against a presence: it resolves for its owner in this same test.
        await expect(models.resolveText(other, otherModel)).resolves.toBeDefined();
        await expect(models.resolveText(owner, otherModel)).rejects.toBeInstanceOf(
          UnknownModelError,
        );
      });

      it('answers the same way for a foreign model as for one that does not exist', async () => {
        const foreign = await models
          .resolveText(owner, otherModel)
          .catch((error: unknown) => error);
        const absent = await models.resolveText(owner, 'pm_nope').catch((error: unknown) => error);
        expect((foreign as Error).name).toBe((absent as Error).name);
      });

      it('lists only this user’s models', async () => {
        const options = await models.options(owner);
        expect(options.models.map((model) => model.id)).toEqual([ownerModel]);
        const theirs = await models.options(other);
        expect(theirs.models.map((model) => model.id)).toEqual([otherModel]);
      });
    });

    describe('the default alias', () => {
      it('resolves per-user, not from an environment variable', async () => {
        await prisma.userSettings.create({
          data: { userId: owner, defaultModelId: ownerModel },
        });
        // Set to prove it is IGNORED. Under D-004 this variable chose the
        // model; under D-086 nothing reads it, and a test that never set it
        // could not tell the difference.
        process.env['DEFAULT_MODEL_ID'] = 'anthropic:claude-opus-4-5';
        try {
          const resolved = await models.resolveText(owner, 'default');
          expect(resolved.modelId).toBe(ownerModel);
        } finally {
          delete process.env['DEFAULT_MODEL_ID'];
        }
      });

      it('falls back to the first available model when the user never chose one', async () => {
        // Every bot is born carrying the `default` alias, so "unset" cannot
        // mean "nothing to run" while the user HAS a model: the picker showed
        // no selection and the first turn failed, for a bot that plainly
        // needed a model. The fallback is the model an operator would have
        // picked, and `options()` reports the same one, so the label and the
        // turn cannot disagree.
        await expect(models.resolveText(owner, 'default')).resolves.toMatchObject({
          modelId: ownerModel,
        });
        expect((await models.options(owner)).defaultModelId).toBe(ownerModel);
      });

      it('still fails with a typed error when there is genuinely nothing to run', async () => {
        // The action this sentence sends someone to is "add a connection", so
        // it must survive the fallback: a disabled connection is not a model.
        await prisma.providerConnection.updateMany({
          where: { id: ownerConnection },
          data: { state: 'DISABLED' },
        });
        await expect(models.resolveText(owner, 'default')).rejects.toBeInstanceOf(
          DefaultModelUnsetError,
        );
      });

      it('does not borrow another user’s default', async () => {
        await prisma.userSettings.create({ data: { userId: other, defaultModelId: otherModel } });
        // The fallback is still owner-scoped: the owner's own model answers,
        // never the other user's configured default.
        await expect(models.resolveText(owner, 'default')).resolves.toMatchObject({
          modelId: ownerModel,
        });
      });

      it('reports the caller’s default — chosen or fallen back — alongside the list', async () => {
        await prisma.userSettings.create({ data: { userId: owner, defaultModelId: ownerModel } });
        expect((await models.options(owner)).defaultModelId).toBe(ownerModel);
        // Unset for `other`, who also owns an active model: the effective
        // default, which is what the composer labels "Default".
        expect((await models.options(other)).defaultModelId).toBe(otherModel);
      });
    });

    describe('a connection that cannot serve a turn', () => {
      it('refuses a model whose connection lost its key', async () => {
        const credentials = new CredentialService(prisma);
        await credentials.clearCredential(owner, ownerConnection);
        try {
          await expect(models.resolveText(owner, ownerModel)).rejects.toBeInstanceOf(
            ModelNeedsCredentialError,
          );
        } finally {
          await credentials.setCredential(owner, ownerConnection, 'sk-owner-live-key');
        }
      });

      it('refuses a model on a DISABLED connection', async () => {
        await prisma.providerConnection.updateMany({
          where: { id: ownerConnection },
          data: { state: 'DISABLED' },
        });
        await expect(models.resolveText(owner, ownerModel)).rejects.toBeInstanceOf(
          ModelNeedsCredentialError,
        );
      });

      it('still LISTS it, marked unavailable — D-086', async () => {
        // Hiding it makes "my model disappeared" the first symptom of a
        // removed key, in the one place someone would look for the reason.
        const credentials = new CredentialService(prisma);
        await credentials.clearCredential(owner, ownerConnection);
        try {
          const options = await models.options(owner);
          expect(options.models).toHaveLength(1);
          expect(options.models[0]?.available).toBe(false);
          expect(options.models[0]?.connectionState).toBe('NEEDS_CREDENTIAL');
        } finally {
          await credentials.setCredential(owner, ownerConnection, 'sk-owner-live-key');
        }
      });

      it('distinguishes "add a key" from "choose a default" from "no such model"', async () => {
        // Three different actions for the operator. Collapsing them into one
        // "model unavailable" sends people to the wrong settings page.
        const credentials = new CredentialService(prisma);
        // "choose a default" now means "there is genuinely nothing to run":
        // the fallback answers `default` whenever an ACTIVE model exists
        // (the sibling suite above), so the typed error needs a connection
        // that cannot serve a turn.
        await prisma.providerConnection.updateMany({
          where: { id: ownerConnection },
          data: { state: 'DISABLED' },
        });
        await expect(models.resolveText(owner, 'default')).rejects.toBeInstanceOf(
          DefaultModelUnsetError,
        );
        await prisma.providerConnection.updateMany({
          where: { id: ownerConnection },
          data: { state: 'ACTIVE' },
        });
        // "no such model": the id is nobody's row, whatever the state.
        await expect(models.resolveText(owner, 'pm_nope')).rejects.toBeInstanceOf(
          UnknownModelError,
        );
        // "add a key": the model exists but its connection cannot serve a turn.
        await credentials.clearCredential(owner, ownerConnection);
        try {
          await expect(models.resolveText(owner, ownerModel)).rejects.toBeInstanceOf(
            ModelNeedsCredentialError,
          );
        } finally {
          await credentials.setCredential(owner, ownerConnection, 'sk-owner-live-key');
        }
      });
    });
  },
);
