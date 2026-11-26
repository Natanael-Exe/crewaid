# DESIGN.md

How the Crewaid desktop app (`apps/desktop`) should look and feel. Follow it for every visual and
interaction decision in the renderer. It describes Crewaid's own theme, which overrides HeroUI v3's
default theme: where HeroUI's defaults and this file disagree, this file wins.

The source of truth is the CSS. This file explains it; it does not replace it.

| File | What it owns |
|---|---|
| `apps/desktop/src/renderer/styles/themes/crewaid.css` | Every token: Day (`crewaid`) and Night (`crewaid-dark`), the type scale, Tailwind mappings |
| `apps/desktop/src/renderer/styles/glass.css` | The glass material on HeroUI's component classes, high-contrast and forced-colors fallbacks |
| `apps/desktop/src/renderer/styles/room.css` | Shell layout, wallpapers, bubbles, per-component geometry |
| `apps/desktop/src/renderer/styles/components.css` | The few component styles utilities don't express (shimmer, sheet, list view) |
| `apps/desktop/src/renderer/styles/botAccent.ts` | Per-bot accent colors and their readable ink |
| `apps/desktop/src/renderer/components/ui/` | Crewaid's own composed components (ListView, Sheet, Segment, Kanban, KPI, charts…) |

If you change a token or a rule in those files, update this file in the same change.

## The idea

The app is a **room**: a painted sky wallpaper (dawn by Day, twilight by Night) with frosted-glass
panels floating over it. Bots are the crew who live there. Each bot brings its own color, but the
room itself stays neutral. The look is calm and editorial: tone and frost separate things, not
outlines and drop shadows.

## Themes

- Two themes, chosen by `data-theme` on `<html>` (`styles/themePreference.ts`): **Day** `crewaid`
  and **Night** `crewaid-dark`. HeroUI's own `light`/`dark` themes are never used.
- All colors are `oklch`. Never hardcode a color in a component; use a semantic token or its
  Tailwind utility (`bg-surface`, `text-foreground`, `text-muted`, `border-separator`,
  `bg-glass`, `text-room-foreground`, `bg-message-bot`, `text-needs-you`, `bg-chart-1`…).
- Never write a mode-specific color. A token already has its Day and Night values; if a new one is
  needed, add it to both blocks in `crewaid.css` and map it in an `@theme inline` block.
- The wallpaper is dimmed by `--wallpaper-veil` and `--wallpaper-filter` so paper reads cleanly
  over the sky. Text that sits directly on the wallpaper uses `--room-foreground` and
  `--room-muted` (a violet-tinted ink), not `--foreground`.

## Color roles

| Role | Tokens | Day | Night |
|---|---|---|---|
| Canvas | `--background` | cool near-white | deep indigo |
| Ink | `--foreground`, `--muted`, `--foreground-faint` | near-black, slate, faint slate | lavender white, muted lavender |
| Room ink | `--room-foreground`, `--room-muted` | violet-black | lavender white |
| App accent | `--app-accent` → `--accent` | exactly `#000000` | lavender white |
| Soft accent | `--accent-soft`, `--accent-soft-foreground` | 8% accent on white | 24% accent on indigo |
| Status | `--success`, `--warning`, `--danger` | saturated mid-tones | lighter, softer tones |
| Needs you | `--needs-you` | magenta | pink |
| Charts | `--chart-1` … `--chart-6` | blue, green, amber, red, violet, teal | lighter versions of the same hues |

- The app's own accent is **ink, not a hue**: black by Day, lavender-white by Night. Color comes
  from bots, never from the chrome.
- `--needs-you` is reserved for "a bot is waiting on the person" (approvals, questions). Don't use
  it for decoration or for ordinary errors (`--danger`).
- Charts use the `--chart-*` series in order, through `components/ui/charts` (`CHART_COLORS`).

## Per-bot accent

