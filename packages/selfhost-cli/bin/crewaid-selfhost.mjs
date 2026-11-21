#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(`crewaid-selfhost: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
