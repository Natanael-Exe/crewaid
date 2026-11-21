import { createInterface } from 'node:readline';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, resetPassword } from '../auth/password-reset.js';
import { readEdition } from '../common/edition.config.js';
import { createPrismaClient } from '../prisma/prisma-client.factory.js';

/**
 * Set a new password for an account on a self-hosted server.
 *
 * docker compose exec orchestrator node apps/orchestrator/dist/cli/reset-password.js <email>
 * (or `npx crewaid-selfhost reset-password <email>`, which runs exactly that)
 *
 * A self-hosted server has no mail service, so "forgot password" has no email
 * to send; whoever runs the server resets it here instead. The password is
 * read from standard input — typed twice at a terminal, or one line piped —
 * and never from the command line, where it would land in shell history and
 * the process list. The work is `resetPassword` in `auth/password-reset.ts`.
 */
async function main(): Promise<number> {
  const email = (process.argv[2] ?? '').trim();
  if (email === '') {
    process.stderr.write('usage: reset-password <email>   (the new password is read from stdin)\n');
    return 2;
  }
  if (readEdition(process.env) !== 'selfhosted') {
    process.stderr.write(
      'This server is not self-hosted: its accounts sign in with Google, GitHub or a magic link.\n',
    );
    return 2;
  }

  const password = await readNewPassword();
  if (password === null) {
    process.stderr.write('The two passwords differ.\n');
    return 1;
  }

  const prisma = createPrismaClient();
  try {
    const result = await resetPassword(prisma, email, password);
    switch (result.status) {
      case 'invalid-password':
        process.stderr.write(
          `The password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.\n`,
        );
        return 1;
      case 'no-account':
        process.stderr.write(`No account uses ${email}.\n`);
        return 1;
      case 'changed':
        process.stdout.write(
          `Password changed for ${email}; ${String(result.sessionsEnded)} signed-in session(s) ended.\n`,
        );
        return 0;
    }
  } finally {
    await prisma.$disconnect();
  }
}

/** Typed twice, unechoed, at a terminal; the first line otherwise. Null when the two differ. */
async function readNewPassword(): Promise<string | null> {
  if (!process.stdin.isTTY) {
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
      lines.close();
      return line;
    }
    return '';
  }
  const first = await ask('New password: ');
  const second = await ask('Again: ');
  return first === second ? first : null;
}

/** A prompt whose answer is not echoed: the password must not appear on screen. */
function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let answer = '';
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(answer);
          return;
        }
        if (char === '\u0003') process.exit(130); // Ctrl+C
        answer = char === '\u007f' ? answer.slice(0, -1) : answer + char;
      }
    };
    stdin.on('data', onData);
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `reset-password failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
