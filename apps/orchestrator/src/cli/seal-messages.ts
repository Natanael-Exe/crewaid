import { messageKeyring } from '../credentials/message-cipher.js';
import { sealStoredMessages } from '../messages/seal-stored-messages.js';
import { createPrismaClient } from '../prisma/prisma-client.factory.js';

/**
 * Seal every stored message under the keyring's active key.
 *
 * docker compose exec orchestrator node apps/orchestrator/dist/cli/seal-messages.js
 *
 * The orchestrator runs the same pass each time it starts, so this is for the
 * two times waiting for a restart is wrong: confirming that nothing readable
 * is left, and finishing a key rotation before the old key is taken out of
 * `CREWAID_CREDENTIAL_KEYRING`. It prints how many rows it changed; a second
 * run that prints zeros is the confirmation.
 */
async function main(): Promise<number> {
  const keyring = messageKeyring();
  if (keyring === null) {
    process.stderr.write('CREWAID_CREDENTIAL_KEYRING is not set: there is no key to seal with.\n');
    return 2;
  }
  const prisma = createPrismaClient();
  try {
    const sealed = await sealStoredMessages(prisma, keyring);
    process.stdout.write(
      `Sealed ${String(sealed.messages)} message(s) and ${String(sealed.runEvents)} run event(s) ` +
        `under key version ${String(keyring.activeVersion)}.\n`,
    );
    if (sealed.unreadable > 0) {
      process.stderr.write(
        `${String(sealed.unreadable)} row(s) could not be opened and were left as they are: ` +
          'the key they were sealed under is not in CREWAID_CREDENTIAL_KEYRING.\n',
      );
      return 1;
    }
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
