#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(desktopDir, '..', '..', 'packages', 'connector-cli', 'dist', 'desktop-worker.cjs');
const destDir = path.join(desktopDir, 'dist');
const dest = path.join(destDir, 'localConnectorWorker.cjs');

if (!existsSync(source)) {
  console.error(
    `Missing connector desktop worker bundle at ${source}. Run \`pnpm --filter crewaid-connect build\` first.`,
  );
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);
