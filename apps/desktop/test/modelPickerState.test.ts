import { describe, expect, it } from 'vitest';
import type { ModelOption } from '@crewaid/shared';
import {
  groupModelsByConnection,
  isDefaultOption,
  planSelection,
  resolveBotSelection,
  selectedOptionId,
  selectionSummary,
  unavailableReason,
} from '../src/renderer/components/composer/modelPickerState';

const OPENAI_CONNECTION = 'conn_openai_01';
const ANTHROPIC_CONNECTION = 'conn_anthropic_01';

function option(over: Partial<ModelOption> & Pick<ModelOption, 'id'>): ModelOption {
  return {
    connectionId: OPENAI_CONNECTION,
    connectionName: 'Work OpenAI',
    kind: 'openai',
    upstreamModelId: 'gpt-5-mini',
    label: 'GPT-5 mini',
    contextWindow: 400_000,
    capabilities: { tools: true, vision: true, reasoning: true },
    available: true,
    connectionState: 'ACTIVE',
    ...over,
  };
}

const models: ModelOption[] = [
  option({ id: 'pm_gpt5_mini' }),
  option({
    id: 'pm_haiku',
    connectionId: ANTHROPIC_CONNECTION,
    connectionName: 'Work Anthropic',
    kind: 'anthropic',
    upstreamModelId: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    capabilities: { tools: true, vision: true, reasoning: false },
  }),
  option({ id: 'pm_gpt5', upstreamModelId: 'gpt-5.1', label: 'GPT-5.1' }),
];

