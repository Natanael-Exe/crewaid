import { MiddlewareConsumer, Module, RequestMethod, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { API_PREFIX, AUTH_BASE_PATH } from '@crewaid/shared';
import { AttachmentsModule } from './attachments/attachments.module.js';
import { ExperienceModule } from './experience/experience.module.js';
import { BotsModule } from './bots/bots.module.js';
import { ChatDeliveryModule } from './chat/chat-delivery.module.js';
import { GroupsModule } from './groups/groups.module.js';
import { WorkModule } from './work/work.module.js';
import { TaskStartModule } from './work/task-start.module.js';
import { WorkToolsModule } from './work/work-tools.module.js';
import { AuthGuard } from './auth/auth.guard.js';
import { BetterAuthMiddleware } from './auth/auth.middleware.js';
import { HealthModule } from './health/health.module.js';
import { ModelsModule } from './models/models.module.js';
import { OwnershipModule } from './ownership/ownership.module.js';
import { SandboxModule } from './sandbox/sandbox.module.js';
import { RecordingsModule } from './recordings/recordings.module.js';
import { ScreenModule } from './screen/screen.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { ResourceOwnershipGuard } from './ownership/resource-ownership.guard.js';
import { MulterErrorFilter } from './attachments/multer-error.filter.js';
import { KeyringConfigFilter } from './credentials/keyring-config.filter.js';
import { NoStoreMiddleware } from './common/no-store.middleware.js';
import { HttpHardeningMiddleware } from './common/http-hardening.middleware.js';
import { RequestLoggingMiddleware } from './logging/request-logging.middleware.js';
import { WsGateway } from './ws/ws.gateway.js';
import { WsPrincipals } from './ws/ws-principals.js';
import { UsageModule } from './usage/usage.module.js';
import { ProvidersModule } from './providers/providers.module.js';
import { InterbotModule } from './interbot/interbot.module.js';
import { McpModule } from './mcp/mcp.module.js';
import { RoutinesModule } from './routines/routines.module.js';
import { VoiceModule } from './voice/voice.module.js';
import { TelegramModule } from './telegram/telegram.module.js';

/**
 * Where the auth tree mounts, RELATIVE to the global prefix Nest adds back.
 *
 * `/api/v1/auth` minus `/api/v1` is `/auth`; `*path` covers the tree beneath
 * it. Derived rather than retyped, and asserted at module load, so a change to
 * either constant fails the boot instead of silently unmounting sign-in again.
 */
const AUTH_MIDDLEWARE_PATH = `${AUTH_BASE_PATH.slice(API_PREFIX.length)}/*path`;

if (!AUTH_BASE_PATH.startsWith(`${API_PREFIX}/`)) {
  throw new Error(
    `AUTH_BASE_PATH (${AUTH_BASE_PATH}) must sit under API_PREFIX (${API_PREFIX}) ` +
      'for the Better Auth middleware to mount under the global prefix.',
  );
}

/**
 * Root module. AuthGuard registers as a global APP_GUARD so every
 * route is guarded by default — including routes added in later
 * milestones, which is the point: guard-by-default means a new controller
 * cannot ship unauthenticated by forgetting a decorator. The CurrentUser
 * decorator consumes the `request.principal` the guard attaches. ModelsModule
 * rides the same guarantee: `/api/v1/models` is guarded because
 * every route is.
 *
 * MulterErrorFilter is an APP_FILTER so test bootstraps and
 * production behave identically: Multer limit violations answer 413.
 * KeyringConfigFilter is one for the same reason, and answers 503 rather than
 * letting a misconfigured credential vault reach an operator as a bare 500.
 *
 * WsGateway is registered as a provider so SocketModule discovers
 * it in every bootstrap. The transport adapter (CrewaidWsAdapter) must be set
 * on the NestApplication with `app.useWebSocketAdapter(new CrewaidWsAdapter(app))`
 * BEFORE init/listen — main.ts does this, and so must any test harness that
 * boots AppModule and opens the HTTP listener, because without it SocketModule
 * falls back to socket.io (not installed) and hard-exits the process. This
 * coupling is load-bearing: see ws/crewaid-ws.adapter.ts for the WebSocket rationale.
 */
@Module({
  imports: [
    BotsModule,
    ExperienceModule,
    GroupsModule,
    ChatDeliveryModule,
    TelegramModule,
    WorkModule,
    TaskStartModule,
    WorkToolsModule,
    AttachmentsModule,
    ModelsModule,
    OwnershipModule,
    LoggingModule,
    SandboxModule,
    RecordingsModule,
    ScreenModule,
    // The REST health surface. It owns its controller because the
    // readiness read needs the sandbox provider and the poll service, and
    // "health" is not a feature of any other module.
    HealthModule,
    // The REST usage surface. Same reasoning: a cross-bot read of the
    // D-009(3) turn counters is not a feature of any single domain module.
    UsageModule,
    // Provider connections, their models, and the per-user default
    //. Owns the credential vault's only writer.
    ProvidersModule,
    // Bot-to-bot delivery, and the `send_message` tool that feeds it.
    // Imported here rather than from `BotsModule`, which it depends on: the
    // tool registers itself from the module that owns its queue (M5-BE-06's
    // rule), so the arrow runs interbot → bots and not back.
    InterbotModule,
    // The curated plugin directory and installed MCP servers
    //. M6-BE-03 … M6-BE-10 grow inside this module rather than
    // beside it: they are all facets of one server row.
    McpModule,
    // Routines: the schedule in Redis, and what a firing runs.
    RoutinesModule,
    // Dictation, voice messages and spoken replies, in both editions.
    VoiceModule,
    // The hosted service's plans are not here: they live in ee/ and are
    // added by CloudAppModule (D-238), which imports this module.
  ],
  providers: [
    WsGateway,
    // Who each open socket is, and whether they still are. A provider
    // rather than a field on the gateway because the gateway is constructed
    // per application context and this holds live sockets — the two have the
    // same lifetime, and DI is what makes a test able to supply its own clock.
    WsPrincipals,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ResourceOwnershipGuard },
    { provide: APP_FILTER, useClass: MulterErrorFilter },
    { provide: APP_FILTER, useClass: KeyringConfigFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // NoStore first: the header must be on the response even if a later
    // middleware throws, and it is the only one whose absence is invisible
    // until a contract changes weeks later.
    consumer
      .apply(NoStoreMiddleware, RequestLoggingMiddleware, HttpHardeningMiddleware)
      .forRoutes('*');

    // Better Auth's own route tree, AFTER the three above so a sign-in
    // is logged and carries `no-store` like everything else. A sign-in
    // response sets a session cookie, which is precisely what must not sit in
    // a cache.
    // The path is written without the global prefix
    // `setGlobalPrefix` rewrites MIDDLEWARE paths as well as controller
    // routes. Spelling the prefix out here bound the tree one prefix too deep
    // — at `/api/v1/api/v1/auth/*` — and every sign-in route answered Nest's
    // 404 for the whole of V1. Unmatched middleware does not run, so there was
    // no error to find, and both tests over those routes agreed with the bug:
    // one asserted `status !== 401`, which a 404 satisfies, and the other read
    // this very spec out of the module and asserted it back.
    // And it is a path, not a wildcard
    // `forRoutes('*')` with the middleware matching the path itself looks more
    // robust — it is what `@thallesp/nestjs-better-auth` does — and it is not,
    // HERE. That library registers on the raw adapter (`httpAdapter.use`),
    // outside Nest's middleware routing. Going through `forRoutes('*')`
    // instead leaves `req.url` rewritten to `/` with only the query attached,
    // and `toNodeHandler` builds the request it answers from `req.url` — so
    // every OAuth callback arrived stripped of its `state` and Better Auth
    // redirected to `error=state_not_found` about a state Google did send.
    // A path mount keeps `req.url` intact. `auth-session.integration.test.ts`
    // asserts the query survives, because "the tree is mounted" does not imply
    // it: `get-session` takes no parameters and answers 200 either way.
    consumer
      .apply(BetterAuthMiddleware)
      .forRoutes({ path: AUTH_MIDDLEWARE_PATH, method: RequestMethod.ALL });
  }
}
