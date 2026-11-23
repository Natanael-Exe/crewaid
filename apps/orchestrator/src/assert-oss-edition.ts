/**
 * Refuses to boot the AGPL entrypoint as the cloud edition (D-238).
 *
 * The cloud edition's billing, metering and allowances live in `ee/` and boot
 * only from `ee/main.ts`. Without this, `dist/main.js` with
 * `CREWAID_EDITION=cloud` would start a server that offers cloud sign-in but
 * none of the plans that pay for it, and every account would be unlimited.
 *
 * No imports, and imported first by `main.ts`: the auth instance is built when
 * its module is imported and throws on any missing variable, and the operator
 * should learn which entrypoint to run before learning which variable is unset.
 */
if ((process.env['CREWAID_EDITION'] ?? '').trim() === 'cloud') {
  process.stderr.write(
    'CREWAID_EDITION=cloud runs from the Enterprise entrypoint, dist/ee/main.js (D-238). ' +
      'This entrypoint, dist/main.js, is the self-hosted edition. If you built from source ' +
      'without apps/orchestrator/src/ee, set CREWAID_EDITION=selfhosted.\n',
  );
  process.exit(1);
}

export {};
