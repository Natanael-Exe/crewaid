# M1 Frontend — Component Inventory (BUILD vs COMPOSE)

**Owner:** Nathan (frontend) · **Status:** pre-M1, blocked on Paul's M0
**Governing decision:** D-001 — HeroUI free core only. No Pro license.
Where PRD §2.5 says "start from the Pro Chat template and Pro Sidebar", D-001 wins.

Everything below was **verified against the installed tree**, not recalled:
`@heroui/react@3.2.4`, `react-aria-components@1.21.0` in `node_modules`, plus the
free MCP server (`npx -y @heroui/react-mcp@latest`, stdio) — the M1-FE-02 wiring.

Repro: `python3 scripts/heroui-mcp-probe.py` · `python3 scripts/heroui-mcp-docs.py`

---

## 0. Verification summary

| Check | Result |
|---|---|
| Free v3 component count | **71** components in the index |
| Ben's 20 named primitives | **20/20 present** in installed 3.2.4 — none missing |
| `Virtualizer` / `ListLayout` | Present, re-exported by HeroUI from `react-aria-components` |
| Variable-height virtualization | **Supported** — `estimatedRowSize` + `updateItemSize(key, size)` |
| `DropZone` / `FileTrigger` | In `react-aria-components`, **not** re-exported by HeroUI — import direct |
| `TextArea` auto-grow | **Absent.** Props are `rows`, `cols`, `value`, `defaultValue`, `onChange`, `placeholder`, `disabled`, `readOnly` |

Bottom line: **the free tier is sufficient. No blocking gap.** Four items need
real engineering that the Pro template would have absorbed, and one dependency
decision is genuinely unbudgeted (§3.1, markdown rendering).

---

## 1. COMPOSE — free primitives carry these

| Task | Composition | Notes |
|---|---|---|
| M1-FE-03 Bot sidebar | `ListBox` + `ListBox.Section` + `ListBox.Item` + `Surface` + `Avatar` + `Chip` + `Kbd` | `selectionMode="single"` + `onAction`. Rows are BOTS. `renderEmptyState` for zero-bot. `disabledKeys` covers `hiddenFromSidebar`. Anatomy per ref-01: pinned-bot card ABOVE a small-caps group header ("Sales team"), rows = avatar + semibold name + tiny bordered role chip + timestamp + one-line muted ellipsized preview; footer = Plugins + user row. **Groups are NOT in the PRD — build the flat list; header styling ships only if Ben ratifies groups.** |
| M1-FE-09 Design tokens | `get_theme_variables` → oklch token set, `color-mix` derived | **LIGHT THEME FIRST — confirmed by design refs.** Dark-mode theming cut from M1; tokens structured so dark can come later. Token sheet in `docs/design/UI-SPEC.md`. Accent = **blue #2563EB** (decided 2026-09-02; ref-03 style reference retracted) — kept as a swappable `--accent` var. `Bot.avatarColor` is hex — feeds a per-bot CSS var. |
| M1-FE-10 Model picker | `Autocomplete` (+ `Virtualizer`, it supports it) | OpenRouter alone is hundreds of ids → typeahead required, not a `Select`. Groups by `provider`; `Chip`s for `capabilities`. |
| M1-FE-08 Attachment chips | `TagGroup` + `Chip` + `Card` (download cards) | See §2.3 — the drop target itself is RAC, not HeroUI. |
| Connection status (FE-06) | `Chip` + `Tooltip` + `Toast` | Reconnect backoff surface. |
| Errors (D-006) | `Alert` + `Toast` | Switch on the 9-code Zod enum. Never render `detail`. |
| Loading | `Skeleton`, `Spinner`, `ProgressCircle` | |
| Modals (M6-FE) | `Modal`, `Drawer`, `Popover`, `Tabs` | |

## 2. BUILD — no free component exists

### 2.1 Part-renderer registry — M1-FE-05 ⚠️ load-bearing
Not a UI-library problem at all. A `Map<partType, Renderer>` with a fallback for
unknown types, plus the `Message.parts` (AI SDK, verbatim) traversal.

