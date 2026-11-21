# CC-79 — Port the Paper B+ app redesign

Requested by the product owner on 2026-10-08. This is a desktop interface redesign,
using the approved Paper mockups and the existing HeroUI v3 design system. Preserve
the shipped product behavior and current conversation/control contracts.

## Design source and precedence

- Paper file: [Crewaid](https://app.paper.design/file/01M4BH3KBEJY30M7JQ0M6H63HF/p-1-0).
- File ID: `01M4BH3KBEJY30M7JQ0M6H63HF`; page: `p-1-0`.
- Main reference: **B+ — Quill's room · Final** (`436-0`). Includes the added
  **+ Create routine** entry beside Manage.
- Approval reference: **B+ — Final · Approval menu expanded** (`4BW-0`).
- Use the original B views for the remaining app surfaces: Tasks (`136-0`), Goals
  (`17Z-0`), Deliverables (`1AW-0`), rail collapsed (`2CD-0`), bot settings (`2IP-0`),
  app settings General (`2QY-0`) and Models (`2ZV-0`), new routine (`3BT-0`), new bot
  (`3V6-0`), files in chat (`3MX-0`), no bots (`1X6-0`) and new-bot empty chat
  (`23A-0`). Night (`1GC-0`) supplies the reference for any supported dark theme.
- B+ supersedes original B for the chat, composer, glass material and right rail.
  Apply that common treatment to the other B screens. A and C are explorations,
  not implementation targets.

## Required Paper MCP workflow

The implementing LLM **must use Paper MCP** to inspect and port the design. Read
the Paper guide, then `get_basic_info`, `get_tokens`, the relevant node trees and
screenshots. Use `get_jsx`, `get_computed_styles` and `get_fill_image` to obtain exact
layout, typography, colors, opacity, blur, borders and assets. Do not estimate CSS
from screenshots or substitute a generic redesign. Fetch the current file; the
node references above identify the approved views, not a frozen token export.

Keep the Paper token names. General roles already use HeroUI-compatible names
such as background, surface, foreground, muted, border, field-background, accent,
accent-foreground, warning and danger. Map Paper's Tailwind `--color-*` variables
onto HeroUI's runtime semantic variables (for example `--color-accent` to
`--accent`) through the existing theme bridge. Update
`apps/desktop/src/renderer/styles/themes/crewaid.css` and the renderer's existing
Tailwind/HeroUI setup; extend it for Paper's room, glass, bot, message, radius,
spacing and typography tokens. Reuse free HeroUI primitives and existing product
components. Do not introduce a second UI library or a parallel theme system.

Inspect component styles as well as global tokens: B+ has specific treatments
that can override a generic token value. Its visible user bubble is solid bot
color, its bot bubbles are white, and its transcript has no enclosing panel.
Resolve these into semantic component roles rather than copying stale defaults.

## Agreed appearance and interaction

- Preserve the wallpaper-led room, floating transcript, white bot bubbles and
  white composer with fine borders. Bot bubbles and composer have no drop shadow.
- Sidebar and right rail use one homogeneous glass material: the final Paper
  reference uses 72% white with 24px backdrop blur. Do not increase opacity to
  flatten the wallpaper or give each panel a different treatment.
- Use the selected bot's stored color throughout the corresponding accents:
  user bubbles, working pill, contextual card tints, progress, links, approval
  control, send and routine creation. Quill's purple is the example, not a global
  constant. Keep geometry/materials consistent across bots; preserve semantic
  success, warning, error and needs-you colors and readable contrast.
- Keep resolved sign-in cards visibly tinted and pending action/review cards
  dark. Actions and labels must reflect actual state, not mockup-only content.
- Put the approval control beside the composer plus icon. Its closed state is
  icon-only; the dropdown shows the three existing approval modes and their text.
- Separate current activity, tasks and routines in the right rail. Include
  **Manage** and the visible **+ Create routine** action, opening the existing
  manual routine editor for the selected bot. Preserve edit, enable, run-now and
  last-status behavior. Do not require creating routines through chat.
- The crew sidebar has fixed width and grows in height with its visible bot
  rows, capped by the available window height. Then scroll the roster, retaining
  the Your crew heading and add button. Collapsible groups reduce its height.
- **Take over** beside the live preview opens the full-screen viewer and requests
  the existing control lease. Show waiting/cancel, granted/Hand back and
  other-controller states. Keep the thumbnail view-only. A sleeping computer
  first offers Open computer. Preserve drain, renewal, release and fresh
  observation after handback; taking over alone does not teach a skill.
