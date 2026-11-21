import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ProviderKind as DbProviderKind } from '@prisma/client';
import {
  MODEL_REF_DEFAULT,
  type ModelCapabilities,
  type ModelOption,
  type ProviderKind,
} from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { CredentialService } from '../credentials/credential.service.js';
import { fromDbKind } from '../providers/provider-connections.service.js';
import type { AddressResolver } from '../providers/endpoint-guard.js';
import type { ProviderBinding } from './provider-factory.js';
import { buildTextAdapter, type BuiltTextAdapter } from './tanstack/text-adapter.js';
import {
  INCLUDED_MODELS,
  IncludedModelsUnavailableError,
  type IncludedModels,
} from './included-models.port.js';
import { ModelSetupError } from './model-setup-error.js';

/**
 * Owner-scoped model resolution.
 *
 * `resolveModel(botModelId)` became `resolve(userId, modelRef)`: asynchronous,
 * reading the caller's own rows, returning the connection, the upstream model
 * id, the capabilities and a callable model together.
 *
 * ⚠️ THERE IS NO GLOBAL AUTHENTICATED REGISTRY ANY MORE, and that is the
 * point rather than a side effect. A process-wide registry holding three keys
 * cannot be correct on an install with two users: whichever key it holds is
 * somebody's, and every turn bills it.
 *
 * The credential is read through `CredentialService`, never decrypted here and
 * never taken from the environment — one service holds that capability so the
 * R7 audit surface is one file.
 */

/** Why a model reference could not become a callable model. */
export class DefaultModelUnsetError extends ModelSetupError {
  readonly code = 'DEFAULT_MODEL_UNSET' as const;
  constructor() {
    super({ key: 'defaultModelUnset' });
    this.name = 'DefaultModelUnsetError';
  }
}

export class UnknownModelError extends ModelSetupError {
  readonly code = 'UNKNOWN_MODEL' as const;
  constructor(readonly modelRef: string) {
    // Deliberately does not distinguish "no such model" from "not yours", and
    // does not quote the id: this message reaches a transcript, the id came
    // from a row the caller may not own, and a row id means nothing to the
    // person reading it.
    super({ key: 'unknownModel' });
    this.name = 'UnknownModelError';
  }
}

export class ModelNeedsCredentialError extends ModelSetupError {
  readonly code = 'MODEL_NEEDS_CREDENTIAL' as const;
  constructor(readonly connectionName: string) {
    super({ key: 'modelNeedsCredential', connection: connectionName });
    this.name = 'ModelNeedsCredentialError';
  }
}

/**
 * A resolved model: everything one operation needs, read at its start, and
 * the adapter that calls it. The credential is consumed building the adapter
 * and is never a field here.
 */
type ResolvedModelRow = {
  /** `ProviderModel.id` — what `Bot.modelId` stored. */
  readonly modelId: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly kind: ProviderKind;
  readonly upstreamModelId: string;
  readonly label: string;
  readonly contextWindow: number;
  readonly capabilities: ModelCapabilities;
};

export type ResolvedTextModel = Omit<ResolvedModelRow, 'kind'> &
  BuiltTextAdapter & {
    /**
     * One of the plan's included models, on the platform's account
     * rather than the person's — so a provider's refusal is not theirs to act
     * on, and is not quoted to them.
     */
    readonly included: boolean;
  };

