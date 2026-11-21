/**
 * Read-only replay of the skill compiler's model call for one recording.
 *
 * Calls `SkillCompileService.compile` — which reads the trace, builds the
 * exact prompt and model request the job would, and returns the validated
 * skill — WITHOUT persisting anything. Used to see the provider's raw failure
 * (`refuseModelFailure` logs it) rather than the normalized sentence on the
 * row.
 *
 * Usage:
 *   DATABASE_URL=… CREWAID_CREDENTIAL_KEYRING=… tsx diagnose-teaching-compile.ts <recordingId>
 */
import 'reflect-metadata';

import { PrismaService } from '../src/prisma/prisma.service.ts';
import { TurnEventBus } from '../src/agent/turn-event.bus.ts';
import { CredentialService } from '../src/credentials/credential.service.ts';
import { ModelResolutionService } from '../src/models/model-resolution.service.ts';
import { SkillCompileService } from '../src/skills/skill-compile.service.ts';

async function main(): Promise<void> {
  const recordingId = process.argv[2];
  if (recordingId === undefined)
    throw new Error('usage: tsx diagnose-teaching-compile.ts <recordingId>');
  const prisma = new PrismaService();
  try {
    await prisma.$connect();
    const recording = await prisma.recording.findUniqueOrThrow({
      where: { id: recordingId },
      include: { bot: { select: { modelId: true, userId: true } } },
    });
    const models = new ModelResolutionService(prisma, new CredentialService(prisma));
    const service = new SkillCompileService(prisma, new TurnEventBus(), models);
    const started = Date.now();
    const compiled = await (
      service as unknown as {
        compile: (id: string, botId: string, intent: string | null, o: unknown) => Promise<unknown>;
      }
    ).compile(recordingId, recording.botId, recording.intent, {
      userId: recording.bot.userId,
      modelId: recording.bot.modelId,
      warning: recording.warning,
    });
    console.log(JSON.stringify({ ok: true, seconds: (Date.now() - started) / 1000, compiled }));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.log(
    JSON.stringify({
      ok: false,
      name: error instanceof Error ? error.name : undefined,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
