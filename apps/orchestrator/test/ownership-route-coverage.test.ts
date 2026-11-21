import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';
import { BillingController } from '../src/billing/billing.controller.js';
import { VoiceCallsController } from '../src/billing/voice-calls.controller.js';
import {
  OWNED_RESOURCE,
  type OwnedResourceSpec,
} from '../src/ownership/owned-resource.decorator.js';

/**
 * D-010's fence, checked against the real route table.
 *
 * ResourceOwnershipGuard used to hold a predicate over URL shapes so that a
 * direct-resource path it did not recognise was refused rather than served.
 * That made a forgotten route table entry a 404 in production. The guard is
 * now driven by `@OwnedResource`, which fails open when absent, so the same
 * property has to be asserted here instead — and this is the better place for
 * it: a missing marker fails the build rather than a request.
 *
 * Route metadata is plain reflection on the decorators, so this walks the
 * module graph without instantiating anything — no Nest application, no
 * queries, no skipIf — a fence that only runs when compose happens to be up is
 * not a fence. Importing `AppModule` does still need `DATABASE_URL` set
 * (better-auth builds its client at module load); nothing here touches the
 * database with it.
 */

const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

interface DiscoveredRoute {
  readonly controller: string;
  readonly handler: string;
  readonly method: string;
  readonly path: string;
  readonly spec: OwnedResourceSpec | undefined;
}

/** Every route parameter in a path, e.g. `bots/:id/messages` -> ['id']. */
function parametersOf(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map(([, name]) => name ?? '');
}

function joinPath(base: unknown, sub: unknown): string {
  const segments = [base, sub]
    .map((part) => (typeof part === 'string' ? part : ''))
    .flatMap((part) => part.split('/'))
    .filter((part) => part !== '');
  return segments.join('/');
}

/** Follows `imports` from the root module, including dynamic-module wrappers. */
function collectControllers(root: unknown): unknown[] {
  const seen = new Set<unknown>();
  const controllers: unknown[] = [];
  const queue: unknown[] = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    const module =
      typeof current === 'object' && current !== null && 'module' in current
        ? (current as { module: unknown }).module
        : current;
    if (module === undefined || module === null || seen.has(module)) continue;
    seen.add(module);

    const own = Reflect.getMetadata('controllers', module as object);
    if (Array.isArray(own)) controllers.push(...own);

    const imports = Reflect.getMetadata('imports', module as object);
    if (Array.isArray(imports)) queue.push(...imports);
  }

  return controllers;
}

/**
 * Controllers a dynamic module adds by edition (D-152). `BillingModule.register`
 * returns them in a plain object, so they carry no `controllers` metadata to
 * walk, and a test server without Stripe does not import the module at all.
 * Listed here so their routes are fenced like every other.
 */
const EDITION_GATED_CONTROLLERS: readonly unknown[] = [BillingController, VoiceCallsController];

function discoverRoutes(): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  for (const controller of [...collectControllers(AppModule), ...EDITION_GATED_CONTROLLERS]) {
    if (typeof controller !== 'function') continue;
    const basePath: unknown = Reflect.getMetadata(PATH_METADATA, controller);
    const classSpec = Reflect.getMetadata(OWNED_RESOURCE, controller) as
      OwnedResourceSpec | undefined;
    const prototype: object = controller.prototype as object;

    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      const handler = descriptor?.value as unknown;
      if (typeof handler !== 'function') continue;

      const verb: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      if (typeof verb !== 'number') continue;

      const handlerSpec = Reflect.getMetadata(OWNED_RESOURCE, handler) as
        OwnedResourceSpec | undefined;

      routes.push({
        controller: controller.name,
        handler: name,
        method: RequestMethod[verb] ?? String(verb),
        path: joinPath(basePath, Reflect.getMetadata(PATH_METADATA, handler)),
        spec: handlerSpec ?? classSpec,
      });
    }
  }

  return routes.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

