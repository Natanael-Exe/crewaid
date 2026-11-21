import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { BotsController } from '../src/bots/bots.controller.js';
import { BotsService } from '../src/bots/bots.service.js';
import { MessagesController } from '../src/messages/messages.controller.js';
import { MessagesService } from '../src/messages/messages.service.js';
import { AttachmentsController } from '../src/attachments/attachments.controller.js';
import { AttachmentsService } from '../src/attachments/attachments.service.js';
import { StructuredLogger } from '../src/logging/structured-logger.js';

/**
 * tsx executes source through esbuild and does not emit TypeScript's
 * design:paramtypes metadata. Controllers therefore need explicit Nest
 * injection metadata, not only a typed constructor parameter.
 */
describe('controller runtime DI', () => {
  it('resolves every service-backed controller without design:paramtypes', async () => {
    const entries = [
      [BotsController, [{ index: 0, param: BotsService }]],
      [MessagesController, [{ index: 0, param: MessagesService }]],
      [AttachmentsController, [{ index: 0, param: AttachmentsService }]],
    ] as const;
    const originalMetadata = entries.map(([controller]) => ({
      controller,
      value: Reflect.getOwnMetadata('design:paramtypes', controller),
    }));

    // Simulate tsx/esbuild, which does not emit design:paramtypes metadata.
    for (const [controller, expectedDeps] of entries) {
      Reflect.deleteMetadata('design:paramtypes', controller);
      expect(Reflect.getMetadata('design:paramtypes', controller)).toBeUndefined();

      const deps = Reflect.getMetadata('self:paramtypes', controller) as
        Array<{ index: number; param: unknown }> | undefined;
      expect(deps?.slice().sort((a, b) => a.index - b.index)).toEqual(expectedDeps);
    }

    try {
      const moduleRef = await Test.createTestingModule({
        controllers: entries.map(([controller]) => controller),
        providers: [
          { provide: BotsService, useValue: {} },
          { provide: MessagesService, useValue: {} },
          { provide: AttachmentsService, useValue: {} },
          { provide: StructuredLogger, useValue: {} },
        ],
      }).compile();

      try {
        expect(moduleRef.get(BotsController)).toBeInstanceOf(BotsController);
        expect(moduleRef.get(MessagesController)).toBeInstanceOf(MessagesController);
        expect(moduleRef.get(AttachmentsController)).toBeInstanceOf(AttachmentsController);
      } finally {
        await moduleRef.close();
      }
    } finally {
      for (const { controller, value } of originalMetadata) {
        if (value === undefined) {
          Reflect.deleteMetadata('design:paramtypes', controller);
        } else {
          Reflect.defineMetadata('design:paramtypes', value, controller);
        }
      }
    }
  });
});
