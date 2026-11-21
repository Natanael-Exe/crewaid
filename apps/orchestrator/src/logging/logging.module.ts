import { Global, Module } from '@nestjs/common';
import { StructuredLogger } from './structured-logger.js';

@Global()
@Module({
  providers: [{ provide: StructuredLogger, useFactory: () => new StructuredLogger() }],
  exports: [StructuredLogger],
})
export class LoggingModule {}