const routeKey = (route: Pick<DiscoveredRoute, 'method' | 'path'>): string =>
  `${route.method} /${route.path}`;

/**
 * Parameterised routes that deliberately do NOT carry a marker.
 *
 * The bot families resolve ownership inside their service through the
 * `findOwned` helper, which predates the guard and is what every query on
 * those rows is scoped by (see the R7 Prisma allowlist). Fencing them twice
 * would put the 404 in two places and make the service's own scoping look
 * optional.
 */
const EXEMPT: ReadonlyArray<{ route: string; reason: string }> = [
  {
    route: 'POST /channels/telegram/bots/:telegramBotId/webhook',
    reason:
      'D-233: Telegram posts here, not a person. The id names a Telegram bot, not a Crewaid row, and the post is refused 401 unless its secret header matches the digest stored for that bot; the update is then resolved to its one owner by bot, Telegram user and chat.',
  },
  {
    route: 'GET /templates/:id',
    reason:
      'D-229: a first-party catalog definition, identical for every authenticated account; no user-owned resource is addressed.',
  },
  {
    route: 'PATCH /memory/:id',
    reason:
      'D-229: MemoryService.editOwned resolves the memory by id AND principal.userId inside the correction transaction.',
  },
  {
    route: 'DELETE /memory/:id',
    reason:
      'D-229: MemoryService.forgetOwned resolves the memory by id AND principal.userId before forgetting and adding suppression.',
  },
  {
    route: 'DELETE /bots/:id/identity',
    reason:
      'IdentityHandoffService resolves the bot by id and principal.userId before admission, selection or computer access; absent and foreign both answer 404.',
  },
  {
    route: 'PATCH /bots/:id',
    reason: 'BotsService.findOwned scopes every bot query by principal.userId (R7).',
  },
  {
    route: 'GET /bots/:id/approvals',
    reason:
      'M5-BE-13. AgentTurnService.listPendingApprovals filters the in-process pending map on principal.userId before it returns a row, so a foreign bot id yields an empty list rather than another user\u2019s prompts. The map is not a table, and the bot-scoped families resolve ownership in their services (see the note above EXEMPT).',
  },
  {
    route: 'GET /bots/:id/turns',
    reason:
      'TurnHistoryService.list resolves the bot by id AND principal.userId before it reads a turn, answering 404 for absent and foreign alike, and scopes the turn query by the same userId. The bot-scoped families resolve ownership in their services (see the note above EXEMPT).',
  },
  {
    route: 'DELETE /bots/:id',
    reason: 'BotsService.findOwned scopes every bot query by principal.userId (R7).',
  },
  {
    route: 'POST /bots/:id/duplicate',
    reason: 'BotsService.findOwned scopes every bot query by principal.userId (R7).',
  },
  {
    route: 'POST /bots/:id/read',
    reason:
      'D-131. BotsService.markRead goes through findOwned, which scopes the bot by principal.userId (R7).',
  },
  {
    // D-199: GET/POST /bots/:id/messages were the AI SDK thread's routes and
    // are gone; the transcript lives behind the TanStack send route and this
    // list says so rather than keeping a hole for a door that was removed.
    route: 'DELETE /bots/:id/messages',
    reason:
      'D-147. MessagesService.deleteMessages resolves the bot through its owner, and every query in its transaction is scoped by conversation.bot.userId.',
  },
  {
    route: 'DELETE /bots/:id/messages/:messageId',
    reason:
      'D-147. MessagesService.deleteMessages resolves the bot through its owner, then finds the message inside that bot\u2019s conversation, so a foreign or mismatched id is a 404.',
  },
  {
    route: 'POST /bots/:id/topics',
    reason:
      'D-147. MessagesService.startTopic resolves the bot through its owner before it writes.',
  },
  {
    route: 'GET /bots/:id/sandbox',
    reason: 'SandboxService.assertOwned resolves the bot by principal.userId before any read.',
  },
  {
    route: 'POST /bots/:id/sandbox/start',
    reason: 'SandboxService.assertOwned resolves the bot by principal.userId before the lock.',
  },
  {
    route: 'POST /bots/:id/sandbox/stop',
    reason: 'SandboxService.assertOwned resolves the bot by principal.userId before any write.',
  },
  {
    route: 'POST /bots/:id/recordings',
    reason:
      'RecordingsService.start resolves the bot by principal.userId before it reserves a tee slot or wakes a computer.',
  },
  {
    route: 'GET /bots/:id/plugins',
    reason:
      'M6-BE-07. BotPluginsService.findOwnedBot resolves the bot by principal.userId before any read, and the server rows it joins are themselves scoped by userId. The bot-scoped families resolve ownership in their services (see the note above EXEMPT).',
  },
  {
    route: 'PUT /bots/:id/plugins',
    reason:
      'M6-BE-07. BotPluginsService.replace resolves the bot by principal.userId, then re-reads every submitted server id under the same scope before it writes — a foreign server id is a 404, not a link.',
  },
];

