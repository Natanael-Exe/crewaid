import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module.js';
import { NEST_APP_OPTIONS } from '../src/bootstrap.js';
import { ToolRegistry } from '../src/agent/tool-registry.js';
import { NO_PLUGIN_TOOLS, TurnPlugins } from '../src/agent/turn-plugins.js';
import { createPrismaClient } from '../src/prisma/prisma-client.factory.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { CrewaidWsAdapter } from '../src/ws/crewaid-ws.adapter.js';
import { signIn, signOutAndDelete } from './auth-fixture.js';

const DATABASE_URL = process.env['DATABASE_URL'];

class DuplicateRouteControllerA {
  getA(): { ok: boolean } {
    return { ok: true };
  }
}

class DuplicateRouteControllerB {
  getB(): { ok: boolean } {
    return { ok: true };
  }
}

class DuplicateRouteModule {}

// Vitest transforms test/ without legacy decorator syntax, so apply Nest's
// standard metadata decorators directly as functions.
Controller('dup')(DuplicateRouteControllerA);
const descA = Object.getOwnPropertyDescriptor(DuplicateRouteControllerA.prototype, 'getA');
if (descA !== undefined) {
  Get()(DuplicateRouteControllerA.prototype, 'getA', descA);
}

Controller('dup')(DuplicateRouteControllerB);
const descB = Object.getOwnPropertyDescriptor(DuplicateRouteControllerB.prototype, 'getB');
if (descB !== undefined) {
  Get()(DuplicateRouteControllerB.prototype, 'getB', descB);
}

Module({
  controllers: [DuplicateRouteControllerA, DuplicateRouteControllerB],
})(DuplicateRouteModule);

function waitForOpen(ws: WebSocket, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket open timeout'));
    }, timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.resume();
      reject(new Error(`Unexpected HTTP status ${String(res.statusCode)}`));
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket close timeout'));
    }, timeoutMs);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe('NEST_APP_OPTIONS routeConflictPolicy', () => {
  it('rejects duplicate routes at app.init() with RouteConflictException', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DuplicateRouteModule],
    }).compile();
    const app = moduleRef.createNestApplication(NEST_APP_OPTIONS);

    let caught: unknown;
    try {
      await app.init();
    } catch (error: unknown) {
      caught = error;
    } finally {
      await app.close();
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.constructor.name).toBe('RouteConflictException');
      expect(caught.message).toMatch(/dup/i);
    }
  });
});

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'AppModule bootstrap, lifecycle registrars, and shutdown',
  () => {
    let app: INestApplication;
    let closed = false;
    let createdUserId: string | undefined;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();
    });

    afterAll(async () => {
      if (!closed && app !== undefined) {
        await app.close();
        closed = true;
      }
      if (createdUserId !== undefined) {
        const cleanupPrisma = createPrismaClient();
        try {
          await signOutAndDelete(cleanupPrisma as unknown as PrismaService, createdUserId);
        } finally {
          await cleanupPrisma.$disconnect();
        }
      }
    });

    it('serves GET /health as 200 and returns 404 JSON for unmatched POST /health', async () => {
      const getRes = await request(app.getHttpServer()).get('/health');
      expect(getRes.status).toBe(200);

      const postRes = await request(app.getHttpServer()).post('/health');
      expect(postRes.status).toBe(404);
      expect(postRes.headers['content-type']).toMatch(/application\/json/i);
      expect(postRes.body).toMatchObject({ statusCode: 404 });
    });

    it('runs all OnModuleInit tool and turn-plugin registrars in Nest 12 hierarchy order', () => {
      const registry = app.get(ToolRegistry);
      const turnPlugins = app.get(TurnPlugins);

      expect(registry.has('run_skill')).toBe(true);
      expect(registry.has('attach_file')).toBe(true);
      expect(registry.has('send_message')).toBe(true);
      expect(registry.has('schedule_routine')).toBe(true);
      expect(registry.has('cancel_routine')).toBe(true);
      expect(registry.has('task_list')).toBe(true);
      expect(registry.has('task_create')).toBe(true);

      expect(() =>
        turnPlugins.use({ toolsForBot: () => Promise.resolve(NO_PLUGIN_TOOLS) }),
      ).toThrow('A turn plugin source is already bound; there can be only one.');
    });

    it('closes cleanly within 5s with an active authenticated WebSocket client', async () => {
      await app.listen(0);
      const address = app.getHttpServer().address() as { port: number } | null;
      expect(address).toBeTruthy();
      const port = address!.port;

      const prisma = app.get(PrismaService);
      const user = await signIn(prisma, { label: 'bootstrap-ws' });
      createdUserId = user.userId;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(user.token)}`);
      await waitForOpen(ws);
      expect(ws.readyState).toBe(WebSocket.OPEN);

      const closeWait = waitForClose(ws, 5000);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          app.close().then(() => {
            closed = true;
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('app.close() timed out after 5000ms'));
            }, 5000);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      await closeWait;
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });
  },
);
