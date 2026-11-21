import { toolReach } from '../src/agent/tool-registry.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PLUGIN_LISTING_TOKEN_BUDGET, type BotPlugin, BotPluginSchema } from '@crewaid/shared';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { BotPluginsService } from '../src/mcp/bot-plugins.service.js';
import { ToolRegistry } from '../src/agent/tool-registry.js';
import { TurnPlugins } from '../src/agent/turn-plugins.js';
import { signIn, type SignedInUser } from './auth-fixture.js';

/**
 * M6-BE-07 / M6-QA-03 / D-113 — plugins are per bot, and there is no ceiling.
 *
 * Two users throughout, like every D-010 suite, so a refusal is asserted
 * against a PRESENCE: the foreign rows exist for the whole run and the owner
 * fetches them in the same case that proves the other user cannot.
 *
 * ── WHY NO MCP SERVER IS RUNNING HERE ───────────────────────────────────────
 *
 * Everything this task decides is decided from the `McpTool` CACHE: which
 * servers a bot has, what its catalogue holds, and what the turn is offered. §6/M6 put that cache there precisely so a turn does not wait on
 * eight servers answering `tools/list` before the model sees a token — so
 * seeding rows is not a shortcut around the protocol, it is the state the
 * protocol leaves behind. The live round trip (install → connect → list →
 * enable → call) is M6-QA-05's, against the stub in
 * `mcp-servers.integration.test.ts`.
 *
 * Needs DATABASE_URL. Without it every case skips and the run still reports
 * green (CLAUDE.md: a silently skipped test is a dormant guard).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

let app: INestApplication;
let prisma: PrismaService;
let plugins: BotPluginsService;
let registry: ToolRegistry;
let ACTOR: SignedInUser;
let FOREIGN: SignedInUser;

const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Test => request(app.getHttpServer()) as unknown as request.Test;

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M6-BE-07 — per-bot plugins and the 40-tool ceiling',
  () => {
    let seed = 0;

    beforeAll(async () => {
      process.env['CREDENTIAL_KEY'] = '33'.repeat(32);
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();

      prisma = app.get(PrismaService);
      plugins = app.get(BotPluginsService);
      registry = app.get(ToolRegistry);
      ACTOR = await signIn(prisma, { label: 'plugins' });
      FOREIGN = await signIn(prisma, { label: 'plugins-foreign' });
    }, 60_000);

    /**
     * How many of the ceiling the built-ins already spend.
     *
     * Read from the live registry rather than written down, because it is not
     * a constant: every milestone that adds a built-in moves it, and a suite
     * with the number baked in would start asserting the wrong boundary
     * silently the day one lands.
     */
    const builtins = (): number => registry.names().length;

    async function makeBot(owner: SignedInUser = ACTOR): Promise<string> {
      seed += 1;
      const bot = await prisma.bot.create({
        data: {
          userId: owner.userId,
          name: `Plugin Bot ${RUN_ID}-${seed}`,
          role: 'Tester',
          avatarColor: '#8B6F47',
          systemPrompt: '',
        },
      });
      return bot.id;
    }

    /** A CONNECTED server with `toolCount` cached tools. */
    async function makeServer(
      toolCount: number,
      options: {
        owner?: SignedInUser;
        status?: 'CONNECTED' | 'ERROR' | 'NEEDS_REAUTH';
        /** M6-BE-08's verdict, as the listing would have written it. */
        readOnly?: boolean;
      } = {},
    ): Promise<{ id: string; slug: string; name: string }> {
      seed += 1;
      const owner = options.owner ?? ACTOR;
      const slug = `plug-${RUN_ID}-${seed}`;
      const server = await prisma.mcpServer.create({
        data: {
          userId: owner.userId,
          name: `Plug ${seed}`,
          slug,
          transport: 'HTTP',
          url: 'https://plugin.example.test/mcp',
          isPrivate: true,
          authType: 'NONE',
          status: options.status ?? 'CONNECTED',
          tools: {
            create: Array.from({ length: toolCount }, (_unused, index) => ({
              // Zero-padded so the `name: asc` order the resolver uses is the
              // order they were created in — otherwise `tool_10` sorts before
              // `tool_2` and a budget case measures a different set than it
              // seeded.
              name: `tool_${String(index).padStart(3, '0')}`,
              description: `does thing ${String(index)}`,
              inputSchema: { type: 'object', properties: {} },
              readOnly: options.readOnly ?? false,
            })),
          },
        },
      });
      return { id: server.id, slug, name: server.name };
    }

    const listPlugins = async (botId: string, actor = ACTOR): Promise<BotPlugin[]> => {
      const response = await http()
        .get(api(`/bots/${botId}/plugins`))
        .set(actor.headers);
      expect(response.status).toBe(200);
      return BotPluginSchema.array().parse(response.body);
    };

    const setPlugins = (botId: string, serverIds: string[], actor = ACTOR): request.Test =>
      http()
        .put(api(`/bots/${botId}/plugins`))
        .set(actor.headers)
        .send({ serverIds });

    async function clearFixtures(): Promise<void> {
      await prisma.mcpServer.deleteMany({
        where: { userId: { in: [ACTOR.userId, FOREIGN.userId] } },
      });
      await prisma.bot.deleteMany({ where: { userId: { in: [ACTOR.userId, FOREIGN.userId] } } });
    }

    beforeEach(clearFixtures);

    afterAll(async () => {
      await clearFixtures();
      await app.close();
      await prisma.user.deleteMany({ where: { id: { in: [ACTOR.userId, FOREIGN.userId] } } });
    });

    describe('listing', () => {
      it('lists every installed server with this bot’s enablement on it', async () => {
        const botId = await makeBot();
        const enabled = await makeServer(2);
        const idle = await makeServer(3);
        await setPlugins(botId, [enabled.id]).expect(200);

        expect(await listPlugins(botId)).toEqual([
          {
            serverId: enabled.id,
            slug: enabled.slug,
            name: enabled.name,
            enabled: true,
            toolCount: 2,
          },
          { serverId: idle.id, slug: idle.slug, name: idle.name, enabled: false, toolCount: 3 },
        ]);
      });

      it('is per bot, so enabling one bot’s plugin does not enable another’s', async () => {
        const [first, second] = [await makeBot(), await makeBot()];
        const server = await makeServer(1);
        await setPlugins(first, [server.id]).expect(200);

        expect((await listPlugins(first)).map((row) => row.enabled)).toEqual([true]);
        expect((await listPlugins(second)).map((row) => row.enabled)).toEqual([false]);
      });

      it('shows nobody else’s servers, and cannot be read for somebody else’s bot', async () => {
        const botId = await makeBot();
        const mine = await makeServer(1);
        await makeServer(1, { owner: FOREIGN });

        // The owner sees exactly their own — the presence the refusal below is
        // asserted against.
        expect((await listPlugins(botId)).map((row) => row.serverId)).toEqual([mine.id]);
        await http()
          .get(api(`/bots/${botId}/plugins`))
          .set(FOREIGN.headers)
          .expect(404);
      });
    });

    describe('replacing the set', () => {
      it('replaces rather than merges', async () => {
        const botId = await makeBot();
        const first = await makeServer(1);
        const second = await makeServer(1);

        await setPlugins(botId, [first.id]).expect(200);
        const after = await setPlugins(botId, [second.id]).expect(200);

        const enabled = BotPluginSchema.array()
          .parse(after.body)
          .filter((row) => row.enabled)
          .map((row) => row.serverId);
        expect(enabled).toEqual([second.id]);
      });

      it('answers with the set the bot now has', async () => {
        const botId = await makeBot();
        const server = await makeServer(4);

        const response = await setPlugins(botId, [server.id]).expect(200);

        expect(BotPluginSchema.array().parse(response.body)).toEqual([
          {
            serverId: server.id,
            slug: server.slug,
            name: server.name,
            enabled: true,
            toolCount: 4,
          },
        ]);
      });

      it('clears the set when given an empty list', async () => {
        const botId = await makeBot();
        const server = await makeServer(1);
        await setPlugins(botId, [server.id]).expect(200);

        await setPlugins(botId, []).expect(200);

        expect((await listPlugins(botId)).map((row) => row.enabled)).toEqual([false]);
      });

      it('404s a server the caller does not own, and writes nothing', async () => {
        const botId = await makeBot();
        const mine = await makeServer(1);
        const theirs = await makeServer(1, { owner: FOREIGN });
        await setPlugins(botId, [mine.id]).expect(200);

        await setPlugins(botId, [mine.id, theirs.id]).expect(404);

        // The refusal left the set exactly as it was, rather than half-applied.
        expect(
          (await listPlugins(botId)).filter((row) => row.enabled).map((row) => row.serverId),
        ).toEqual([mine.id]);
      });

      it('cannot be written for somebody else’s bot', async () => {
        const botId = await makeBot();
        const server = await makeServer(1, { owner: FOREIGN });
        await http()
          .put(api(`/bots/${botId}/plugins`))
          .set(FOREIGN.headers)
          .send({ serverIds: [server.id] })
          .expect(404);
      });
    });

    describe('D-113 the plugin surface, at any size', () => {
      /**
       * How many definitions a turn would actually resolve for this bot.
       *
       * D-113 stopped counting plugin tools: a bot's whole catalogue reaches
       * the turn through two bridge definitions, whose listing is bounded in
       * tokens and degrades rather than refusing. What is asserted below is
       * that number — constant in the catalogue — and not a ceiling.
       */
      async function resolvedCount(botId: string): Promise<number> {
        const resolved = await plugins.toolsForBot(ACTOR.userId, botId);
        return builtins() + resolved.tools.length;
      }

      /** The two doors, in the order the bridge offers them. */
      const DOORS = ['find_plugin_tools', 'use_plugin_tool'];

      it('takes a server this build used to refuse, and a much larger one', async () => {
        // D-106 shipped the 40-definition cap and said out loud what it cost:
        // a thirty-tool server does not fit beside this build's own tools, so
        // `PUT /bots/:id/plugins` rejected a configuration an operator had
        // every reason to want. This is that case, and one an order of
        // magnitude past it.
        for (const size of [30, 40, 41, 400]) {
          const botId = await makeBot();
          const server = await makeServer(size);

          await setPlugins(botId, [server.id]).expect(200);

          const resolved = await plugins.toolsForBot(ACTOR.userId, botId);
          expect(resolved.refusals, `a server of ${String(size)} tools`).toEqual([]);
          expect(resolved.tools.map((entry) => entry.name)).toEqual(DOORS);
        }
      });

      it('spends the same two definitions on three hundred tools as on one', async () => {
        const small = await makeBot();
        const huge = await makeBot();
        const one = await makeServer(1);
        const many = await makeServer(300);
        await setPlugins(small, [one.id]).expect(200);
        await setPlugins(huge, [many.id]).expect(200);

        expect(await resolvedCount(huge)).toBe(await resolvedCount(small));
      });

      it('keeps every tool reachable, however far down the listing gives way', async () => {
        // The property the cap was never able to offer: a tool that is not
        // ADVERTISED is still reachable, because the listing is what degrades
        // and the search is over the whole catalogue. Asserted on the last
        // tool of a catalogue whose listing cannot possibly carry it.
        const botId = await makeBot();
        // 800 is past the point where 4000 tokens covers even the names, so
        // the listing here is the last rung: the plugins, and their counts.
        const big = await makeServer(800);
        await setPlugins(botId, [big.id]).expect(200);

        const resolved = await plugins.toolsForBot(ACTOR.userId, botId);
        const find = resolved.tools.find((entry) => entry.name === 'find_plugin_tools');
        const listing = String(
          await find?.build({} as never).execute?.({}, { toolCallId: 'c', messages: [] }),
        );
        const found = String(
          await find
            ?.build({} as never)
            .execute?.({ query: 'tool_799' }, { toolCallId: 'c', messages: [] }),
        );

        // Out of the listing…
        expect(listing).not.toContain(`${big.slug}__tool_799`);
        // …and in the search the model can always run.
        expect(found).toContain(`${big.slug}__tool_799`);
        expect(found).toContain('"properties"');
      });

      it('bounds what the model is sent, in tokens, whatever the catalogue holds', async () => {
        // The number §7.4 was reaching for. Two definitions plus a listing the
        // budget covers — where "the budget covers it" is measured on the
        // answer `find_plugin_tools` gives to no query, which is the same text
        // the definition carries.
        const botId = await makeBot();
        const big = await makeServer(400);
        await setPlugins(botId, [big.id]).expect(200);

        const resolved = await plugins.toolsForBot(ACTOR.userId, botId);
        const find = resolved.tools.find((entry) => entry.name === 'find_plugin_tools');
        const listing = String(
          await find?.build({} as never).execute?.({}, { toolCallId: 'c', messages: [] }),
        );

        expect(Math.ceil(listing.length / 4)).toBeLessThanOrEqual(PLUGIN_LISTING_TOKEN_BUDGET);
        expect(listing).toContain(big.slug);
      });

      it('spends the bridge in a stable order, turn after turn', async () => {
        // Which tools a truncated listing keeps matters less than the set
        // being the same every turn: a bot that can do something and then
        // cannot is worse than one that never could.
        const botId = await makeBot();
        const big = await makeServer(400);
        await setPlugins(botId, [big.id]).expect(200);

        const first = (await plugins.toolsForBot(ACTOR.userId, botId)).tools.map((t) => t.name);
        const second = (await plugins.toolsForBot(ACTOR.userId, botId)).tools.map((t) => t.name);

        expect(second).toEqual(first);
      });

      it('changes nothing about the write path it replaced — a bad id still 404s', async () => {
        // The one refusal `PUT /bots/:id/plugins` still makes is about the id,
        // which is D-010's non-leaking answer, and the set it does not write
        // is left exactly as it was.
        const botId = await makeBot();
        const kept = await makeServer(1);
        await setPlugins(botId, [kept.id]).expect(200);

        await setPlugins(botId, [kept.id, 'not-a-server']).expect(404);

        expect(
          (await listPlugins(botId)).filter((row) => row.enabled).map((row) => row.serverId),
        ).toEqual([kept.id]);
      });
    });

    describe('what a turn is offered', () => {
      it('namespaces every tool for the server it came from', async () => {
        // The namespacing moved from the offered definitions to the catalogue
        // behind the door (D-113): the model reads `<slug>__<name>` in the
        // listing, and the call it makes with that name is what reaches the
        // server. Both halves are asserted here because only together do they
        // say the tool is reachable under the name the model was shown.
        const botId = await makeBot();
        const server = await makeServer(2);
        await setPlugins(botId, [server.id]).expect(200);

        const resolved = await plugins.toolsForBot(ACTOR.userId, botId);
        const door = resolved.tools.find((entry) => entry.name === 'use_plugin_tool');
        const find = resolved.tools.find((entry) => entry.name === 'find_plugin_tools');
        const listing = String(
          await find?.build({} as never).execute?.({}, { toolCallId: 'c', messages: [] }),
        );

        expect(listing).toContain(`${server.slug}__tool_000`);
        expect(listing).toContain(`${server.slug}__tool_001`);
        expect(door?.unwrap?.({ tool: `${server.slug}__tool_000` })?.behavior?.origin).toEqual({
          kind: 'mcp',
          serverId: server.id,
        });
        expect(resolved.refusals).toEqual([]);
      });

      it('carries M6-BE-08’s classification onto what a call is about', async () => {
        // §6/M6: "Every MCP tool defaults to `ask`. Tools classified
        // `readOnly` default to `allow`." `reach` is where the approval
        // matcher reads that — and since D-113 the tool a call names is what
        // it reads it off, so the two servers are seeded side by side:
        // otherwise a catalogue that hard-coded either value would pass.
        const botId = await makeBot();
        const writes = await makeServer(1);
        const reads = await makeServer(1, { readOnly: true });
        await setPlugins(botId, [writes.id, reads.id]).expect(200);

        const resolved = await plugins.toolsForBot(ACTOR.userId, botId);
        const door = resolved.tools.find((entry) => entry.name === 'use_plugin_tool');

        expect(toolReach(door?.unwrap?.({ tool: `${writes.slug}__tool_000` })?.behavior)).toBe(
          'sensitive',
        );
        expect(toolReach(door?.unwrap?.({ tool: `${reads.slug}__tool_000` })?.behavior)).toBe(
          'contained',
        );
      });

      it('offers nothing from a server the bot has not enabled', async () => {
        const botId = await makeBot();
        await makeServer(2);

        expect((await plugins.toolsForBot(ACTOR.userId, botId)).tools).toEqual([]);
      });

      it('leaves a server that is not connected out of the catalogue', async () => {
        // §6/M6: a server in ERROR "stays out of tool sets until reconnected".
        // Its cached tools are still there — which is why this is asserted
        // against a CONNECTED sibling seeded in the same case, and against the
        // note that names the two that took no part.
        const botId = await makeBot();
        const healthy = await makeServer(1);
        const broken = await makeServer(1, { status: 'ERROR' });
        const stale = await makeServer(1, { status: 'NEEDS_REAUTH' });
        await setPlugins(botId, [healthy.id, broken.id, stale.id]).expect(200);

        const resolved = await plugins.toolsForBot(ACTOR.userId, botId);
        const door = resolved.tools.find((entry) => entry.name === 'use_plugin_tool');

        // Reachable…
        expect(door?.unwrap?.({ tool: `${healthy.slug}__tool_000` })?.behavior).toBeDefined();
        // …and the two that are not are absent from the catalogue entirely,
        // rather than present and doomed.
        expect(door?.unwrap?.({ tool: `${broken.slug}__tool_000` })?.behavior).toBeUndefined();
        expect(door?.unwrap?.({ tool: `${stale.slug}__tool_000` })?.behavior).toBeUndefined();
        expect(resolved.unavailable.map((server) => server.name)).toEqual([
          broken.name,
          stale.name,
        ]);
      });

      it('puts a tool that arrived on a later refresh behind the door, not in a bin', async () => {
        // The case M6-BE-07 shipped as a refusal: the cache GREW after the
        // plugins were chosen, so the set the operator picked was no longer
        // the set a turn would resolve. D-106 turned that into a truncation
        // (admit in order until the budget is spent), D-110 into an overflow
        // behind the doors, and D-113 removes the question entirely: a tool
        // that arrives later is a tool the search already answers about.
        const botId = await makeBot();
        const server = await makeServer(3);
        await setPlugins(botId, [server.id]).expect(200);
        await prisma.mcpTool.create({
          data: {
            serverId: server.id,
            name: 'tool_999',
            description: 'arrived on a later refresh',
            inputSchema: { type: 'object' },
          },
        });

        const resolved = await plugins.toolsForBot(ACTOR.userId, botId);

        expect(resolved.refusals).toEqual([]);
        // …and the new tool is actually findable, which is the difference
        // between "behind a door" and "gone".
        const find = resolved.tools.find((entry) => entry.name === 'find_plugin_tools');
        const listing = await find
          ?.build({} as never)
          .execute?.({}, { toolCallId: 'c', messages: [] });
        expect(String(listing)).toContain(`${server.slug}__tool_999`);
      });

      it('is reachable from the holder a turn asks, without a restart', async () => {
        // §6/M6's acceptance criterion: "Enabling a plugin for a bot makes its
        // tools available on the very next turn without an orchestrator
        // restart." The holder is what a turn asks, so asking it BEFORE and
        // AFTER the enablement — in one booted app — is the whole claim.
        const botId = await makeBot();
        const server = await makeServer(1);
        const holder = app.get(TurnPlugins);

        expect((await holder.toolsForBot(ACTOR.userId, botId)).tools).toEqual([]);
        await setPlugins(botId, [server.id]).expect(200);

        const after = await holder.toolsForBot(ACTOR.userId, botId);
        expect(after.tools.map((t) => t.name)).toEqual(['find_plugin_tools', 'use_plugin_tool']);
        // Offered is not the same as reachable, and the acceptance criterion
        // is about the tool: the door reaches the server that was just enabled.
        const door = after.tools.find((entry) => entry.name === 'use_plugin_tool');
        expect(door?.unwrap?.({ tool: `${server.slug}__tool_000` })?.behavior).toBeDefined();
      });

      it('offers a bot nothing from another user’s server, even by id', async () => {
        const botId = await makeBot();
        const theirs = await makeServer(1, { owner: FOREIGN });
        // The link written directly, which is the only way it could exist:
        // the route 404s the id. This is the second fence, at read time.
        await prisma.botMcpServer.create({
          data: { botId, serverId: theirs.id, enabled: true },
        });

        expect((await plugins.toolsForBot(ACTOR.userId, botId)).tools).toEqual([]);
      });
    });
  },
);