@Injectable()
export class ModelResolutionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CredentialService) private readonly credentials: CredentialService,
    // Present only on a cloud server that bills.
    @Optional() @Inject(INCLUDED_MODELS) private readonly included?: IncludedModels,
  ) {}

  private resolver: AddressResolver | undefined;
  /** Test seam: the DNS resolver the guarded fetch uses for custom endpoints. */
  setAddressResolverForTests(resolve: AddressResolver | undefined): void {
    this.resolver = resolve;
  }

  /**
   * Resolve a `Bot.modelId` for its owner, as a text adapter.
   *
   * Every failure is typed, and the three are genuinely different actions for
   * the operator: choose a default, pick a model that exists, or add a key.
   * Collapsing them into one "model unavailable" sends people to the wrong
   * settings page. An included model is built by the billing module with its
   * meter around it; on a server without one it is unavailable,
   * never free.
   */
  async resolveText(userId: string, modelRef: string): Promise<ResolvedTextModel> {
    const row = await this.rowFor(userId, modelRef);
    let built: BuiltTextAdapter;
    if (row.connection.kind === 'CREWAID') {
      if (this.included === undefined) throw new IncludedModelsUnavailableError();
      built = {
        kind: 'openrouter',
        adapter: await this.included.textAdapter(userId, row.upstreamModelId),
      };
    } else {
      built = buildTextAdapter(
        await this.bindingFor(userId, row.connection, row.upstreamModelId),
        this.resolver === undefined ? {} : { resolve: this.resolver },
      );
    }
    return {
      modelId: row.id,
      connectionId: row.connection.id,
      connectionName: row.connection.name,
      upstreamModelId: row.upstreamModelId,
      label: row.label,
      contextWindow: row.contextWindow,
      capabilities: {
        tools: row.supportsTools,
        vision: row.supportsVision,
        reasoning: row.supportsReasoning,
      },
      ...built,
      included: row.connection.kind === 'CREWAID',
    };
  }

  private async rowFor(userId: string, modelRef: string) {
    const modelId =
      modelRef === MODEL_REF_DEFAULT ? await this.defaultModelIdFor(userId) : modelRef;
    const row = await this.prisma.providerModel.findFirst({
      where: { id: modelId, connection: { userId } },
      include: { connection: true },
    });
    if (row === null) throw new UnknownModelError(modelRef);
    if (row.connection.state === 'DISABLED')
      throw new ModelNeedsCredentialError(row.connection.name);
    return row;
  }

  private async bindingFor(
    userId: string,
    connection: { id: string; name: string; kind: DbProviderKind; endpoint: string | null },
    upstreamModelId: string,
  ): Promise<ProviderBinding> {
    const apiKey = await this.credentials.credentialFor(userId, connection.id);
    if (apiKey === null) throw new ModelNeedsCredentialError(connection.name);
    return {
      kind: fromDbKind(connection.kind),
      apiKey,
      endpoint: connection.endpoint,
      upstreamModelId,
    };
  }

  /**
   * What `GET /models` returns.
   *
   * Still not a live fan-out to the providers' own model endpoints — the
   * D-003 property that mattered survives. What changed is that the list is
   * derived from the caller's rows rather than from the process's environment.
   *
   * A model whose connection cannot serve a turn is RETURNED, with
   * `available: false`. Omitting it makes "my model disappeared" the first
   * symptom of a removed key, in the one place someone would go to find out
   * why it stopped working.
   */
  async options(userId: string): Promise<{ models: ModelOption[]; defaultModelId: string | null }> {
    // The included models are listed like any connection's, so they
    // are made sure of first.
    await this.included?.ensureFor(userId);
    const rows = await this.prisma.providerModel.findMany({
      where: { connection: { userId } },
      include: { connection: true },
      orderBy: [{ connection: { kind: 'asc' } }, { label: 'asc' }],
    });

    const models = rows.map((row) => ({
      id: row.id,
      connectionId: row.connection.id,
      connectionName: row.connection.name,
      kind: fromDbKind(row.connection.kind),
      upstreamModelId: row.upstreamModelId,
      label: row.label,
      contextWindow: row.contextWindow,
      capabilities: {
        tools: row.supportsTools,
        vision: row.supportsVision,
        reasoning: row.supportsReasoning,
      },
      // An included model on a server that no longer bills cannot run.
      available:
        row.connection.state === 'ACTIVE' &&
        (row.connection.kind !== 'CREWAID' || this.included !== undefined),
      connectionState: row.connection.state,
    }));

    return { models, defaultModelId: await this.effectiveDefaultIdFor(userId) };
  }

  /** The per-user replacement for `DEFAULT_MODEL_ID`. */
  private async defaultModelIdFor(userId: string): Promise<string> {
    const effective = await this.effectiveDefaultIdFor(userId);
    if (effective === null) throw new DefaultModelUnsetError();
    return effective;
  }

  /**
   * Which model `Bot.modelId === 'default'` actually runs — and what the
   * picker labels "Default" — as the ONE resolution both callers share.
   *
   * The user's choice wins when there is one. When there is not, the answer
   * used to be "nothing", and nothing is not a state a bot can be in: every
   * newly created bot carries the `default` alias (BotsService.create), so a
   * user who never opened the settings' model picker had bots whose first
   * turn failed with DEFAULT_MODEL_UNSET — and a composer that showed no
   * model selected, for a bot that plainly needed one.
   *
   * The fallback is the first model on an ACTIVE connection, ordered the way
   * the picker lists them — the model an operator would have picked if asked,
   * and the same one `options()` now reports as the default, so the label and
   * the turn cannot disagree. `null` still means "there is genuinely nothing
   * to run": no model rows, or only ones whose connections need a key. That
   * case keeps `DefaultModelUnsetError`'s sentence, because "add a
   * connection" is the action it should send someone to.
   */
  private async effectiveDefaultIdFor(userId: string): Promise<string | null> {
    const settings = await this.prisma.userSettings.findFirst({
      where: { userId },
      select: { defaultModelId: true },
    });
    const configured = settings?.defaultModelId;
    if (configured !== undefined && configured !== null) return configured;

    const fallback = await this.prisma.providerModel.findFirst({
      where: { connection: { userId, state: 'ACTIVE' } },
      orderBy: [{ connection: { kind: 'asc' } }, { label: 'asc' }],
      select: { id: true },
    });
    return fallback?.id ?? null;
  }
}