The acceptance criterion is architectural: adding tool-call parts (M5), approval
prompts (M5), and inter-bot attribution (M7) must not touch the transcript
component. Design intent — the transcript renders `parts.map(part => registry.resolve(part.type))`
and knows nothing else. Registration happens at module scope in feature folders.
An unknown type renders the fallback, never throws, never blanks the transcript.

Registry entries known today: **text**, **system-event** (tiny centered muted text,
no bubble — "Renamed to Chief of staff" per ref-01; maps to `MessageAuthor.SYSTEM`
from the D-006 vocabulary), **fallback**. Tool-call/approval/attribution arrive in
M5/M7 by registration only.

### 2.2 Transcript shell — M1-FE-04
`Card` + `Surface` + `Avatar` + `ScrollShadow` cover the *chrome*. The hard parts are ours:
message grouping (consecutive same-author collapse), day separators, and
virtualization. See §3.2 — resolved by spike 001 (hybrid).

Bubble params from the refs: bot = light-gray bubble left; user = black bubble,
white text, right; max-width ~70%; same-author stacks with small gaps; date
separator = small muted centered ("Today 2:30 PM"). Transcript bubbles carry **no
per-message avatar** — attribution is alignment + bubble color; avatars appear only
in the pane header.

### 2.3 Composer auto-grow — M1-FE-07
`TextArea` has **no** auto-grow. Two options: `field-sizing: content` (CSS, small
compat surface) or the `scrollHeight` measurement loop with a max-height clamp.
Plus send/stop state machine, `Enter` submit / `Shift+Enter` newline, and IME
composition handling (`compositionstart`/`end`) so Enter doesn't fire mid-composition.

Visual per ref-01: pill input, `+` (attach) at left *inside*, placeholder
`Message «bot name»`, black circular voice button at right inside. **Voice button
is RULED (Ben, 2026-09-02): render disabled** — visible but no-op, tooltip
"Coming in v2". Rationale: the composer layout must not change when voice ships
in v2; omitting the button now would be a layout regression later. Voice itself
stays deferred per PRD §1.5.

### 2.4 App shell / resizable panes
There is **no** `Resizable` or `Splitter` in the 71. The three-pane layout
(sidebar │ transcript │ right rail for the M2 VNC thumbnail) needs hand-built
drag dividers with persisted widths and collapse. Small, but real, and it lands
in M1 even though the rail fills up in M2.

Dimensions from the refs (M1-FE-12 builds to these): sidebar **~275px fixed**;
transcript fluid; right rail **~355px default**, user-widenable toward ~700px
(ref-02) and collapsible via `»` to hand the width to the transcript. Screen card
scales with the rail (client-side only, R8). Practical min-widths: rail ≥ ~300px,
transcript ≥ ~480px.

### 2.5 Command/shortcut system
`Kbd` renders the hint only. The `⌘1..9` bot-switch bindings, focus routing, and
conflict handling with Electron's app menu are ours.

## 2A. Design-reference deltas (docs/design/, authoritative for visuals)

Screenshots from Natanael (2026-09-01), spec extracted in `docs/design/UI-SPEC.md`.
Verified against the actual PNGs, not just the written spec. Everything shown is
**composeable from the verified free set** — the BUILD-vs-COMPOSE split stands.

What changes in M1:

1. **LIGHT THEME, light-first.** Warm near-white (`--bg-app: #F7F6F4`), near-black text,
   hairline borders, minimal shadows, large radii (bubbles ~18px, cards ~14px, inputs
   ~12px). Dark-mode theming is CUT from M1-FE-09; tokens stay swappable for later.