describe('D-010 — every direct-by-id route is fenced', () => {
  it('discovers the route table by reflection alone', () => {
    const routes = discoverRoutes();
    // A zero-length walk would make every assertion below vacuously true.
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.map(routeKey)).toContain('GET /attachments/:id/download');
  });

  it('leaves no parameterised route unmarked and unexempted', () => {
    const exempt = new Set(EXEMPT.map((entry) => entry.route));

    const unfenced = discoverRoutes()
      .filter((route) => parametersOf(route.path).length > 0)
      .filter((route) => route.spec === undefined)
      .filter((route) => !exempt.has(routeKey(route)))
      .map((route) => `${routeKey(route)} (${route.controller}.${route.handler})`);

    // Anything listed here reaches a handler with no ownership check. Add
    // @OwnedResource(kind, param) to the route, or an EXEMPT entry saying
    // which layer scopes it instead.
    expect(unfenced).toEqual([]);
  });

  it('names a parameter the route actually declares', () => {
    const mismatched = discoverRoutes()
      .filter((route) => route.spec !== undefined)
      .filter((route) => !parametersOf(route.path).includes(route.spec?.param ?? ''))
      .map((route) => `${routeKey(route)} marks :${route.spec?.param ?? ''}`);

    // A marker naming an absent parameter fences nothing: the guard finds no
    // id and 404s every request to a route that should have worked.
    expect(mismatched).toEqual([]);
  });

  it('does not mark routes that carry no parameter at all', () => {
    const pointless = discoverRoutes()
      .filter((route) => route.spec !== undefined && parametersOf(route.path).length === 0)
      .map(routeKey);

    expect(pointless).toEqual([]);
  });

  it('fails closed when a marker is dropped', () => {
    // The check above is only evidence if it can be shown failing (D-013).
    const withoutMarkers = discoverRoutes().map((route) => ({ ...route, spec: undefined }));
    const exempt = new Set(EXEMPT.map((entry) => entry.route));

    const unfenced = withoutMarkers
      .filter((route) => parametersOf(route.path).length > 0)
      .filter((route) => route.spec === undefined)
      .filter((route) => !exempt.has(routeKey(route)))
      .map(routeKey);

    expect(unfenced).toContain('GET /attachments/:id/download');
    expect(unfenced).toContain('DELETE /attachments/:id');
  });

  it('keeps every exemption accounted for and explained', () => {
    const parameterised = new Set(
      discoverRoutes()
        .filter((route) => parametersOf(route.path).length > 0)
        .map(routeKey),
    );

    for (const entry of EXEMPT) {
      // A stale exemption is a fence with a hole waiting for the route to
      // come back under a name nobody rechecked.
      expect(
        parameterised,
        `exemption for a route that no longer exists: ${entry.route}`,
      ).toContain(entry.route);
      expect(entry.reason.length, `uncommented exemption ${entry.route}`).toBeGreaterThan(20);
    }
  });
});
