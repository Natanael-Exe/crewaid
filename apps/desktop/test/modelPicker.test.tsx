import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ModelOption } from '@crewaid/shared';
import { ModelPicker } from '../src/renderer/components/composer/ModelPicker';

const models: ModelOption[] = [
  {
    id: 'pm_haiku',
    connectionId: 'conn_anthropic_01',
    connectionName: 'Work Anthropic',
    kind: 'anthropic',
    upstreamModelId: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    capabilities: { tools: true, vision: true, reasoning: false },
    available: true,
    connectionState: 'ACTIVE',
  },
  {
    id: 'pm_deepseek',
    connectionId: 'conn_openrouter_01',
    connectionName: 'House OpenRouter',
    kind: 'openrouter',
    upstreamModelId: 'deepseek/deepseek-v4-pro-0813',
    label: 'DeepSeek V4 Pro 0813 (OpenRouter)',
    contextWindow: 1_048_576,
    capabilities: { tools: true, vision: false, reasoning: true },
    available: true,
    connectionState: 'ACTIVE',
  },
];

function renderPicker(props: Partial<React.ComponentProps<typeof ModelPicker>> = {}): string {
  return renderToStaticMarkup(
    <ModelPicker botId="bot_quill_01" botModelId="default" models={models} {...props} />,
  );
}

describe('ModelPicker', () => {
  it('renders the connection name and the upstream model id, not the row id', () => {
    // D-082: the row id IS the identity, and a cuid tells an operator nothing.
    // What they recognise — and what they can check against a provider
    // dashboard — is the name the provider knows the model by, under the
    // connection that serves it.
    const output = renderPicker();

    expect(output).toContain('data-model-picker-state="ready"');
    expect(output).toContain('Work Anthropic');
    expect(output).toContain('claude-haiku-4-5');
    expect(output).toContain('Claude Haiku 4.5');
    expect(output).toContain('Tools');
    expect(output).toContain('Vision');
    expect(output).toContain('Reasoning');
    expect(output).toContain('House OpenRouter');
    expect(output).toContain('deepseek/deepseek-v4-pro-0813');
    // The kind still appears, beside the connection name rather than as the
    // group heading — two connections of one kind must stay distinguishable.
    expect(output).toContain('Anthropic');
    expect(output).toContain('OpenRouter');
  });

  it('lists a model whose connection lost its key, disabled, with the reason', () => {
    // D-086: present-and-unavailable, never hidden.
    const output = renderPicker({
      models: [
        {
          ...models[0]!,
          id: 'pm_dead',
          available: false,
          connectionState: 'NEEDS_CREDENTIAL',
        },
      ],
    });

    expect(output).toContain('Claude Haiku 4.5');
    expect(output).toContain('Work Anthropic has no API key');
  });

  it('renders a keyboard-accessible loading state without pretending a model is selected', () => {
    const output = renderToStaticMarkup(<ModelPicker botId="bot_quill_01" botModelId="default" />);

    expect(output).toContain('data-model-picker-state="loading"');
    expect(output).toContain('Loading models');
    expect(output).toContain('aria-label="Model"');
    expect(output).toContain('aria-haspopup="listbox"');
  });

  it('renders a truthful empty state and keeps the picker disabled', () => {
    const output = renderPicker({ models: [] });

    expect(output).toContain('data-model-picker-state="empty"');
    expect(output).toContain('No models available');
    expect(output).toContain('disabled');
  });

  it('reports a bot pointing at a model that is gone — without printing its id', () => {
    // This case used to assert the OPPOSITE: it rendered the stored value on
    // screen, because that value was a readable `provider:model` key. V1-13
    // makes `Bot.modelId` a row id (D-082), and a cuid on screen is an
    // invitation to search a provider dashboard for a string that was never
    // on the wire.
    const output = renderPicker({ botModelId: 'pm_deleted_last_week' });

    expect(output).toContain('data-model-picker-selection="missing"');
    expect(output).toContain('Unavailable model');
    expect(output).not.toContain('pm_deleted_last_week');
  });

  it('marks which option the `default` alias resolves to', () => {
    const output = renderPicker({ botModelId: 'default', defaultModelId: 'pm_haiku' });

    expect(output).toContain('data-model-picker-selection="model"');
    expect(output).toContain('data-model-picker-via-default="true"');
    expect(output).toContain('data-model-picker-selected="pm_haiku"');
    // The catalog attribute is the only rendered surface a static test can
    // see into, since the options live in a popover.
    expect(output).toContain('claude-haiku-4-5|Claude Haiku 4.5|Tools,Vision|available|default');
  });

  it('says the default is unset rather than selecting a model nobody chose', () => {
    // Selecting now WRITES to the bot, so an auto-pick on load would change a
    // bot's configuration just because somebody opened it.
    const output = renderPicker({ botModelId: 'default', defaultModelId: null });

    expect(output).toContain('data-model-picker-selection="unset"');
    expect(output).toContain('No default model');
    expect(output).not.toContain('data-model-picker-selected=');
    expect(output).toContain('have not set one');
  });
});
