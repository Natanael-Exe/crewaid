import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OwnershipModule } from '../src/ownership/ownership.module.js';
import { ResourceOwnershipGuard } from '../src/ownership/resource-ownership.guard.js';
import {
  OWNED_RESOURCE,
  type OwnedResourceKind,
  type OwnedResourceSpec,
} from '../src/ownership/owned-resource.decorator.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);
const USER_A = `m1_be_12_owner_a_${RUN_ID}`;
const USER_B = `m1_be_12_owner_b_${RUN_ID}`;

let app: INestApplication;
let prisma: PrismaService;
let guard: ResourceOwnershipGuard;
const ids: Record<string, string> = {};

type FamilyCase = {
  name: string;
  kind: OwnedResourceKind;
  /** The route parameter the marker names; `skillRun` sits under `:runId`. */
  param: 'id' | 'runId';
};

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M1-BE-12 — direct-by-id ownership guard (real Postgres)',
  () => {
    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [OwnershipModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      guard = app.get(ResourceOwnershipGuard);

      await prisma.user.upsert({
        where: { id: USER_A },
        create: { id: USER_A, name: 'Test User', email: `${USER_A}@test.invalid` },
        update: {},
      });
      await prisma.user.upsert({
        where: { id: USER_B },
        create: { id: USER_B, name: 'Test User', email: `${USER_B}@test.invalid` },
        update: {},
      });
      const bot = await prisma.bot.create({
        data: {
          userId: USER_A,
          name: 'M1-BE-12 owner bot',
          role: 'security test',
          avatarColor: '#123456',
          systemPrompt: 'ownership test',
        },
      });
      ids.skill = (
        await prisma.skill.create({
          data: {
            botId: bot.id,
            name: 'ownership_skill',
            description: 'ownership test',
            paramsSchema: {},
            script: 'export default async () => ({})',
          },
        })
      ).id;
      ids.skillRun = (
        await prisma.skillRun.create({ data: { skillId: ids.skill, params: {} } })
      ).id;
      ids.recording = (await prisma.recording.create({ data: { botId: bot.id } })).id;
      ids.mcpServer = (
        await prisma.mcpServer.create({
          data: {
            userId: USER_A,
            name: 'M1-BE-12 MCP',
            slug: `m1-be-12-mcp-${RUN_ID}`,
            url: 'https://mcp.example.test',
            transport: 'HTTP',
            authType: 'NONE',
          },
        })
      ).id;
      ids.routine = (
        await prisma.routine.create({
          data: { botId: bot.id, name: 'ownership routine', cron: '* * * * *' },
        })
      ).id;
      ids.attachment = (
        await prisma.attachment.create({
          data: {
            ownerId: USER_A,
            filename: 'ownership.txt',
            mimeType: 'text/plain',
            sizeBytes: 1,
            storageKey: 'm1-be-12/ownership.txt',
          },
        })
      ).id;
    });

    afterAll(async () => {
      await prisma?.user
        .deleteMany({ where: { id: { in: [USER_A, USER_B] } } })
        .catch(() => undefined);
      await app?.close();
    });

    const cases: FamilyCase[] = [
      { name: 'skill', kind: 'skill', param: 'id' },
      { name: 'skill run', kind: 'skillRun', param: 'runId' },
      { name: 'recording', kind: 'recording', param: 'id' },
      { name: 'attachment', kind: 'attachment', param: 'id' },
      { name: 'MCP server', kind: 'mcpServer', param: 'id' },
      { name: 'routine', kind: 'routine', param: 'id' },
    ];

    it.each(cases)('$name permits the owning principal', async (familyCase) => {
      await expect(guard.canActivate(contextFor(familyCase, USER_A))).resolves.toBe(true);
    });

    it.each(cases)(
      '$name denies a foreign principal without leaking existence',
      async (familyCase) => {
        // The same message a missing row produces: a distinguishable 403 would
        // confirm the id exists, which is the leak D-010 closes.
        await expect(guard.canActivate(contextFor(familyCase, USER_B))).rejects.toThrow(
          'Resource not found',
        );
      },
    );

    it.each(cases)('$name denies an id that does not exist', async (familyCase) => {
      const context = httpContext({
        handlerSpec: { kind: familyCase.kind, param: familyCase.param },
        params: { [familyCase.param]: 'no_such_resource_id' },
        userId: USER_A,
      });
      await expect(guard.canActivate(context)).rejects.toThrow('Resource not found');
    });

    it('refuses a marked route when the principal is missing', async () => {
      const context = httpContext({
        handlerSpec: { kind: 'attachment', param: 'id' },
        params: { id: ids.attachment! },
      });
      await expect(guard.canActivate(context)).rejects.toThrow('Principal required');
    });

    it.each([
      ['an absent parameter', {}],
      ['an empty parameter', { id: '' }],
    ])('refuses a marked route with %s rather than passing it through', async (_name, params) => {
      const context = httpContext({
        handlerSpec: { kind: 'attachment', param: 'id' },
        params,
        userId: USER_A,
      });
      await expect(guard.canActivate(context)).rejects.toThrow('Resource not found');
    });

    it('applies a class-level marker to a handler that has none', async () => {
      const context = httpContext({
        classSpec: { kind: 'attachment', param: 'id' },
        params: { id: ids.attachment! },
        userId: USER_B,
      });
      await expect(guard.canActivate(context)).rejects.toThrow('Resource not found');
    });

    it('lets a handler marker override the class it sits on', async () => {
      // The class says attachment, the handler says recording: the recording
      // id must be the one looked up, so USER_A owning it decides the answer.
      const context = httpContext({
        classSpec: { kind: 'attachment', param: 'id' },
        handlerSpec: { kind: 'recording', param: 'id' },
        params: { id: ids.recording! },
        userId: USER_A,
      });
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('leaves an unmarked HTTP route unchanged', async () => {
      // Fail-open by design; ownership-route-coverage.test.ts is what stops a
      // direct-by-id route from reaching this state unnoticed.
      const context = httpContext({ params: { id: ids.attachment! }, userId: USER_B });
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('leaves WS contexts unchanged', async () => {
      const context = { getType: () => 'ws' } as unknown as ExecutionContext;
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  },
);

/** Builds the request shape the guard reads: a marker plus route parameters. */
function httpContext(options: {
  handlerSpec?: OwnedResourceSpec;
  classSpec?: OwnedResourceSpec;
  params?: Record<string, string>;
  userId?: string;
}): ExecutionContext {
  const handler = (): void => undefined;
  if (options.handlerSpec !== undefined) {
    Reflect.defineMetadata(OWNED_RESOURCE, options.handlerSpec, handler);
  }
  class MarkedController {}
  if (options.classSpec !== undefined) {
    Reflect.defineMetadata(OWNED_RESOURCE, options.classSpec, MarkedController);
  }

  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => MarkedController,
    switchToHttp: () => ({
      getRequest: () => ({
        ...(options.userId === undefined
          ? {}
          : { principal: { userId: options.userId, scopes: ['*'] } }),
        params: options.params ?? {},
      }),
    }),
  } as unknown as ExecutionContext;
}

/** A marked route carrying the fixture id for that family. */
function contextFor(familyCase: FamilyCase, userId: string): ExecutionContext {
  return httpContext({
    handlerSpec: { kind: familyCase.kind, param: familyCase.param },
    params: { [familyCase.param]: ids[familyCase.kind]! },
    userId,
  });
}