2. **Bubbles, not full-width rows.** Bot = light-gray bubble left-aligned; user =
   **black bubble / white text** right-aligned; max-width ~70%; consecutive same-author
   stack with small gaps (groups cleanly with M1-FE-04's grouping logic). Notably,
   transcript bubbles carry NO per-message avatar — attribution is alignment + color;
   avatars appear only in the transcript header.
3. **NEW part renderer for the registry (M1-FE-05): SYSTEM event.** Tiny centered
   muted text, NO bubble — e.g. "Renamed to Chief of staff". Maps to `MessageAuthor.SYSTEM`
   in the D-006 vocabulary. Registry entry count: text, system-event, fallback.
4. **Sidebar anatomy per ref-01** (updated in §1): pinned-bot card, small-caps group
   header, row anatomy, footer Plugins + user row. Groups pending Ben — flat list ships.
5. **Right rail (M2 target, shell lands in M1-FE-12):** live-screen card captioned
   "«bot»'s screen" with `»` collapse, and a routines EMPTY STATE ("Routines are
   recurring tasks this Bot runs on a schedule." + Create Routine pill) — M8's panel
   home. In ref-02 the rail widens toward ~700px, the screen card scales with it
   (client-side only, R8), the sidebar stays fixed, and the transcript compresses —
   so pane min-widths: rail ≥ ~300px, transcript ≥ ~480px.
6. **Edit-profile modal (builds in M1, shape grid pending):** structure = large centered
   avatar, segmented tabs `Bot | Generate | Upload | Pet`, Title (=`Bot.role`) +
   Description (=`Bot.systemPrompt`), `› Advanced` disclosure (model picker per D-003,
   skills, toolsets, SOUL.md), footer Cancel + blue filled Save. The screenshots'
   **shape+color avatar system (blob faces, 12 swatches, "Match the name" hash
   derivation) is RICHER than the PRD's single `avatarColor` hex** — needs an
   `avatarShape` schema decision from Ben. Do NOT build it yet; modal structure + fields
   only.
7. **Voice button — RULED, render disabled.** Visible black circular mic per ref-01,
   no-op with a "Coming in v2" tooltip. Composer layout must not shift when voice
   lands in v2. (Ben, 2026-09-02.) Composer otherwise: pill input, `+` attach at
   left inside, placeholder `Message «bot name»`.
8. **Accent = BLUE `#2563EB`** — decided 2026-09-02 by retraction of ref-03 (the
   terracotta dashboard was an external style reference, accidentally committed).
   Keep `--accent` swappable regardless.

### 2.6 Known and already scoped as ours
- VNC canvas (M2-FE) — RFB bound to `<canvas>`, client-side scaling only (R8).
- WS client (M1-FE-06) — envelope validation against `ServerFrameSchema`, backoff 1s→30s.
- `safeStorage` token handling (CC-07) — main-process only, never the renderer.

---

## 3. Gaps and risks — flagged now, not in week three

### 3.1 Markdown + syntax highlighting — RULED, now M1-FE-11 ✅
No component library ships this and nothing in `apps/desktop/package.json` covers
it, yet every bot reply is markdown with code blocks. **D-008 puts it in scope as
M1-FE-11 (+2d).**

The binding requirement: the renderer must tolerate **incomplete markdown on every
frame**. An unterminated fence, table, or list renders as in-progress content —
never as raw source, and never as a layout jump when it closes. That means picking
a parser built for *incremental* input, not retrofitting a batch renderer with an
"is it still streaming" flag.

### 3.2 Virtualization vs. streaming — RESOLVED by spike 001 ✅
`ListLayout` does support variable heights (`estimatedRowSize`, `updateItemSize`),
so virtualization is viable. The conflict was that the **streaming message changes
height as it grows**, and re-measuring a virtualized row causes layout thrash and
fights "pin to bottom".

**Spiked and answered — see `spikes/001-virtualization-vs-streaming/`.**
Verdict: **hybrid**. Virtualize settled history; render the in-flight message in
normal flow beneath the virtualizer; promote it on `message.completed`.

Two findings, both from reading the installed package source:
- Relayout count is **21 per reply, not 363** — height changes on line *wrap*, not
  per token. The original fear was overstated ~17×.
- The real blocker is **pin-to-bottom**, not relayout cost. React Aria's
  `ScrollAnchorTracker` only engages when the layout implements
  `UNSTABLE_getScrollAnchorInfo` (`Virtualizer.mjs:91`), and **no stock layout
  implements it** — `ListLayout` included; it is absent from the public `.d.ts`.
  Full virtualization would mean subclassing a private, explicitly unstable API
  for the surface the user stares at all day.

M1-FE-04 stays **3.0d**; confidence Low → **High**. The hybrid is less work than
the alternative, and the in-flight message renders through the same part-renderer
registry, so there is no second rendering path to maintain.

### 3.3 MCP docs are v3.0.5, we pin 3.2.4
The free MCP server reports `v3.0.5 (beta)`. Installed 3.2.4 has components the
server doesn't list (`menu`, `empty-state`, `switch-group`, `header`, `tag`).
The MCP index is a **floor, not an exact match** — verify against `node_modules`
for anything the server doesn't mention. It is still the right tool per M1-FE-02;
just not authoritative on the tail.

### 3.4 Electron version — RULED, 44.x ✅
PRD §2.3 and the original M1-FE-01 line both said **Electron 32**;
`apps/desktop/package.json` pins **44.1.1**. **D-007 rules for 44.x**: Electron 32
reached EOL 2025-03-04 (Chromium M128), four majors outside the supported window.
Since this app renders remote content and proxies a VNC framebuffer, an EOL
browser engine is a live security defect, not a currency preference. Paul's pin
stands; `safeStorage` (CC-07) is stable in both. **Do not "fix" this back to 32 —
DECISIONS.md is the authority.**

### 3.5 Non-blocking notes
- `Avatar.Fallback` exists — good, since `Bot` has `avatarColor` and no image field.
- `ListBoxLoadMoreItem` is exported; useful for paging older messages
  (`GET /bots/:id/messages?before=&limit=`).
- v3 is **beta** and compound-component based. Pin exactly, no carets (README).

---

## 4. Estimate view

| Task | Est. | Confidence |
|---|---|---|
| M1-FE-01 shell (Electron **44.x**, D-007) | 1.5 | High |
| M1-FE-02 HeroUI + Tailwind + MCP | 1.5 | High — MCP already wired and probed |
| M1-FE-03 sidebar | 3.5 | High — pure composition |
| M1-FE-04 transcript | 3.0 | **High — spike 001 resolved it** |
| M1-FE-05 part registry | 2.0 | High |
| M1-FE-06 WS client | 1.5 | High |
| M1-FE-07 composer | 2.5 | Medium — auto-grow + IME |
| M1-FE-08 attachments | 1.5 | High — RAC DropZone/FileTrigger |
| M1-FE-09 tokens | 1.5 | High |
| M1-FE-10 model picker | 1.5 | High |
| M1-FE-11 streaming markdown (D-008) | 2.0 | Medium — parser choice is the risk |
| M1-FE-12 app shell + shortcuts | 2.0 | High |
| CC-07 safeStorage | 1.0 | High |
| **Total** | **24.0** | — |

Both originally-unbudgeted items (§3.1, §3.4) are now explicit tasks. M1 frontend
is 24d; John is the critical path at 15.7 weeks, so this absorbs without moving
the ship date.

---

## 5. Notes for reviewers (Brian)

Two things that look wrong against the published docs but are correct:

1. **`DropZone` / `FileTrigger` import from `react-aria-components`, not
   `@heroui/react`.** HeroUI re-exports `Virtualizer`, `ListLayout`, and
   `TableLayout` from RAC (`dist/components/rac`) but *not* these two. A HeroUI
   import path for them does not exist. There is a comment at the import site.

2. **Variable-height virtualization uses `estimatedRowSize`, not `rowHeight`.**
   HeroUI's published example only shows fixed `layoutOptions={{rowHeight: 50}}`.
   The variable-height API (`estimatedRowSize` + `updateItemSize`) is real and is
   what M1-FE-04 uses for settled history — verified in `react-stately@3.50.0`,
   `private/layout/ListLayout.mjs`.