- A bot's stored hex color becomes `--bot-accent*` tokens on `<html>` (`useBotAccent`). Only
  elements inside `.crewaid-bot-context` remap `--accent`, `--accent-soft`, `--focus` and `--link`
  to the bot's color. Everything else (settings, Work navigation, portaled menus and creation
  dialogs) stays on the neutral app accent.
- The bot's color is kept exact. Readable ink is computed for it (WCAG 4.5:1 against its own soft
  fill, in both themes), so never put text in a raw bot color yourself; use
  `--accent-soft-foreground` or `--accent-control-foreground`.
- Messages from another bot (`data-from-bot`) get only a whisper of that bot's color
  (`--peer-accent` at about 4.5%), never a colored border.

## Glass

Four levels of translucency, all over the wallpaper:

| Level | Tokens | Use |
|---|---|---|
| Glass | `--glass` + `--glass-filter` | Side panels: crew dock, right rail, profile, Work panes |
| Strong glass | `--glass-strong` | Dialogs and cards that need to read as nearly solid |
| Surface | `--surface`, `--surface-secondary`, `--surface-tertiary` | Content cards, list views, fields' bright backing |
| Overlay | `--overlay` + `--overlay-shadow` | Popovers, menus, selects, tooltips |

- **Glass is for the floating layer only**: shell panels, overlays, the top bar and the composer.
  Content *inside* a panel (cards, chips, fields, buttons, bubbles) is plain tinted fill. Never
  add a `backdrop-filter` inside something that is already blurred; it shows nothing and costs a
  GPU pass per element.
- **Side panels are structure, not floating**: frost and shape only, a transparent 1px border and
  no shadow. Lift (`--glass-shadow`, `--overlay-shadow`, the specular rim) is reserved for what
  really floats: popovers, dialogs, the welcome and gate cards.
- Large surfaces use `corner-shape: squircle` where Chromium supports it.
- Every glass surface has a solid fallback under `prefers-contrast: more` and
  `forced-colors: active` in `glass.css`. A new glass class must be added to those lists.

## Typography

- **Inter** (`--font-sans`, weights 400/500/600) for all UI. Body text is 15px with a 1.45 line height.
- **Fraunces** (`--font-display-room`) is kept for editorial moments only: welcome, the sign-in and
  plan gate, Templates, and document titles. Operational headings (the transcript header, pane
  titles) use Inter. Using Fraunces sparingly is what keeps it meaningful.
- Use the type scale utilities, never arbitrary pixel sizes:

  | Utility | Size | Utility | Size |
  |---|---|---|---|
  | `text-micro` | 11px | `text-headline` | 17px |
  | `text-caption` | 12px | `text-heading` | 20px |
  | `text-footnote` | 13px | `text-title` | 28px |
  | `text-callout` | 14px | `text-display` | 40px |
  | `text-body` | 15px | | |

- 11px is the floor; nothing in the app is smaller.
- The scale sets sizes only. Line height stays with the element, because the virtualized roster and
  the composer measure fixed row heights.
- Form labels are 12px (`text-caption`), not HeroUI's 14px.
- Text written by people or bots uses `unicode-bidi: plaintext` so each paragraph reads in its
  own direction; code always reads left to right.

## Shape

The radius scale is **concentric**: an inner corner equals the outer corner minus the padding.

| Element | Radius |
|---|---|
| Room panels | 24px (`--radius-panel`) |
| List views | 22px |
| Message bubbles | 20px (`--radius-message`) |
| Menus, selects, popovers | 18px, items 14px inside a 4px inset |
| Cards | 14px (`--radius-card`, `--radius`) |
| Fields | 12px (`--radius-field`); HeroUI fields 10px (`--field-radius`) |
| Pills, top-bar and floating room controls | full (`--radius-pill`, `--radius-control`) |

- HeroUI derives popover radii from `--radius` (×2, ×3). Crewaid's 14px base would turn that into
  28–32px pills that out-round the panels they open over, so menus are pinned at 18px. Keep it
  that way.
