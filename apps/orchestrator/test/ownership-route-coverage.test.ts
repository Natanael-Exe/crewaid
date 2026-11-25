import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  collectControllers,
  parametersOf,
  routeKey,
  routesOf,
  mismatched,
  pointless,
  unfenced,
  type Exemption,
} from './route-coverage-walker.js';

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
 *
 * This is the core's route table. The cloud edition's routes (billing, calls)
 * live in `ee/` and are fenced by the same rules in the Enterprise suite
 * (D-238).
 */

const discoverRoutes = () => routesOf(collectControllers(AppModule));

/**
 * Parameterised routes that deliberately do NOT carry a marker.
 *
 * The bot families resolve ownership inside their service through the
 * `findOwned` helper, which predates the guard and is what every query on
 * those rows is scoped by (see the R7 Prisma allowlist). Fencing them twice
 * would put the 404 in two places and make the service's own scoping look
 * optional.
 */
const EXEMPT: readonly Exemption[] = [
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
      'ApprovalService filters pending approvals on principal.userId before returning a row, so a foreign bot id yields an empty list rather than another user\u2019s prompts. The bot-scoped families resolve ownership in their services (see the note above EXEMPT).',
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
  {
    route: 'GET /bots/:id/workflows',
    reason:
      'Phase 2. WorkflowControlService.listWorkflows resolves the bot by id AND principal.userId before querying active chains under the same userId scope.',
  },
  {
    route: 'POST /bots/:id/workflows/stop',
    reason:
      'Phase 2. WorkflowControlService.stopWorkflow resolves the bot by id AND principal.userId before cancelling runs or writing chain state under the same userId scope.',
  },
  {
    route: 'POST /bots/:id/workflows/wrap-up',
    reason:
      'Phase 2. WorkflowControlService.wrapUpWorkflow resolves the bot by id AND principal.userId before enqueuing owner closeout prompts or writing chain state under the same userId scope.',
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
    // Anything listed here reaches a handler with no ownership check. Add
    // @OwnedResource(kind, param) to the route, or an EXEMPT entry saying
    // which layer scopes it instead.
    expect(unfenced(discoverRoutes(), EXEMPT)).toEqual([]);
  });

  it('names a parameter the route actually declares', () => {
    // A marker naming an absent parameter fences nothing: the guard finds no
    // id and 404s every request to a route that should have worked.
    expect(mismatched(discoverRoutes())).toEqual([]);
  });

  it('does not mark routes that carry no parameter at all', () => {
    expect(pointless(discoverRoutes())).toEqual([]);
  });

  it('fails closed when a marker is dropped', () => {
    // The check above is only evidence if it can be shown failing (D-013).
    const withoutMarkers = discoverRoutes().map((route) => ({ ...route, spec: undefined }));
    const found = unfenced(withoutMarkers, EXEMPT);

    expect(found).toContainEqual(expect.stringMatching(/^GET \/attachments\/:id\/download /));
    expect(found).toContainEqual(expect.stringMatching(/^DELETE \/attachments\/:id /));
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
