// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Architectural lint rules for Crewaid.
 *
 * These encode PRD hard rules and DECISIONS.md as machine-checked constraints.
 * They are deliberately added in M0, while the codebase is empty, because
 * retrofitting them later means fixing violations instead of preventing them.
 *
 *   R2      (PRD §2.2, D-200) — only the sandbox supervisor's engine may import dockerode.
 *   R10     (PRD §2.2)  — MCP clients run in the orchestrator, never a sandbox.
 *   M2-BE-02 (DECISIONS) — harness types are imported through ONE re-export.
 *   §7.3    (CC-06)     — no eval / vm.runInNewContext / dynamic import of
 *                         skill source anywhere in apps/orchestrator.
 *
 * ⚠️ IMPLEMENTATION NOTE — WHY THE BANS ARE COMPOSED, NOT LAYERED.
 * ESLint does not merge options for the same rule across flat-config blocks:
 * the LAST matching block wins outright. An earlier draft of this file declared
 * the dockerode ban globally and then re-declared `no-restricted-imports` in
 * the orchestrator block; the orchestrator block silently replaced the global
 * one, and a probe file importing `@ai-sdk/harness` from apps/orchestrator
 * linted clean. Every block that restricts imports therefore composes the
 * shared bans below via `restrictedImports()` rather than redeclaring a subset.
 * If you add a block that sets `no-restricted-imports`, compose it the same way.
 */

/**
 * R2 as D-200 amends it: the single file in the entire monorepo permitted to
 * import dockerode is the sandbox supervisor's engine. The supervisor is the
 * one process that holds the Docker socket.
 */
const DOCKERODE_ALLOWLIST = ['packages/sandbox-supervisor/src/docker-engine.ts'];

/** M2-BE-02: the single file permitted to name `@ai-sdk/harness`. */
const HARNESS_ALLOWLIST = ['packages/sandbox-core/src/types.ts'];

/** D-241: the single package permitted to import `@agentclientprotocol/sdk`. */
const ACP_ALLOWLIST = ['packages/acp-core/src/**/*.ts', 'packages/acp-core/test/**/*.ts'];

/**
 * V1-10: who may ask a LIVE CONNECTION who it belongs to.
 *
 * Only the §4.2 gateway and its adapter, because only they have a socket in
 * hand. Everything else that needs an owner reads one that was PERSISTED —
 * `recording.bot.userId` for a compile, `bot.userId` per bot for the memory
 * sweep — so a job survives the session that started it, and cannot silently
 * run as whoever happens to be connected instead.
 */
const WS_PRINCIPALS_ALLOWLIST = [
  'apps/orchestrator/src/ws/ws.gateway.ts',
  'apps/orchestrator/src/app.module.ts',
];

const WS_PRINCIPALS_BAN = {
  group: ['**/ws/ws-principals.js', '**/ws/ws-principals'],
  message:
    'V1-10: a background job must not ask a live connection who it belongs to. WsPrincipals ' +
    'answers for an OPEN SOCKET, so a job reading it runs as whoever is connected — which on a ' +
    'shared install is silently the wrong person, and which kills already-authorized work the ' +
    'moment that socket closes. Read the owner PERSISTED with the work instead ' +
    '(recording.bot.userId, bot.userId). Only ws.gateway.ts and the module providing it may ' +
    'import this.',
};

/**
 * V1-11: the ONE file allowed to hand a channel to `ipcMain` directly.
 *
 * CC-07's fence is "an invocation is answered only when it came from the main
 * frame of a window this app created", and it is enforced by `guardedIpc` in
 * `tokenStore.ts`. A second `ipcMain.handle` anywhere else does not conflict
 * with that rule — it simply does not have it, and an unfenced channel next to
 * a fenced one is the one that ends up mattering.
 *
 * The temptation is concrete rather than hypothetical: `@better-auth/electron`
 * ships a preload helper that registers seven bridges over handlers taking
 * `(_evt, …)`, and adopting it wholesale is a two-line change.
 */
