import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type {
  CreateProviderConnectionBody,
  CreateProviderModelBody,
  ProviderConnection as WireConnection,
  ProviderConnectionWithModels,
  ProviderKind,
  ProviderModel as WireModel,
  UpdateProviderConnectionBody,
  UpdateProviderModelBody,
  UpdateUserSettingsBody,
  UserSettings as WireUserSettings,
} from '@crewaid/shared';
import type {
  ProviderConnection,
  ProviderKind as DbProviderKind,
  ProviderModel,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CredentialService } from '../credentials/credential.service.js';
import { admitEndpoint, EndpointRefusedError, type AddressResolver } from './endpoint-guard.js';
import { INCLUDED_MODELS, type IncludedModels } from '../models/included-models.port.js';
import { settingsToWire } from './user-preferences.js';

/**
 * Provider connection CRUD.
 *
 * R7/D-010 discipline, the `bots.service.ts` shape: one `findOwned` helper,
 * every query scoped by `userId`, and the same 404 for a row that is absent
 * and one that is foreign — so a response cannot be used to discover which
 * connection ids exist.
 *
 * ⚠️ NOTHING HERE RETURNS A CREDENTIAL. The row's ciphertext columns are
 * dropped by `toWire` before anything leaves this file, and `toWire` is the
 * only way a row becomes a response.
 */
