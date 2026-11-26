import { runCli } from './cli.js';

try {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}