const DESKTOP_PATH_BANS = [
  {
    name: 'ai',
    message:
      'PRD R1: Electron contains zero orchestration logic — no agent loop, no model calls. ' +
      'It speaks HTTP and WebSocket only, even in local dev.',
  },
  {
    name: '@better-auth/electron/preload',
    message:
      'V1-11: `setupRenderer()` exposes seven bare globals (window.requestAuth, ' +
      'window.signOut, …) over handlers that never check the sender. The renderer gets ' +
      'one namespace, `window.crewaid`, and every channel behind CC-07‘s fence. See ' +
      'src/preload.ts and registerAuthIpc.',
  },
];

const IPC_FENCE_ALLOWLIST = ['apps/desktop/src/tokenStore.ts'];

const IPC_HANDLE_BAN = {
  // Both shapes, because both are written: `ipcMain.handle(…)` after importing
  // it from electron, and `options.ipcMain.handle(…)` after passing it through
  // a port — which is how `guardedIpc` itself reaches it, and therefore the
  // one the allowlist below has to excuse.
  selector:
    "MemberExpression[object.name='ipcMain'][property.name='handle']," +
    "MemberExpression[object.property.name='ipcMain'][property.name='handle']",
  message:
    'CC-07/V1-11: register IPC through `guardedIpc` in tokenStore.ts, never with ipcMain.handle ' +
    'directly. A channel added beside the fence does not inherit the trusted-sender check, and ' +
    'an unfenced door next to a fenced one is the one that matters. See registerTokenIpc and ' +
    'registerAuthIpc for the shape.',
};

/**
 * Bans that apply to every file in the Electron client.
 *
 * Composed the same way `restrictedImports()` is, and for the same reason:
 * flat-config replaces a rule's whole option list when a later matching block
 * names it, so a block that declared only the ipcMain ban would silently drop
 * the `as never` and `download` bans for the files it matched.
 *
 * @param {{omit?: string[]}} [options] selectors to leave out, for an allowlist block
 */
/**
 * D-234: every word a person reads in the renderer comes from the catalog
 * (`t()` / `useT()`, `renderer/i18n/messages/en`), so a language switch
 * reaches all of it. Literal copy in JSX is what slips past a translation
 * pass unnoticed: text between tags, the props a person reads or hears, and a
 * string or template handed straight to a child. Words in a plain `.ts`
 * helper are not caught here; the catalog's own tests and review cover those.
 */
const COPY_MESSAGE =
  "D-234: user-facing words come from the catalog — t('…') with the key in renderer/i18n/messages/en.";
const COPY_BANS = [
  { selector: 'JSXText[value=/[A-Za-z]/]', message: COPY_MESSAGE },
  {
    selector:
      'JSXAttribute[name.name=/^(label|description|aria-label|aria-description|placeholder|title|alt|summary|textValue)$/] > Literal[value=/[A-Za-z]/]',
    message: COPY_MESSAGE,
  },
  {
    selector: 'JSXElement > JSXExpressionContainer > Literal[value=/[A-Za-z]/]',
    message: COPY_MESSAGE,
  },
  {
    selector:
      'JSXElement > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]/]',
    message: COPY_MESSAGE,
  },
  {
    selector:
      'JSXElement > JSXExpressionContainer > ConditionalExpression > Literal[value=/[A-Za-z]/]',
    message: COPY_MESSAGE,
  },
];

function desktopRestrictedSyntax(options = {}) {
  const omit = options.omit ?? [];
  const bans = [
    {
      selector: 'TSAsExpression > TSNeverKeyword',
      message:
        'Do not cast with `as never`. Convert through the shared schema at the boundary, or fix the type.',
    },
    {
      selector: "JSXAttribute[name.name='download']",
      message:
        'D-025: renderer JSX must not hand authenticated downloads to an anchor. Fetch bytes through ApiClient, then save the Blob.',
    },
    IPC_HANDLE_BAN,
    ...COPY_BANS,
  ];
  return ['error', ...bans.filter((ban) => !omit.includes(ban.selector))];
}