describe('model picker selection and grouping', () => {
  it('reads the bot row, and nothing remembered on this machine — V1-13', () => {
    // There used to be a third candidate here: a model id kept in
    // localStorage per bot, PREFERRED over the row. It made sense while
    // selecting changed nothing on the server. Now selecting is a PATCH, so a
    // remembered copy would be a second source of truth that wins over the
    // first — change a bot's model in one window and the other keeps sending
    // to the old one forever.
    expect(resolveBotSelection(models, 'pm_haiku', 'pm_gpt5_mini')).toEqual({
      kind: 'model',
      modelId: 'pm_haiku',
      viaDefault: false,
    });
  });

  it("resolves the `default` alias against THIS user's default", () => {
    // D-086: the alias is per-user now, because the key behind it is.
    expect(resolveBotSelection(models, 'default', 'pm_gpt5_mini')).toEqual({
      kind: 'model',
      modelId: 'pm_gpt5_mini',
      viaDefault: true,
    });
    // `viaDefault` is not decoration: it tells the operator that changing
    // their default moves this bot, and that choosing here pins it.
    expect(
      selectionSummary(resolveBotSelection(models, 'default', 'pm_gpt5_mini'), models).label,
    ).toContain('default');
  });

  it('says the default is unset rather than quietly picking one', () => {
    // THE CASE V1-13 CHANGED. This used to fall back to the first available
    // model. That was safe while the picker only remembered things locally;
    // now a selection WRITES to the bot, so an auto-pick would silently change
    // a bot's configuration just because somebody opened it.
    //
    // D-083 removed the environment fallback too, so there is genuinely
    // nothing behind the alias until the user chooses.
    const selection = resolveBotSelection(models, 'default', null);
    expect(selection).toEqual({ kind: 'unset' });
    expect(selectedOptionId(selection)).toBeNull();
    expect(selectionSummary(selection, models).notice).toContain('have not set one');
  });

  it('reports a bot pointing at a model that is gone, without printing its id', () => {
    const selection = resolveBotSelection(models, 'pm_deleted_last_week', 'pm_gpt5_mini');
    expect(selection).toEqual({ kind: 'missing', modelId: 'pm_deleted_last_week' });
    // The id is a cuid. Printing it invites someone to search a provider
    // dashboard for a string that was never on the wire (D-082).
    const summary = selectionSummary(selection, models);
    expect(summary.notice).not.toContain('pm_deleted_last_week');
    expect(summary.notice).toContain('no longer exists');
  });

  it('keeps an unavailable selection selected, and says why', () => {
    // D-086 lists it rather than hiding it; silently moving the selection
    // would mean the operator sees a working picker and never learns which
    // model stopped working.
    const dead = option({ id: 'pm_dead', available: false, connectionState: 'NEEDS_CREDENTIAL' });
    const selection = resolveBotSelection([dead], 'pm_dead', null);

    expect(selection).toEqual({ kind: 'model', modelId: 'pm_dead', viaDefault: false });
    expect(selectionSummary(selection, [dead]).notice).toBe('Work OpenAI has no API key');
  });

  it('marks exactly the option the alias resolves to', () => {
    expect(isDefaultOption(models[0]!, 'pm_gpt5_mini')).toBe(true);
    expect(isDefaultOption(models[1]!, 'pm_gpt5_mini')).toBe(false);
    // A user with no default marks nothing, rather than marking the first row.
    expect(models.some((model) => isDefaultOption(model, null))).toBe(false);
  });

  it('writes the row id, which is the only thing Bot.modelId may hold — D-082', () => {
    // `Bot.modelId` was a `provider:model` key once. That key stopped being
    // unique the moment a user could hold two custom connections: `custom:
    // llama-3` would name two endpoints with two credentials, and nothing in
    // the string says which.
    expect(planSelection('pm_haiku', models, null)).toEqual({
      nextId: 'pm_haiku',
      previousId: null,
    });
    expect(planSelection('pm_haiku', models, 'pm_gpt5')?.previousId).toBe('pm_gpt5');
  });

  it('writes nothing for an id this user cannot resolve', () => {
    // The list is owner-scoped (D-086), so an id from anywhere else — another
    // account's model, a stale link, a composed key someone still has — is one
    // this caller cannot run.
    expect(planSelection('openai:gpt-5.1', models, null)).toBeNull();
    expect(planSelection('pm_someone_elses', models, null)).toBeNull();
    expect(planSelection('', models, null)).toBeNull();
    expect(planSelection(null, models, null)).toBeNull();
    expect(planSelection(42, models, null)).toBeNull();
  });

  it('refuses to newly choose an unavailable model, but never un-chooses one', () => {
    // The asymmetry is the point. A model whose connection lost its key cannot
    // be picked — it would fail on send — but one that was ALREADY selected
    // stays, because dropping it silently is how "my model disappeared"
    // becomes the first symptom of a removed key (D-086).
    const dead = option({ id: 'pm_dead', available: false, connectionState: 'NEEDS_CREDENTIAL' });
    const catalog = [...models, dead];

    expect(planSelection('pm_dead', catalog, null)).toBeNull();
    expect(resolveBotSelection(catalog, 'pm_dead', null)).toEqual({
      kind: 'model',
      modelId: 'pm_dead',
      viaDefault: false,
    });
  });

  it('does not write when the choice is what is already selected', () => {
    // React Aria fires a selection change on re-open. A PATCH per popover is
    // a write with no change in it.
    expect(planSelection('pm_haiku', models, 'pm_haiku')).toBeNull();
  });

  it('groups by CONNECTION, not by provider kind — D-082', () => {
    // Two custom connections may both serve a model called `llama-3`, and
    // grouping by kind would put them in one bucket labelled "Custom" with no
    // way to tell which endpoint — and whose key — each belongs to.
    const groups = groupModelsByConnection(models);
    expect(groups.map((group) => group.connectionId)).toEqual([
      // Sorted by NAME, which is what a person scans: "Work Anthropic" first.
      ANTHROPIC_CONNECTION,
      OPENAI_CONNECTION,
    ]);
    expect(groups[1]?.models.map((model) => model.id)).toEqual(['pm_gpt5_mini', 'pm_gpt5']);
  });

  it('keeps two same-named connections apart and in a stable order', () => {
    // Nothing stops a user calling two connections "work". Grouping on the
    // NAME would merge them; ordering on the name alone would let them
    // reshuffle between renders.
    const duplicates = [
      option({ id: 'pm_a', connectionId: 'conn_b', connectionName: 'work' }),
      option({ id: 'pm_b', connectionId: 'conn_a', connectionName: 'work' }),
    ];
    const groups = groupModelsByConnection(duplicates);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.connectionId)).toEqual(['conn_a', 'conn_b']);
  });

  it('keeps an unavailable model in the list and says why — D-086', () => {
    // Hiding it is what makes "my model disappeared" the first symptom of a
    // removed key, in the one place someone would look for the reason.
    const dead = option({
      id: 'pm_dead',
      available: false,
      connectionState: 'NEEDS_CREDENTIAL',
      connectionName: 'Old OpenAI',
    });
    expect(groupModelsByConnection([dead])[0]?.models).toHaveLength(1);
    expect(unavailableReason(dead)).toBe('Old OpenAI has no API key');
    expect(unavailableReason(option({ id: 'pm_ok' }))).toBeNull();
  });
});
