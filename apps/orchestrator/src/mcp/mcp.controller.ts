import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../auth/better-auth.js';
import {
  PluginAccessSchema,
  type PluginAccess,
  InstallMcpServerBodySchema,
  SetMcpCredentialBodySchema,
  type ConnectMcpServerResponse,
  type InstallMcpServerBody,
  type ListMcpDirectoryResponse,
  type ListMcpServersResponse,
  type McpServerSummary,
  type Principal,
  type SetMcpCredentialBody,
} from '@crewaid/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import {
  callbackContentSecurityPolicy,
  MCP_OAUTH_CALLBACK_HEADERS,
  renderMcpOAuthCallbackPage,
} from './mcp-oauth-callback-page.js';
import { BotPluginsService } from './bot-plugins.service.js';
import { McpServersService } from './mcp-servers.service.js';

/**
 * The REST MCP surface that installs, connects, and inspects servers.
 *
 * Every direct-by-id route carries `@OwnedResource`, so the guard resolves the
 * row to an owner before any handler logic runs; the service scopes
 * every query by `userId` anyway, and `ownership-route-coverage.test.ts` fails
 * the build if a marker goes missing. The two collection routes take no
 * parameter and are fenced by the scoping inside the service.
 *
 * NOTHING HERE RETURNS A CREDENTIAL. `DELETE` is the revocation path and
 * `GET /mcp/servers` answers summaries whose schema has no field token
 * material could travel in. `connect` is the one route whose answer is
 * a URL that will CARRY the user to a consent screen — it holds a `state` and
 * a PKCE challenge, both worthless without the verifier that stays in the
 * database.
 *
 * The one route here that cannot be authenticated
 *
 * `GET /mcp/oauth/callback` is the redirect target, so the caller is a browser
 * that was never signed in and carries no session — its entire authority is
 * the `state` value minted by `connect` and consumed exactly once. It is
 * exempted by exact pathname in `AuthGuard`, next to the health and sign-in
 * exemptions, and for the same reason: a guard that cannot be satisfied on a
 * path that must be reachable. This is the ONLY route in the codebase whose
 * authorization is a single-use row rather than a Principal, which is why its
 * handler reads nothing from `@CurrentUser`.
 */
@Controller('mcp')
export class McpController {
  constructor(
    @Inject(McpServersService) private readonly servers: McpServersService,
    @Inject(BotPluginsService) private readonly plugins: BotPluginsService,
  ) {}

  /** The installable catalog. Same answer for every user; install is per user. */
  @Get('directory')
  async directory(): Promise<ListMcpDirectoryResponse> {
    return this.servers.listDirectory();
  }

  @Get('servers')
  async list(@CurrentUser() principal: Principal): Promise<ListMcpServersResponse> {
    return this.servers.list(principal.userId);
  }

  @Post('servers')
  @HttpCode(HttpStatus.CREATED)
  install(
    @Body(new ZodValidationPipe(InstallMcpServerBodySchema)) body: InstallMcpServerBody,
    @CurrentUser() principal: Principal,
  ): Promise<McpServerSummary> {
    return this.servers.install(principal.userId, body);
  }