/** §7.3 (CC-06): the orchestrator process is not an isolation boundary. */
const ORCHESTRATOR_PATH_BANS = [
  {
    name: 'node:vm',
    message:
      'PRD §7.3 (CC-06): node:vm is not an isolation boundary. Skill scripts run inside the ' +
      'sandbox container, never in the orchestrator process.',
  },
  {
    name: 'vm',
    message: 'PRD §7.3 (CC-06): node:vm is banned in apps/orchestrator.',
  },
  {
    name: '@crewaid/sandbox-supervisor',
    message:
      'D-200: the orchestrator reaches Docker only through the supervisor over HTTP ' +
      '(SupervisorEngine in @crewaid/sandbox-docker). Importing the supervisor would put the ' +
      'daemon client back in this process.',
  },
];

const DOCKERODE_BAN = {
  name: 'dockerode',
  message:
    'PRD R2 (D-200): only packages/sandbox-supervisor/src/docker-engine.ts may import dockerode. ' +
    'Route sandbox access through HarnessV1SandboxProvider instead.',
};

const HARNESS_BAN = {
  name: '@ai-sdk/harness',
  message:
    'M2-BE-02 (DECISIONS.md): import harness types from @crewaid/sandbox-core (src/types.ts), never ' +
    'from @ai-sdk/harness directly. These types carry Experimental_ markers and churn — the ' +
    're-export is what keeps an upstream rename a one-file fix instead of a repo-wide sweep.',
};

const ACP_SDK_BAN = {
  name: '@agentclientprotocol/sdk',
  message:
    'D-241: @agentclientprotocol/sdk enters the workspace only through packages/acp-core ' +
    'so local and sandbox ACP runners share one pinned protocol boundary.',
};

const ACP_SDK_PATTERN_BAN = {
  group: ['@agentclientprotocol/*'],
  message: 'D-241: import ACP types and runners from @crewaid/acp-core instead.',
};

const BASE_PATH_BANS = [DOCKERODE_BAN, HARNESS_BAN];

const BASE_PATTERN_BANS = [
  {
    group: ['dockerode/*'],
    message: "PRD R2 (D-200): only the sandbox supervisor's engine may import dockerode.",
  },
  {
    group: ['@ai-sdk/harness/*'],
    message: 'M2-BE-02: import harness types from @crewaid/sandbox-core instead.',
  },
];

/**
 * D-159 §3.12 / D-160: where the TanStack AI stack may enter the orchestrator.
 *
 * The same churn firewall M2-BE-02 built for the harness, one level wider:
 * the library is pre-1.0 and ships a minor a week, so it is imported from a
 * bounded set of seam directories and nowhere else. A service that needs a
 * model, a tool or a run goes through the types those seams export. A task
 * that needs another seam adds it here in the same change as its decision.
 */
const TANSTACK_SEAM_ALLOWLIST = [
  'apps/orchestrator/src/agent/execution/**',
  'apps/orchestrator/src/agent/persistence/**',
  'apps/orchestrator/src/models/**',
  'apps/orchestrator/src/mcp/**',
  'apps/orchestrator/src/ee/billing/**',
  'apps/orchestrator/src/telemetry/**',
  // Tests exercise the libraries directly (the MOD-02 compatibility suite and
  // its successors); the firewall is about production imports.
  'apps/orchestrator/test/**',
];

const TANSTACK_SEAM_BAN = {
  group: ['@tanstack/ai', '@tanstack/ai/*', '@tanstack/ai-*', '@tanstack/ai-*/*', '@ag-ui/*'],
  message:
    'D-159 §3.12 / D-160: TanStack AI and AG-UI enter the orchestrator only through the seam ' +
    'directories in TANSTACK_SEAM_ALLOWLIST (agent/execution, agent/persistence, models, mcp, ' +
    'billing, telemetry). Import the seam’s own types instead, or add a seam with a decision.',
};