- Show learning feedback only from the existing recording/compilation/review
  flow. Preserve attachments, search, message menus, topic reset, unread markers,
  streaming, cancellation, approvals, keyboard focus and Electron drag regions.

## Required interaction animation and polish

The implementing LLM **must read the official
[HeroUI v3 Animation documentation](https://heroui.com/en/docs/react/getting-started/animation)**
and the relevant component documentation before implementing motion. Check the
installed v3 component styles/API as well. Premium quality includes how the app
responds to interaction, not only how a static screenshot looks; motion is a
required part of CC-79, not an optional finishing task.

Start with HeroUI's built-in CSS transitions and state attributes for hover,
press, focus, entering/exiting and expansion. Extend these consistently for the
custom transcript and shell. Prefer transform and opacity for smooth transitions;
an extra animation library should only be introduced for an identified need that
the existing CSS/component mechanisms cannot meet. Define shared motion timing
and easing roles alongside the existing design tokens, then tune them in the
running app. Aim for short, deliberate transitions with immediate feedback,
gentle deceleration and restrained travel/scale; avoid exaggerated bounce or
decorative motion that competes with reading.

Required interaction coverage:

- **Send message:** provide subtle press feedback and a coherent transition from
  composer submission to the new user bubble. Preserve the existing send,
  pending, error and retry semantics; animation must not delay or duplicate a send.
- **Message appearance:** newly arriving user/bot bubbles enter smoothly with a
  small transform and fade. Animate the initial appearance once per message,
  not every streaming token, rerender, history hydration or bot switch. Preserve
  scroll anchoring and the operator's position when reading older messages.
- **Search:** opening from the Search control or its keyboard shortcut uses a
  carefully crafted transform/opacity entrance and corresponding exit, including
  the backdrop where appropriate. Preserve accessible focus entry/return,
  Escape dismissal and immediate typing; handle rapid open/close cleanly.
- **Other controls:** coordinate hover/press feedback, approval/menu popovers,
  routine editor open/close, group expansion, rail collapse/expansion, bot
  selection and activity/control-state transitions with the same motion language.
  Retain visible keyboard focus and working interactions throughout transitions.
- **Accessibility and performance:** custom motion must honor both system
  `prefers-reduced-motion` and HeroUI's `data-reduce-motion` mechanism. Reduced
  motion retains clear state feedback. Avoid animating large backdrop blurs or
  causing repeated layout work during streaming; clean up interrupted animation
  state and apply rendering hints only while needed.

## Acceptance and evidence

1. The working app matches the approved B+ and supporting B screens, using
   extracted Paper values/assets and the shared HeroUI token vocabulary. Record
   the Paper views inspected and the semantic token mapping in the implementation
   handoff. Reuse the existing mascot assets rather than recreating them.
2. Capture and compare real Electron screenshots at the 1440×900 reference size
   and a smaller supported window: main chat, expanded approval menu, collapsed
   rail, manual routine editor, Work views, settings and empty states. Verify no
   clipping, unreadable text or hidden creation controls.
3. Verify at least Quill, Scout and Ava, plus a light bot color, to prove the
   selected-bot palette updates without color/state leaking between bots. Test
   enough bots to force sidebar scrolling and group collapse.
4. Exercise the real routine creation and takeover/handback flows, including
   waiting, sleeping, disconnection and another controller. Preserve existing
   chat, Work, recording, approval and settings behavior; do not invent endpoints
   or fake counters to match placeholder content.
5. Capture short recordings of send/bubble entry, Search opening/closing and
   representative menu/editor/rail interactions in real Electron. Review timing,
   easing, continuity and responsiveness at both reference and smaller sizes.
   Verify rapid repeated interactions, keyboard-only use, active streaming and
   reduced motion: no flicker, stale overlays, repeated bubble entrances, focus
   loss, scroll jumps or duplicate submissions. Record the HeroUI animation
   guidance used and the shared motion choices in the implementation handoff.
6. Run appropriate renderer/control regression tests, relevant Electron e2e,
   lint, typecheck, build and the repository pre-review gate. Document any
   unavailable live environment rather than claiming screenshot-only validation.

Work in an isolated feature worktree. This task implements the design; changes
to backend contracts need their own ratified decision before implementation.
