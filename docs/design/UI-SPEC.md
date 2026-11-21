1|# UI Design Reference
2|
3|**Source:** 4 screenshots from Natanael (2026-09-01), archived in `docs/design/ref-0*.png`.
4|**Status:** Authoritative for look-and-feel. Where this file and the PRD conflict on
5|*visual* details, this file wins. Where they conflict on *architecture*, the PRD and
6|`DECISIONS.md` win.
7|
8|These are real product screenshots of the intended Crewaid UI (ref-01/02/04/05),
9|plus one external style reference (ref-03). Nathan builds to these.
10|
11|---
12|
13|## ref-01 / ref-02 — Main app shell (three-pane)
14|
15|Two states of the same screen; ref-02 is the right rail grown wider.
16|
17|```
18|┌──────────┬──────────────────────────────┬──────────────────┐
19|│ SIDEBAR  │  TRANSCRIPT                  │  RIGHT RAIL      │
20|│ ~275px   │  fluid                       │  ~355–700px      │
21|└──────────┴──────────────────────────────┴──────────────────┘
22|```
23|
24|### Theme: LIGHT. Warm neutral, high-whitespace, soft.
25|
26|- App background: near-white warm gray (`#F7F6F4` approx)
27|- Transcript area: same; bubbles slightly distinct
28|- Text: near-black soft (`#1A1A1A` approx)
29|- **No harsh pure white, no dark mode visible** — build light-first
- **Accent is BLUE** (`#2563EB` approx, per ref-04/05's Save button)
30|- Border radius is LARGE everywhere: bubbles ~18px, cards ~14px, inputs ~12px,
31|  avatar shapes squircle-ish
32|- Shadows are minimal; separation comes from surface tone + hairline borders
33|- Typography: system SF-style sans. Chat ~15px; sidebar names ~14px semibold;
34|  metadata (timestamps, role chips) ~11–12px muted
35|
36|### Left sidebar (bots, not threads)
37|
38|- Top: macOS traffic lights + a `+` (new bot) top-right of sidebar
39|- Search input, full width, pill-ish rounded, light border
40|- **Pinned bot card** at top: large avatar (~72px), name, role chip below —
41|  the selected/primary bot is visually elevated with a bordered card
42|- **Group header** in small caps: `Sales team` (this is a bot grouping)
43|- Bot rows, each: colored avatar (see shape system), **Name** (semibold),
44|  **role chip** (tiny bordered pill, e.g. `Outbound Writer`), timestamp right-aligned,
45|  second line = last-message preview, muted, one line ellipsized:
46|  - Quill — Outbound Writer — 10:26 AM — "Sent 1 Markdown file"
47|  - Warden — Pipeline M… — 10:06 AM
48|  - Beacon — Demand-G… — 10:03 AM
49|  - Forge — Sales Engineer — 9:55 AM
50|  - Ava — Inbound Lead Co… — 9:52 AM
51|  - Scout — Prospect Resea… — 9:36 AM
52|- Bottom fixed: `Plugins` (with plug icon) and the user row (`NE` avatar + Natanael Exe)
53|
54|**Mapping to our model:** sidebar rows are BOTS (name + role chip + avatarColor + status +
55|⌘-shortcut per M1-FE-03). The "Sent 1 Markdown file" line = last message preview.
56|Group headers = bot grouping, decided in D-131: a `BotGroup`, shown only once a group has
57|a bot, with an `Unassigned` header after the groups.
58|
59|### Center transcript
60|
61|- Header: bot avatar (small) + bot name, left-aligned
62|- Date separator: `Today 2:30 PM`, small muted centered
63|- **Bubbles, not full-width rows.** Max-width ~70%. Bot messages: light gray bubble,
64|  left-aligned, LEFT side. User messages: **black bubble, white text**, right-aligned.
65|  Multiple consecutive messages from the same author stack with small gaps
66|  (see the three stacked bot messages mid-conversation)
67|- **System events render as tiny centered muted text, no bubble:**
68|  `Renamed to Chief of staff`, `Renamed to Nathan 2.0`
69|  → this is our SYSTEM author message type (D-006 vocabulary / M1 part renderers)
70|- Composer: pill input, `+` (attach) at left inside, placeholder `Message Nathan 2.0`,
71|  **black circular mic/voice button at right inside**
72|- No visible markdown rendering in these shots — but D-008 still applies
73|  (replies will be markdown; build the renderer anyway)
74|
75|### Right rail
76|
77|- Top-right: gear icon + `»` (collapse) icons
78|- **Live screen card** (THE VNC thumbnail, M2): rounded-rect screenshot of the bot's
79|  desktop with a small Chrome/terminal dock visible at bottom of the frame,
80|  captioned underneath: `Nathan 2.0's screen`
81|- Empty state below: centered muted text
82|  `Routines are recurring tasks this Bot runs on a schedule.` + a `Create Routine`
83|  pill button → M8 routines panel lives here
84|
85|**ref-02** shows the same screen with the rail widened (~2x) — the screen card scales
86|with the rail (client-side scaling only, rule R8). Collapse control (`»`) matches
87|M2-FE-02's collapse requirement.
88|
89|---
90|
91|## ref-04 / ref-05 — Edit profile modal (bot config)
92|
93|Modal over the app, light, rounded ~16px, generous padding. Close `×` top-right.
94|
95|- Title `Edit profile`, subtitle `Appearance and role for Nathan (nathan).`
96|- **Large centered avatar** (~120px) — either the bot's photo or a generated shape
97|- **Segmented control (4 tabs):** `Bot | Generate | Upload | Pet`
98|  - ref-04 (photo bot): shows `Remove image — use shape` link, then a grid of
99|    **yellow blob faces with tiny eyes** (10 shapes), `Randomize` + `Lock face`
100|    buttons, hint `Face follows the name.`, `Classic shapes` label
101|  - ref-05 (shape bot): a grid of **purple blob/shape faces** (circle selected —
102|    blue outline, blob, blob, rounded square / rectangle, triangle, hexagon, cloud /
103|    teardrop), then a **12-swatch color picker row** (red, orange, yellow, lime,
104|    green, mint / cyan, blue, indigo, purple, magenta, rose),
105|    and a `⊘ Match the name` option (auto-derive color from name hash)
106|- Fields: `Title` (text input — the bot's ROLE, e.g. `Chief of staff`,
107|  `Frontend developer`) and `Description` (textarea — the bot's system prompt,
108|  e.g. the chief-of-staff prompt; resizable)
109|- Disclosure: `› Advanced — model, skills, toolsets, SOUL.md`
110|  → maps to modelId picker (D-003), skills, toolsets; SOUL.md is Hermes-flavored,
111|  treat as advanced system-prompt editing
112|- Footer: `Cancel` (text) + `Save` (blue filled pill)
113|
114|**Mapping to our model:** Title=Bot.role, Description=Bot.systemPrompt,
115|avatar shape+color = the avatarColor system (PRD stores a hex; here it's a shape+color
116|pair — we should store both `avatarShape` and `avatarColor`; small schema addition,
117|**flag to Ben before M0-03 merges**). `Face follows the name` + `Match the name`
118|= deterministic avatar derivation from bot name (hash → shape/color).
119|
120|---
121|
122|## ref-03 — External style reference (NOT our product)
123|
124|A French SaaS dashboard (`Cabinet Fontaine`, accounting product). Included for
125|**visual style only**:
126|
127|- Warm cream background, white cards with large radius
128|- **Terracotta/orange accent** (`#D96A45` approx) — active nav item is a soft
129|  peach pill with terracotta text; primary buttons are filled terracotta
130|- Stat cards row: big number (28–32px semibold) + small muted caption
131|- Chip badges: `✓ Certifié` (green), `Public` (peach), count badges in nav
132|  (`12`, `72` — soft orange pills)
133|- Section labels in small caps (`DOSSIERS PUBLICS`, `ESPACE`, `CABINET`)
134|- Two-tier sidebar: section groups with small-caps headers
135|
136|**Take for Crewaid:** the warmth, card-based stats, chip language, and small-caps
137|section labels. **Do not copy the layout** (that's a settings dashboard, not a chat app).
138|139|**Ben to decide accent color** (blue like ref-04/05, or terracotta like ref-03).
140|
141|---
142|
143|## Token sheet (initial, for M1-FE-09)
144|
145|```css
146|--bg-app:        #F7F6F4;   /* warm near-white */
147|--bg-bubble-bot: #EFEEEC;   /* light gray bubble */
148|--bg-bubble-user:#1A1A1A;   /* black bubble, white text */
149|--text-primary:  #1A1A1A;
150|--text-muted:    #8A8A86;
151|--text-faint:    #B5B4B0;
152|--border-hair:   #E5E4E1;
153|--radius-bubble: 18px;
154|--radius-card:   14px;
155|--radius-input:  12px;
156|--radius-pill:   999px;
157|--shadow-rest:   none to 0 1px 2px rgba(0,0,0,.04);
158|--accent:        #2563EB;   /* blue — decided 2026-09-02 by retraction of the accidental style ref */
159|```
160|
161|## Open decisions (Ben)
162|
163|1. **Accent color:** blue (ref-04/05) or terracotta (ref-03)?
164|2. ~~**Bot grouping** (`Sales team` header): keep flat list or add groups?~~ Decided: groups (D-131).
165|3. **Avatar system:** PRD stores `avatarColor` hex only; screenshots show a
166|   shape+color pair with name-derived faces. Add `avatarShape` to schema?
167|4. **Voice input button** is visible in the composer — PRD §1.5 defers voice to v2.
168|   Render the button but disable it, or omit?
169|