/**
 * D-159 §3.12 / D-160: what the renderer may take from the TanStack stack.
 *
 * `@tanstack/ai-react` and `@tanstack/ai-client` are the client. From the core
 * the renderer needs types and `defineInterrupt` (it registers the same
 * `crewaid.tool-approval` definition the server emits) and nothing else:
 * `chat()`, the adapters, persistence, locks and BYOK are the orchestrator’s
 * (R1), and an adapter in a renderer is a provider credential in a renderer.
 */
function rendererTanstackBans() {
  return [
    {
      group: [
        '@tanstack/ai',
        '@tanstack/ai/*',
        '@tanstack/ai-*',
        '@tanstack/ai-*/*',
        '@copilotkit/*',
        '@ag-ui/encoder',
        '@ag-ui/proto',
      ],
      message:
        'PRD R1 / D-205: the renderer uses standalone @ag-ui/core and @ag-ui/client; AI orchestration stays on the server.',
    },
  ];
}

/**
 * Build a `no-restricted-imports` option that ALWAYS carries the repo-wide
 * architectural bans, plus any scope-specific additions.
 *
 * @param {{acpSeam?: boolean, composioSeam?: boolean, elevenlabsSeam?: boolean, eeSeam?: boolean, paths?: Array<{name: string, message: string}>, patterns?: Array<{group: string[], message: string}>}} [extra]
 */