@Injectable()
export class ProviderConnectionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CredentialService) private readonly credentials: CredentialService,
    // Present only on a cloud server that bills.
    @Optional() @Inject(INCLUDED_MODELS) private readonly included?: IncludedModels,
  ) {}

  /** Test seam: the resolver `admitEndpoint` uses. */
  private resolver: AddressResolver | undefined;
  setAddressResolverForTests(resolve: AddressResolver | undefined): void {
    this.resolver = resolve;
  }

  // Connections

  async list(userId: string): Promise<ProviderConnectionWithModels[]> {
    // The included models are listed among the connections, so they
    // are made sure of first.
    await this.included?.ensureFor(userId);
    const rows = await this.prisma.providerConnection.findMany({
      where: { userId },
      orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
      include: { models: { orderBy: { createdAt: 'asc' } } },
    });
    return rows.map((row) => ({
      ...toWire(row),
      models: row.models.map(modelToWire),
    }));
  }

  async create(userId: string, input: CreateProviderConnectionBody): Promise<WireConnection> {
    const kind = toDbKind(input.kind);

    // Admitted BEFORE the row exists, so a refused endpoint leaves
    // nothing behind to clean up.
    let endpoint: string | null = null;
    if (input.endpoint !== undefined) {
      endpoint = (await this.admit(input.endpoint)).toString();
    }

    // The database enforces one connection per built-in kind with a partial
    // unique index; this check exists to turn that into a 409 with a sentence
    // rather than a 500 with a constraint name. The index is still the fence —
    // this is the message.
    if (kind !== 'CUSTOM') {
      const existing = await this.prisma.providerConnection.count({ where: { userId, kind } });
      if (existing > 0) {
        throw new ConflictException(
          `a ${input.kind} connection already exists — edit it, or use a custom connection ` +
            'if you need a second endpoint',
        );
      }
    }

    const created = await this.prisma.providerConnection.create({
      data: { userId, kind, name: input.name, endpoint },
    });

    if (input.apiKey !== undefined) {
      // Through the vault, never written here: this service has no business
      // holding the capability to encrypt (D-083).
      await this.credentials.setCredential(userId, created.id, input.apiKey);
      const withKey = await this.prisma.providerConnection.findFirst({
        where: { id: created.id, userId },
      });
      /* c8 ignore next -- the row was created in the line above. */
      if (withKey !== null) return toWire(withKey);
    }
    return toWire(created);
  }

  async update(
    userId: string,
    connectionId: string,
    input: UpdateProviderConnectionBody,
  ): Promise<WireConnection> {
    const existing = await this.findUserManaged(userId, connectionId);

    // Normalised the same way `create` does. `admitEndpoint` returns the
    // parsed URL precisely so the stored value is one form rather than
    // whatever was typed, and discarding it here would mean the same endpoint
    // is spelled one way when created and another when edited.
    let endpoint: string | undefined;
    if (input.endpoint !== undefined) {
      if (existing.kind !== 'CUSTOM') {
        throw new BadRequestException(
          'only a custom connection has an endpoint — the built-in providers’ endpoints ' +
            'belong to their SDKs',
        );
      }
      endpoint = (await this.admit(input.endpoint)).toString();
    }
    if (input.state === 'ACTIVE' && existing.credentialCiphertext === null) {
      // Otherwise a connection reports ACTIVE and 401s on every turn, which
      // is the state D-084 introduced NEEDS_CREDENTIAL to make visible.
      throw new BadRequestException(
        'this connection has no API key, so it cannot be made active — add a key first',
      );
    }

    const updated = await this.prisma.providerConnection.update({
      where: { id: connectionId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(endpoint !== undefined && { endpoint }),
        ...(input.state !== undefined && { state: input.state }),
      },
    });
    return toWire(updated);
  }

  /**
   * Delete a connection, unless something still points at one of its models.
   *
   * Its models cascade, so the check is over all of them at once: a bot on any
   * of them, or this user's default. Refusing is the point — the alternative
   * is a bot whose model stops existing in the middle of a conversation, which
   * surfaces as a failed turn with no obvious cause.
   */
  async remove(userId: string, connectionId: string): Promise<void> {
    await this.findUserManaged(userId, connectionId);
    const models = await this.prisma.providerModel.findMany({
      where: { connection: { id: connectionId, userId } },
      select: { id: true },
    });
    const ids = models.map((model) => model.id);
    if (ids.length > 0) await this.assertUnreferenced(userId, ids);

    await this.prisma.providerConnection.deleteMany({ where: { id: connectionId, userId } });
  }

  // ── Credentials ──────────────────────────────────────────────────────────

  async setCredential(userId: string, connectionId: string, apiKey: string): Promise<void> {
    await this.findUserManaged(userId, connectionId);
    const stored = await this.credentials.setCredential(userId, connectionId, apiKey);
    if (!stored) throw new NotFoundException('provider connection not found');
  }

  /**
   * Remove a credential. Never refused for a reference.
   *
   * Unlike deleting a model or a connection, this is the REVOCATION path:
   * someone removing a leaked key must not be told to go and repoint three
   * bots first. The models stay and become unavailable (D-084).
   */
  async clearCredential(userId: string, connectionId: string): Promise<void> {
    await this.findUserManaged(userId, connectionId);
    const cleared = await this.credentials.clearCredential(userId, connectionId);
    if (!cleared) throw new NotFoundException('provider connection not found');
  }

  // ── Models ───────────────────────────────────────────────────────────────

  async createModel(
    userId: string,
    connectionId: string,
    input: CreateProviderModelBody,
  ): Promise<WireModel> {
    const connection = await this.findUserManaged(userId, connectionId);
    if (connection.kind === 'ELEVENLABS') {
      // D-221: a model here would be offered to bots and fail every turn.
      throw new BadRequestException('an ElevenLabs connection is a voice key — it has no models');
    }
    const duplicate = await this.prisma.providerModel.findFirst({
      where: {
        connection: { id: connectionId, userId },
        upstreamModelId: input.upstreamModelId,
      },
      select: { id: true },
    });
    if (duplicate !== null) {
      // Two rows for one upstream id are two ids for one model, and a bot
      // pointed at the deleted one fails resolution while the picker still
      // shows the model as present.
      throw new ConflictException(`this connection already defines "${input.upstreamModelId}"`);
    }

    const created = await this.prisma.providerModel.create({
      data: {
        connectionId,
        upstreamModelId: input.upstreamModelId,
        label: input.label,
        contextWindow: input.contextWindow,
        supportsTools: input.capabilities.tools,
        supportsVision: input.capabilities.vision,
        supportsReasoning: input.capabilities.reasoning,
      },
    });
    return modelToWire(created);
  }

  async updateModel(
    userId: string,
    modelId: string,
    input: UpdateProviderModelBody,
  ): Promise<WireModel> {
    await this.findUserManagedModel(userId, modelId);
    const updated = await this.prisma.providerModel.update({
      where: { id: modelId },
      data: {
        ...(input.upstreamModelId !== undefined && { upstreamModelId: input.upstreamModelId }),
        ...(input.label !== undefined && { label: input.label }),
        ...(input.contextWindow !== undefined && { contextWindow: input.contextWindow }),
        ...(input.capabilities !== undefined && {
          supportsTools: input.capabilities.tools,
          supportsVision: input.capabilities.vision,
          supportsReasoning: input.capabilities.reasoning,
        }),
      },
    });
    return modelToWire(updated);
  }

  async removeModel(userId: string, modelId: string): Promise<void> {
    await this.findUserManagedModel(userId, modelId);
    await this.assertUnreferenced(userId, [modelId]);
    await this.prisma.providerModel.deleteMany({
      where: { id: modelId, connection: { userId } },
    });
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  async settings(userId: string): Promise<WireUserSettings> {
    const row = await this.prisma.userSettings.findFirst({ where: { userId } });
    // Created lazily on first write, so a user who has never chosen a default
    // reads as one who has not — rather than as a 404 the client has to
    // special-case on a route that always has an answer.
    return row === null
      ? {
          userId,
          defaultModelId: null,
          language: null,
          timezone: null,
          systemLanguage: null,
          systemTimezone: null,
          updatedAt: new Date(0),
        }
      : settingsToWire(row);
  }

  async updateSettings(userId: string, input: UpdateUserSettingsBody): Promise<WireUserSettings> {
    if (input.defaultModelId !== undefined && input.defaultModelId !== null) {
      // The FK would refuse a foreign model with a constraint error; this
      // refuses it as a 404, and — more importantly — refuses a model that
      // exists but belongs to somebody else without saying which it was.
      await this.findOwnedModel(userId, input.defaultModelId);
    }
    // Every field follows the same rule: absent leaves it alone, null clears
    // it. Spread per field so a body naming one setting cannot reset another.
    const { defaultModelId, language, timezone, systemLanguage, systemTimezone } = input;
    const changes = {
      ...(defaultModelId !== undefined && { defaultModelId }),
      ...(language !== undefined && { language }),
      ...(timezone !== undefined && { timezone }),
      ...(systemLanguage !== undefined && { systemLanguage }),
      ...(systemTimezone !== undefined && { systemTimezone }),
    };
    const row = await this.prisma.userSettings.upsert({
      where: { userId },
      create: { userId, ...changes },
      update: changes,
    });
    return settingsToWire(row);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async admit(endpoint: string): Promise<URL> {
    try {
      return await admitEndpoint(endpoint, this.resolver);
    } catch (error: unknown) {
      if (error instanceof EndpointRefusedError) {
        // 400, not 500: the operator typed it and can fix it. The guard's
        // message already names the range without echoing a resolver's own
        // text, so it is safe to surface.
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /** The same 404 for absent and foreign (bots.service.ts sets the precedent). */
  private async findOwned(userId: string, connectionId: string): Promise<ProviderConnection> {
    const row = await this.prisma.providerConnection.findFirst({
      where: { id: connectionId, userId },
    });
    if (row === null) throw new NotFoundException('provider connection not found');
    return row;
  }

  private async findOwnedModel(
    userId: string,
    modelId: string,
  ): Promise<ProviderModel & { connection: { kind: DbProviderKind } }> {
    const row = await this.prisma.providerModel.findFirst({
      where: { id: modelId, connection: { userId } },
      include: { connection: { select: { kind: true } } },
    });
    if (row === null) throw new NotFoundException('provider model not found');
    return row;
  }

  /**
   * D-157: the connection, if it is one a person manages.
   *
   * The `crewaid` connection is the server's: its models are the plan's list
   * and it has no key, so renaming, disabling, keying, deleting it or editing
   * its models would only make it disagree with what the plan provides — and a
   * key typed into it would be one nothing ever reads.
   */
  private async findUserManaged(userId: string, connectionId: string): Promise<ProviderConnection> {
    const row = await this.findOwned(userId, connectionId);
    if (row.kind === 'CREWAID') throw includedIsManaged();
    return row;
  }

  private async findUserManagedModel(userId: string, modelId: string): Promise<ProviderModel> {
    const row = await this.findOwnedModel(userId, modelId);
    if (row.connection.kind === 'CREWAID') throw includedIsManaged();
    return row;
  }

  /**
   * Refuse a delete that would strand a reference.
   *
   * `Bot.modelId` is a STRING column holding either the literal `default` or a
   * `ProviderModel` id — not a foreign key — because it also has to hold the
   * alias (D-082). So the database cannot refuse this on its own, and a count
   * here is the only fence. `UserSettings.defaultModelId` IS a foreign key
   * with `onDelete: Restrict`, and it is checked here anyway so the operator
   * gets a sentence rather than a constraint name.
   */
  private async assertUnreferenced(userId: string, modelIds: readonly string[]): Promise<void> {
    const bots = await this.prisma.bot.findMany({
      where: { userId, modelId: { in: [...modelIds] } },
      select: { name: true },
      take: 5,
    });
    if (bots.length > 0) {
      throw new ConflictException(
        `still in use by ${bots.map((bot) => bot.name).join(', ')} — point ${
          bots.length === 1 ? 'that bot' : 'those bots'
        } at another model first. Removing the API key instead takes effect immediately.`,
      );
    }

    const settings = await this.prisma.userSettings.findFirst({
      where: { userId, defaultModelId: { in: [...modelIds] } },
      select: { userId: true },
    });
    if (settings !== null) {
      throw new ConflictException(
        'still your default model — choose a different default first. ' +
          'Removing the API key instead takes effect immediately.',
      );
    }
  }
}

/**
 * Row → wire, and the ONLY way a row becomes a response.
 *
 * The three credential columns are dropped by construction rather than by a
 * `select` somewhere else that a future caller could forget: `hasCredential`
 * is the only thing said about the key, and there is no field on the wire type
 * it could travel in (D-083).
 */
function toWire(row: ProviderConnection): WireConnection {
  return {
    id: row.id,
    userId: row.userId,
    kind: fromDbKind(row.kind),
    name: row.name,
    endpoint: row.endpoint,
    authKind: 'api_key',
    state: row.state,
    hasCredential: row.credentialCiphertext !== null,
    credentialSetAt: row.credentialSetAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function modelToWire(row: ProviderModel): WireModel {
  return {
    id: row.id,
    connectionId: row.connectionId,
    upstreamModelId: row.upstreamModelId,
    label: row.label,
    contextWindow: row.contextWindow,
    capabilities: {
      tools: row.supportsTools,
      vision: row.supportsVision,
      reasoning: row.supportsReasoning,
    },
    createdAt: row.createdAt,
  };
}

/**
 * The wire kind is lowercase and the column is an uppercase Prisma enum.
 *
 * Two explicit maps rather than `toUpperCase()`: a cast would compile for any
 * string, so a kind added on one side and not the other would fail at runtime
 * on a row nobody tested. These fail to compile.
 */
const DB_KIND: Record<ProviderKind, DbProviderKind> = {
  openai: 'OPENAI',
  anthropic: 'ANTHROPIC',
  openrouter: 'OPENROUTER',
  custom: 'CUSTOM',
  crewaid: 'CREWAID',
  elevenlabs: 'ELEVENLABS',
};

const WIRE_KIND: Record<DbProviderKind, ProviderKind> = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  OPENROUTER: 'openrouter',
  CUSTOM: 'custom',
  CREWAID: 'crewaid',
  ELEVENLABS: 'elevenlabs',
};

export function toDbKind(kind: ProviderKind): DbProviderKind {
  return DB_KIND[kind];
}

export function fromDbKind(kind: DbProviderKind): ProviderKind {
  return WIRE_KIND[kind];
}

function includedIsManaged(): ConflictException {
  return new ConflictException(
    'the included models are managed by Crewaid — they come with your plan and cannot be changed',
  );
}