  /**
   * replace a header server's bearer, write-only.
   *
   * `PUT` because it REPLACES: one server has one credential, and the body is
   * the whole of it. The response is the server summary every other route on
   * this controller answers with — which carries no credential field, because
   * `McpServerSummarySchema` has none to carry.
   */
  @Put('servers/:id/credential')
  @OwnedResource('mcpServer')
  @HttpCode(HttpStatus.OK)
  setCredential(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SetMcpCredentialBodySchema)) body: SetMcpCredentialBody,
    @CurrentUser() principal: Principal,
  ): Promise<McpServerSummary> {
    return this.servers.setCredential(principal.userId, id, body.bearerToken);
  }

  @Put('servers/:id/access')
  @OwnedResource('mcpServer')
  setAccess(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PluginAccessSchema)) access: PluginAccess,
    @CurrentUser() principal: Principal,
  ): Promise<PluginAccess> {
    return this.plugins.setAccess(principal.userId, id, access);
  }

  @Post('servers/:id/refresh-tools')
  @OwnedResource('mcpServer')
  // 200, not Nest's 201: this re-reads a thing that already exists, and a
  // created-shaped answer would say a row appeared when none did.
  @HttpCode(HttpStatus.OK)
  refreshTools(
    @Param('id') id: string,
    @CurrentUser() principal: Principal,
  ): Promise<McpServerSummary> {
    return this.servers.refreshTools(principal.userId, id);
  }

  @Delete('servers/:id')
  @OwnedResource('mcpServer')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<void> {
    await this.servers.remove(principal.userId, id);
  }

  /**
   * REST connect route.
   *
   * 200 rather than Nest's 201: nothing is created here that the response
   * names. A server that needs no credential is listed on the spot; every
   * other one answers an authorize URL the desktop opens in the system
   * browser. Both shapes are in one schema so the client narrows on one
   * response rather than guessing from a status code.
   */
  @Post('servers/:id/connect')
  @OwnedResource('mcpServer')
  @HttpCode(HttpStatus.OK)
  connect(
    @Param('id') id: string,
    @CurrentUser() principal: Principal,
  ): Promise<ConnectMcpServerResponse> {
    return this.servers.connect(principal.userId, id);
  }

  /**
   * The redirect target: a person in a browser tab, not an API client.
   *
   * Everything about whether this worked was decided before the page was
   * rendered, and the answer is BOTH of the things a caller could need:
   * a page for the person (a JSON error body would be shown raw to somebody
   * who has no idea what an orchestrator is) and an `X-Crewaid-Mcp-Connect`
   * header for a caller that needs the verdict without parsing prose.
   *
   * 200 IS THE ANSWER TO EVERY OUTCOME, AND THE HEADER IS THE VERDICT.
   * A refusal page served as a 400 or a 502 is a page a reverse proxy
   * or a CDN in front of this orchestrator is entitled to replace with an
   * error body of its own — and then the person who just pressed "authorize"
   * reads "Bad gateway" instead of the one sentence that told them what
   * happened and what to do next. The refusal's own status is therefore not in
   * the response at all: the code travels in `X-Crewaid-Mcp-Connect`, where
   * nothing between here and the caller rewrites it, and `no-store` keeps the
   * URL — which holds a state and possibly a code — out of a disk cache.
   */
  @Get('oauth/callback')
  async callback(
    @Query() query: Record<string, unknown>,
    @Req() req: IncomingMessage,
    @Res() res: CallbackResponse,
  ): Promise<void> {
    // Not authentication — the route has none to require (the provider
    // redirects a browser that may never have signed in here). A session the
    // browser does carry is a fact about who is approving, and a different
    // account's is refused (`other-account`).
    const browserUserId = await auth.api
      .getSession({ headers: fromNodeHeaders(req.headers) })
      .then((session) => session?.user.id ?? null)
      .catch(() => null);
    return this.servers.completeOAuthCallback(query, browserUserId).then((outcome) => {
      const nonce = randomUUID();
      res.status(HttpStatus.OK);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      for (const [name, value] of Object.entries(MCP_OAUTH_CALLBACK_HEADERS)) {
        res.setHeader(name, value);
      }
      res.setHeader('Content-Security-Policy', callbackContentSecurityPolicy(nonce));
      res.setHeader('X-Crewaid-Mcp-Connect', outcome.ok ? 'ok' : `failed:${outcome.code}`);
      res.send(renderMcpOAuthCallbackPage(outcome, nonce));
    });
  }
}

/**
 * The response surface this controller uses, typed here rather than imported.
 *
 * `@types/express` is not a dependency of this app (`attachments.controller.ts`
 * says why: a transitive bump must not be able to change what an operator's
 * download looks like), so `@Res` would arrive as `any` — which the lint
 * config forbids. Naming the four members this handler calls keeps the
 * narrowing honest and the dependency where it is.
 */
type CallbackResponse = {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  send(body: string): unknown;
};