- Everything in the top bar is 36px tall (`--control-height-topbar`).

## Elevation and separation

- Separate by **tone, not outline**. Bot bubbles are paper (`--message-bot`). The person's bubbles
  are a translucent cool silver (`--message-user`). Neither has a border.
- Lists are one flat card with hairline `--separator` rows (`ListView`), never a stack of cards
  each with its own shadow.
- Use `--surface-shadow` for content cards that need a little lift and `--overlay-shadow` for what
  floats. Don't invent shadows.
- Fields on a translucent band get their own bright surface; a dark tint over the wallpaper turns
  muddy.

## Motion

- Tokens: `--motion-fast` 120ms, `--motion-enter` 220ms, `--motion-exit` 160ms, eased with
  `--motion-ease` (`cubic-bezier(0.2, 0.8, 0.2, 1)`).
- Hover states change instantly (`transition: none`); an eased hover fill reads as lag.
- A working bot shows a shimmer across muted text (`.crewaid-shimmer`, `TextShimmer`), not a
  spinner.
- Respect both `prefers-reduced-motion` and the app's own `data-reduce-motion="true"`: turn the
  animation off and leave a readable still frame.

## Components

- Build with HeroUI v3 components (compound parts, `onPress`) and Crewaid's composed components
  in `components/ui/` before writing new markup. `ListView`, `Sheet`, `Segment`, `ItemCard`,
  `EmptyState`, `Kanban`, `KPI`, `Timeline`, `Stepper` and the charts already carry the look.
- Restyle HeroUI through tokens or its BEM classes inside `@layer components` (as `glass.css`
  does), never with one-off overrides on a single instance.
- Icons come from `@tabler/icons-react`.
- Full-window focus views use `Sheet`: the room stays visible behind it as a frosted, tinted blur,
  so the person keeps their place.
- Focus rings use `--focus` (2px). It follows the bot's accent inside bot context.
- Scrollbars are thin with a thumb at 3:1 contrast over glass.

## Code

- Code reads left to right in a monospace face, in both Markdown fences (Streamdown) and tool
  cards (`components/code/CodeView`). Both use one dependency-free highlighter
  (`components/markdown/highlight.ts`) that emits only `hljs-*` classes, never HTML.
- Token colors are semantic tokens, set in `app.css`: keywords, titles and TOML sections in
  `--accent-soft-foreground`, strings `--danger`, numbers and literals `--warning`, comments
  `--crewaid-muted-foreground` (not `--muted`, which Markdown repurposes as a fill).
- A diff uses the status colors: added lines `--success`, removed lines `--danger`, each row tinted
  with 12% of its color; hunk and file headers are muted.
- Line numbers and `+`/`-` markers are generated content (`::before` from data attributes) in
  `--foreground-faint`, so selecting code and copying it picks up only the code.

## Copy and i18n

- Every user-facing string lives in `apps/desktop/src/renderer/i18n/messages/en/`. Never hardcode
  text in a component.
- Layouts must survive longer translations and right-to-left languages. Use logical properties
  (`padding-inline`, `text-align: start`). The macOS window buttons stay on the left whatever the
  language.

## Do

- Use semantic tokens and their Tailwind utilities for every color, radius and shadow.
- Keep the app chrome neutral and let the selected bot bring the color.
- Put one primary action in each context, in the accent control color.
- Check every new screen in Day and Night, over the wallpaper, and with increased contrast.

## Don't

- Don't use HeroUI's default palette, its `light`/`dark` themes, or its default radius scale.
- Don't hardcode `#hex`, `rgb()` or `oklch()` values in components.
- Don't nest glass in glass, or add a shadow or rim to the side panels.
- Don't use Fraunces for operational UI, or text smaller than 11px.
- Don't separate content with borders where a change of tone will do.
- Don't use `--needs-you` or the bot's raw color for anything but their purpose.
