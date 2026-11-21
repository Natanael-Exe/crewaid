import { Module } from '@nestjs/common';
import { SeatControlModule } from './seat-control.service.js';

import { PrismaModule } from '../prisma/prisma.module.js';
import { BotsModule } from '../bots/bots.module.js';
import { SandboxModule } from '../sandbox/sandbox.module.js';
import { RecordingsModule } from '../recordings/recordings.module.js';
import { RfbUpstream } from '@crewaid/screen-stream';
import { ScreenService } from './screen.service.js';
import { RFB_UPSTREAM_FACTORY, type ScreenUpstreamFactory } from './screen-upstream.port.js';
import { SeatRfbConnector } from './seat-rfb.connector.js';
import { ScreenTicketService } from './screen-ticket.service.js';
import { ScreenGrantService } from './screen-grant.service.js';
import { ScreenGrantController } from './screen-grant.controller.js';
import { ScreenStreamHost } from './screen-stream.host.js';

/**
 * §4.3 screen transport: who watches each seat and the input they
 * send (`ScreenService`), the grants that open a stream of its pixels, and the
 * orchestrator's own stream route for computers that cannot serve one.
 *
 * Imports SandboxModule for the provider token rather than constructing a
 * second provider: two `DockerSandboxProvider` instances would each hold
 * their own dockerode client and, worse, could disagree about which container
 * a session id names.
 *
 * BotsModule supplies TurnEventBus, so a stream that dies can say so on the
 * same socket the client is already holding.
 *
 * RecordingsModule supplies the §4.3 tee. The import direction matters: the
 * recorder must not know about the screen, or the two would need a port to
 * break the cycle for a dependency that only ever runs one way.
 */
@Module({
  imports: [SeatControlModule, PrismaModule, SandboxModule, BotsModule, RecordingsModule],
  controllers: [ScreenGrantController],
  providers: [
    ScreenService,
    SeatRfbConnector,
    ScreenTicketService,
    ScreenGrantService,
    ScreenStreamHost,
    {
      provide: RFB_UPSTREAM_FACTORY,
      // No cast: RfbUpstream structurally satisfies ScreenUpstream, and the
      // annotation is what proves it still does after a change to either.
      useFactory: (): ScreenUpstreamFactory => (options) => new RfbUpstream(options),
    },
  ],
  exports: [ScreenService, ScreenStreamHost],
})
export class ScreenModule {}