function restrictedImports(extra = {}) {
  return [
    'error',
    {
      paths: [...BASE_PATH_BANS, ...(extra.acpSeam ? [] : [ACP_SDK_BAN]), ...(extra.paths ?? [])],
      patterns: [
        ...BASE_PATTERN_BANS,
        ...(extra.acpSeam ? [] : [ACP_SDK_PATTERN_BAN]),
        ...(extra.composioSeam
          ? []
          : [
              {
                group: ['@composio/*', '@composio/*/**'],
                message: 'D-202: Composio SDK imports stay in the server integration seam.',
              },
            ]),
        // D-222: the call's voice is one renderer file. The orchestrator reaches
        // ElevenLabs over its REST API from models/voice, never through an SDK.
        ...(extra.elevenlabsSeam
          ? []
          : [
              {
                group: ['@elevenlabs/*', '@elevenlabs/*/**'],
                message:
                  'D-222: @elevenlabs/* is imported only by apps/desktop/src/renderer/voice/callSession.ts.',
              },
            ]),
        // D-238: code under an `ee/` directory is licensed separately from the
        // AGPL core, and the core must build, test and run with every `ee/`
        // directory deleted. So the core may never import one; only `ee/` code
        // (eeSeam) may import other `ee/` code.
        ...(extra.eeSeam
          ? []
          : [
              {
                group: ['**/ee', '**/ee/**'],
                message:
                  'D-238: the AGPL core may not import from an ee/ directory. Expose a port in the ' +
                  'core and bind it from ee/ instead.',
              },
            ]),
        // Every orchestrator allowlist composes these paths, so subpath and
        // relative imports cannot reopen the daemon boundary inside a seam.
        ...(extra.paths?.some((ban) => ban.name === '@crewaid/sandbox-supervisor')
          ? [
              {
                group: ['@crewaid/sandbox-supervisor/*', '**/sandbox-supervisor/**'],
                message:
                  'D-200: import the supervisor client from sandbox-docker; the daemon service stays out of the orchestrator.',
              },
            ]
          : []),
        ...(extra.patterns ?? []),
      ],
    },
  ];
}

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/.next/**',
      '**/coverage/**',
      '**/generated/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // tools/guard-probes/*.ts are deliberately outside every tsconfig
          // (they are lint fixtures, not shipped code). allowDefaultProject is
          // typescript-eslint's remedy for exactly this; without it the files
          // hit "not found by the project service" PARSER ERRORS, eslint exits
          // fatal, and any exit-code-based guard reads that as "rule fired" —
          // which is the exact D-013 failure mode this directory exists to
          // prevent. run-probes.mjs additionally asserts on ruleId, so neither
          // a parser error nor a silent rule can masquerade as a passing probe.
          allowDefaultProject: ['tools/guard-probes/*.ts', 'tools/guard-probes/*.tsx'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ── Baseline: no `any` in committed code (M0-01 acceptance criterion) ──────
  {
    name: 'crewaid/no-any',
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // `as never` is the loophole that survives every rule below it: it
      // silences the compiler exactly where a type genuinely does not match,
      // which is precisely where the mismatch matters. It hid a real
      // Prisma.JsonValue-vs-Json boundary error in the WS emit path. Convert
      // at the boundary instead (see apps/orchestrator/src/common/contract.ts).
      // Tests relax this below — a fixture asserting a rejection needs it.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSAsExpression > TSNeverKeyword',
          message:
            'Do not cast with `as never` — it defeats no-explicit-any and the no-unsafe-* family. ' +
            'Convert through the shared schema at the boundary, or fix the type.',
        },
      ],
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // ── R2 + M2-BE-02: architectural import bans, applied everywhere ──────────
  {
    name: 'crewaid/architectural-import-bans',
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    rules: {
      'no-restricted-imports': restrictedImports(),
    },
  },

  // ── R2 escape hatch: the one file that IS the Docker implementation ───────
  {
    name: 'crewaid/r2-dockerode-allowlist',
    files: DOCKERODE_ALLOWLIST,
    rules: {
      // Still bans @ai-sdk/harness and @agentclientprotocol/*: only dockerode is lifted.
      'no-restricted-imports': [
        'error',
        {
          paths: [HARNESS_BAN, ACP_SDK_BAN],
          patterns: [BASE_PATTERN_BANS[1], ACP_SDK_PATTERN_BAN],
        },
      ],
    },
  },

  // ── M2-BE-02 escape hatch: the churn firewall itself ──────────────────────
  {
    name: 'crewaid/m2be02-harness-allowlist',
    files: HARNESS_ALLOWLIST,
    rules: {
      // Still bans dockerode and @agentclientprotocol/*: re-exporting types needs neither.
      'no-restricted-imports': [
        'error',
        {
          paths: [DOCKERODE_BAN, ACP_SDK_BAN],
          patterns: [BASE_PATTERN_BANS[0], ACP_SDK_PATTERN_BAN],
        },
      ],
    },
  },

  // ── D-241 escape hatch: the shared ACP protocol package ───────────────────
  {
    name: 'crewaid/d241-acp-allowlist',
    files: ACP_ALLOWLIST,
    rules: {
      'no-restricted-imports': restrictedImports({ acpSeam: true }),
    },
  },

  // ── §7.3 / CC-06: no dynamic code execution in the orchestrator ───────────
  {
    name: 'crewaid/cc06-no-dynamic-code-execution',
    // D-013: the cc06-*.probe.ts files exist to prove these rules fire; they are
    // linted under the SAME block so the rules stay defined exactly once.
    files: [
      'apps/orchestrator/**/*.ts',
      'tools/guard-probes/cc06-*.probe.ts',
      // D-013: the V1-10 probe lints under this same block, so it is judged by
      // the one definition of the rule rather than a copy that could drift.
      'tools/guard-probes/v1-10-*.probe.ts',
      // D-013: the D-160 seam probe, for the same reason.
      'tools/guard-probes/d160-*.probe.ts',
      // D-013: the D-200 probe, for the same reason.
      'tools/guard-probes/d200-*.probe.ts',
      // D-013: the D-222 orchestrator probe, for the same reason.
      'tools/guard-probes/d222-*.probe.ts',
      // D-013: the D-238 ee/ boundary probe, for the same reason.
      'tools/guard-probes/ee-*.probe.ts',
    ],
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'vm',
          property: 'runInNewContext',
          message:
            'PRD §7.3: skill scripts are model-generated and untrusted. They execute inside the ' +
            'sandbox via the bridge, never in the orchestrator process.',
        },
        {
          object: 'vm',
          property: 'runInThisContext',
          message: 'PRD §7.3: no dynamic code execution in apps/orchestrator.',
        },
        {
          object: 'vm',
          property: 'runInContext',
          message: 'PRD §7.3: no dynamic code execution in apps/orchestrator.',
        },
        {
          object: 'vm',
          property: 'compileFunction',
          message: 'PRD §7.3: no dynamic code execution in apps/orchestrator.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        // Composed, not layered — the same flat-config merge trap documented at
        // the top of this file. Dropping this entry would re-open `as never`
        // for the whole orchestrator.
        {
          selector: 'TSAsExpression > TSNeverKeyword',
          message:
            'Do not cast with `as never`. Convert through the shared schema at the boundary ' +
            '(apps/orchestrator/src/common/contract.ts), or fix the type.',
        },
        {
          selector: 'ImportExpression',
          message:
            'PRD §7.3 (CC-06): dynamic import() is banned in apps/orchestrator — it is an ' +
            'execution path for untrusted, model-generated skill source. Use a static import.',
        },
        {
          selector: "NewExpression[callee.name='Function']",
          message: 'PRD §7.3 (CC-06): the Function constructor is an eval path. Banned.',
        },
        {
          selector: "CallExpression[callee.name='require'][arguments.0.type!='Literal']",
          message:
            'PRD §7.3 (CC-06): non-literal require() is a dynamic code path. Use a static import.',
        },
      ],
      'no-restricted-imports': restrictedImports({
        paths: ORCHESTRATOR_PATH_BANS,
        patterns: [WS_PRINCIPALS_BAN, TANSTACK_SEAM_BAN],
      }),
    },
  },

  /**
   * D-160: the seam directories TanStack AI may enter through.
   *
   * Composed from `restrictedImports()` like every other allowlist: only the
   * TanStack pattern is lifted, so CC-06's `node:vm` ban and V1-10's
   * ws-principals ban still apply inside the seams.
   */
  {
    name: 'crewaid/d160-tanstack-seam-allowlist',
    files: TANSTACK_SEAM_ALLOWLIST,
    rules: {
      'no-restricted-imports': restrictedImports({
        paths: ORCHESTRATOR_PATH_BANS,
        patterns: [WS_PRINCIPALS_BAN],
      }),
    },
  },

  // D-176: the canonical port carries no SDK-specific model, message, event or persistence type.
  {
    name: 'crewaid/d201-composio-seam',
    files: [
      'apps/orchestrator/src/integrations/composio/**',
      'apps/orchestrator/test/composio*.ts',
    ],
    rules: {
      'no-restricted-imports': restrictedImports({
        composioSeam: true,
        paths: ORCHESTRATOR_PATH_BANS,
        patterns: [WS_PRINCIPALS_BAN, TANSTACK_SEAM_BAN],
      }),
    },
  },
  {
    name: 'crewaid/d176-neutral-execution-port',
    files: [
      'apps/orchestrator/src/agent/execution/execution-backend.port.ts',
      'tools/guard-probes/d176-execution-port.probe.ts',
    ],
    rules: {
      'no-restricted-imports': restrictedImports({
        paths: [
          ...ORCHESTRATOR_PATH_BANS,
          { name: 'ai', message: 'D-176: no SDK types across the canonical execution port.' },
        ],
        patterns: [
          WS_PRINCIPALS_BAN,
          {
            group: ['@tanstack/*', '@ag-ui/*', '@ai-sdk/*', '@prisma/client'],
            message: 'D-176: the canonical port is SDK and persistence independent.',
          },
        ],
      }),
    },
  },

  /**
   * V1-10: the two files that legitimately hold a live socket's principal.
   *
   * Scoped narrowly and composed from `restrictedImports()` on purpose: a
   * flat-config block that sets `no-restricted-imports` REPLACES the rule for
   * the files it matches rather than merging, so declaring only "the
   * ws-principals ban does not apply here" would have quietly turned off
   * CC-06's `node:vm` ban for the gateway too. Everything but that one pattern
   * still applies.
   */
  {
    name: 'crewaid/v1-10-ws-principals-allowlist',
    files: WS_PRINCIPALS_ALLOWLIST,
    rules: {
      'no-restricted-imports': restrictedImports({
        paths: ORCHESTRATOR_PATH_BANS,
        patterns: [TANSTACK_SEAM_BAN],
      }),
    },
  },

  /**
   * D-238: the Enterprise code may import the core and other `ee/` code.
   *
   * Composed from `restrictedImports()` like every other allowlist, so CC-06's
   * `node:vm` ban and V1-10's ws-principals ban still apply inside `ee/`. Only
   * the ee pattern is lifted here; billing keeps its D-160 TanStack seam in the
   * next block.
   */
  {
    name: 'crewaid/d238-ee-may-import-ee',
    files: ['apps/orchestrator/src/ee/**/*.ts'],
    rules: {
      'no-restricted-imports': restrictedImports({
        eeSeam: true,
        paths: ORCHESTRATOR_PATH_BANS,
        patterns: [WS_PRINCIPALS_BAN, TANSTACK_SEAM_BAN],
      }),
    },
  },
  {
    name: 'crewaid/d238-ee-tanstack-seam',
    files: ['apps/orchestrator/src/ee/billing/**/*.ts', 'apps/orchestrator/test/ee/**/*.ts'],
    rules: {
      'no-restricted-imports': restrictedImports({
        eeSeam: true,
        paths: ORCHESTRATOR_PATH_BANS,
        patterns: [WS_PRINCIPALS_BAN],
      }),
    },
  },

  // ── R10: MCP credentials and clients never enter sandbox-facing packages ──
  {
    name: 'crewaid/r10-mcp-orchestrator-only',
    // D-013: r10-*.probe.ts linted under the same block (single rule definition).
    files: [
      'packages/sandbox-cloudflare/**/*.ts',
      'packages/sandbox-core/**/*.ts',
      'packages/sandbox-digitalocean/**/*.ts',
      'packages/sandbox-docker/**/*.ts',
      'packages/sandbox-instabox/**/*.ts',
      'packages/sandbox-runtime/**/*.ts',
      'packages/sandbox-supervisor/**/*.ts',
      // Run inside the computer, as the screen gateway (D-223).
      'packages/screen-gateway/**/*.ts',
      'packages/screen-stream/**/*.ts',
      'packages/skill-runtime/**/*.ts',
      'tools/guard-probes/r10-*.probe.ts',
    ],
    ignores: [...HARNESS_ALLOWLIST, ...DOCKERODE_ALLOWLIST],
    rules: {
      'no-restricted-imports': restrictedImports({
        patterns: [
          {
            group: [
              '@modelcontextprotocol/*',
              '**/mcp/**',
              '@tanstack/ai-mcp',
              '@tanstack/ai-mcp/*',
            ],
            message:
              'PRD R10: MCP clients run in the orchestrator only. Plugin credentials must never ' +
              'enter a bot container or any sandbox-facing package.',
          },
        ],
      }),
    },
  },

  // ── packages/shared: zero runtime deps but zod (M0-04) ────────────────────
  {
    name: 'crewaid/shared-zero-deps',
    // D-013: shared-*.probe.ts linted under the same block (single rule definition).
    files: ['packages/shared/**/*.ts', 'tools/guard-probes/shared-*.probe.ts'],
    rules: {
      'no-restricted-imports': restrictedImports({
        patterns: [
          {
            group: [
              '@prisma/client',
              '@nestjs/*',
              'ai',
              '@ai-sdk/*',
              '@tanstack/*',
              '@ag-ui/*',
              'dockerode',
              'ioredis',
            ],
            message:
              'PRD M0 acceptance: packages/shared has zero runtime dependencies other than zod. ' +
              'Both apps import it; it must stay dependency-free. D-159: AG-UI and TanStack ' +
              'types are not re-declared here; the libraries validate their own wire.',
          },
        ],
      }),
    },
  },

  // ── R1: the Electron client contains zero orchestration logic ─────────────
  {
    name: 'crewaid/r1-electron-is-a-client',
    // D-013: r1-*.probe.ts linted under the same block (single rule definition).
    files: [
      'apps/desktop/**/*.ts',
      'apps/desktop/**/*.tsx',
      'tools/guard-probes/r1-*.probe.ts',
      'tools/guard-probes/d025-*.probe.tsx',
      'tools/guard-probes/d234-*.probe.tsx',
      'tools/guard-probes/v1-11-*.probe.ts',
    ],
    rules: {
      // Composed, never redeclared: flat-config replaces a rule's entire
      // option list when a later matching block names it.
      'no-restricted-syntax': desktopRestrictedSyntax(),
      'no-restricted-imports': restrictedImports({
        paths: DESKTOP_PATH_BANS,
        patterns: [
          {
            // `ai` is an exact path below, not a pattern: patterns are
            // gitignore-style, so a bare `ai` also matched the last segment of
            // `@tanstack/ai` and banned the client half D-159 allows.
            group: ['@prisma/client', '@nestjs/*', '@ai-sdk/*', 'bullmq', 'ioredis', 'pg'],
            message:
              'PRD R1: Electron contains zero orchestration logic — no agent loop, no model calls, ' +
              'no Docker access, no database. It speaks HTTP and WebSocket only, even in local dev.',
          },
          ...rendererTanstackBans(),
        ],
      }),
    },
  },

  // D-175: one definition-only schema seam. Provider and runtime bans still apply.
  {
    name: 'crewaid/d175-renderer-tool-schema-allowlist',
    files: [
      'apps/desktop/src/renderer/chat/tool-contracts.ts',
      'tools/guard-probes/r1-d175-schema-seam.probe.ts',
    ],
    rules: {
      'no-restricted-imports': restrictedImports({
        paths: DESKTOP_PATH_BANS,
        patterns: [
          {
            group: ['@prisma/client', '@nestjs/*', '@ai-sdk/*', 'bullmq', 'ioredis', 'pg'],
            message: 'R1: orchestration remains server-side.',
          },
          ...rendererTanstackBans(),
        ],
      }),
    },
  },

  /**
   * D-222: the one renderer file that may speak to ElevenLabs. Composed, so the
   * R1 and D-205 bans still apply to it; only the ElevenLabs ban is lifted.
   */
  {
    name: 'crewaid/d222-call-session-seam',
    files: ['apps/desktop/src/renderer/voice/callSession.ts'],
    rules: {
      'no-restricted-imports': restrictedImports({
        elevenlabsSeam: true,
        paths: DESKTOP_PATH_BANS,
        patterns: [
          {
            group: ['@prisma/client', '@nestjs/*', '@ai-sdk/*', 'bullmq', 'ioredis', 'pg'],
            message: 'R1: orchestration remains server-side.',
          },
          ...rendererTanstackBans(),
        ],
      }),
    },
  },

  /**
   * V1-11: the one file that owns the IPC fence.
   *
   * `tokenStore.ts` is where `guardedIpc` calls `ipcMain.handle`, so the ban
   * cannot apply to it. Only `no-restricted-syntax` is redeclared here, minus
   * that one selector — `no-restricted-imports` is left alone so this file
   * keeps the R1 bans from the block above rather than silently losing them,
   * which is the trap V1-10 walked into with an `ignores`.
   */
  {
    name: 'crewaid/v1-11-ipc-fence-allowlist',
    files: IPC_FENCE_ALLOWLIST,
    rules: {
      'no-restricted-syntax': desktopRestrictedSyntax({
        omit: [IPC_HANDLE_BAN.selector],
      }),
    },
  },

  // ── Tests may relax the unsafe-* family; fixtures are intentionally loose ─
  {
    name: 'crewaid/tests',
    files: ['**/*.test.ts', '**/*.spec.ts', '**/*.test.tsx', '**/test/**/*.ts', '**/test/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      // Fixtures deliberately feed hostile shapes past the compiler to prove a
      // runtime guard rejects them. That is the one legitimate `as never`.
      'no-restricted-syntax': 'off',
    },
  },

  // ── Config files: no type-aware linting ───────────────────────────────────
  {
    name: 'crewaid/config-files',
    files: [
      '**/*.config.ts',
      '**/*.config.js',
      '**/*.config.mjs',
      '**/*.config.mts',
      'eslint.config.mjs',
    ],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
);
