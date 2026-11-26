import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import { ModelForm } from '../src/renderer/settings/ModelForm';
import { EMPTY_MODEL_DRAFT, type ModelDraft } from '../src/renderer/settings/connectionsState';

/**
 * V1-20 — the capability toggles are controls, not pictures of controls.
 *
 * ── THE BUG THIS FILE EXISTS FOR ────────────────────────────────────────────
 *
 * HeroUI's `Switch` is React Aria's `SwitchField`: a field wrapper — a `div`
 * with a label, a description slot and no control of its own. The checkbox that
 * carries `role="switch"`, the `onChange` and the keyboard handling is rendered
 * by `Switch.Content`, and by nothing else. Both switches in this app were
 * composed as `<Switch><Switch.Control><Switch.Thumb/></Switch.Control></Switch>`,
 * which renders a div, a track and a thumb: it reflects `isSelected`, it honours
 * `isDisabled`, and pressing it does NOTHING.
 *
 * That is what "I cannot turn Vision on" was. The toggle was never clickable,
 * so every model — including the vision ones — kept the draft defaults, and the
 * capability chip never appeared in the picker.
 *
 * ── WHY A STATIC RENDER CAN SEE IT ──────────────────────────────────────────
 *
 * The control is a real `<input type="checkbox" role="switch">` in the markup,
 * and React emits `checked` for a checkbox whose value is true. So the presence
 * of the input, the accessible name on it, and which of them read as on are all
 * assertable without a DOM. What no static render can prove is that a press
 * flips it; `e2e/settings-modal.spec.ts` does that against the real app.
 */

function render(initial?: ModelDraft): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <ModelForm
        {...(initial === undefined ? {} : { initial })}
        busy={false}
        submitLabel="Add model"
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />
    </I18nProvider>,
  );
}

/** Every `role="switch"` input in the markup, with whether it renders as on. */
function switches(html: string): ReadonlyArray<{ label: string; on: boolean }> {
  return [...html.matchAll(/<input[^>]*role="switch"[^>]*>/g)].map((match) => {
    const tag = match[0];
    return {
      label: /aria-label="([^"]*)"/.exec(tag)?.[1] ?? '',
      on: /\bchecked=""/.test(tag) || /\bchecked(?=[\s/>])/.test(tag),
    };
  });
}

describe('V1-20 — the capability toggles can be pressed', () => {
  it('renders one real switch per capability', () => {
    const found = switches(render());

    // All three, and each with the name RAC puts on the input — which is also
    // what a screen reader and a Playwright `getByRole('switch', {name})` see.
    expect(found.map((entry) => entry.label)).toEqual(['Tools', 'Vision', 'Reasoning']);
  });

  it('defaults all capabilities to enabled and honours an existing row draft on edit', () => {
    const fresh = switches(render());
    expect(fresh.find((entry) => entry.label === 'Tools')?.on).toBe(true);
    expect(fresh.find((entry) => entry.label === 'Vision')?.on).toBe(true);
    expect(fresh.find((entry) => entry.label === 'Reasoning')?.on).toBe(true);

    // An edit form opens on the row's own capabilities (V1-20), so a model
    // with capabilities turned off must not show up as if they were on.
    const edited = switches(render({ ...EMPTY_MODEL_DRAFT, vision: false, reasoning: false }));
    expect(edited.find((entry) => entry.label === 'Tools')?.on).toBe(true);
    expect(edited.find((entry) => entry.label === 'Vision')?.on).toBe(false);
    expect(edited.find((entry) => entry.label === 'Reasoning')?.on).toBe(false);
  });

  it('says what the vision flag does, which is not "gates a turn"', () => {
    // The old hint promised "Off hides it when an attachment is staged", and
    // no code has ever done that: the picker reads capabilities to draw a chip,
    // `unavailableReason` reads availability, and the turn path reads neither.
    // A hint is a claim about behaviour, so it has to be the true one.
    const html = render();
    expect(html).toContain('The model accepts images.');
    expect(html).toContain('Shown as a chip in the picker');
    expect(html).not.toContain('hides it when an attachment is staged');
  });
});
