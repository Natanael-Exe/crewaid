import { _electron as electron, type ElectronApplication } from '@playwright/test';
import electronExecutable from 'electron';
import { fileURLToPath } from 'node:url';

const DESKTOP_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Launch the packaged renderer against a throwaway profile.
 *
 * Shared rather than copied because the Linux branch is the part that is easy
 * to leave out and impossible to notice locally: a headless runner has no
 * Secret Service, so `safeStorage` refuses, the CC-07 store correctly answers
 * ENCRYPTION_UNAVAILABLE, and every test that stores credentials fails on a
 * machine no contributor is sitting at. A second copy of this function did
 * exactly that.
 */
export async function launchDesktop(
  profileDir: string,
  env: Readonly<Record<string, string>> = {},
): Promise<ElectronApplication> {
  const args = [
    ...(process.platform === 'linux' ? ['--no-sandbox', '--password-store=basic'] : []),
    `--user-data-dir=${profileDir}`,
    '.',
  ];

  const app = await electron.launch({
    executablePath: electronExecutable as unknown as string,
    args,
    cwd: DESKTOP_ROOT,
    // Server edition settings must not turn these configurable test clients
    // into a hosted build with a missing or pinned production address.
    env: { ...process.env, CREWAID_EDITION: 'selfhosted', ELECTRON_START_URL: '', ...env },
  });

  if (process.platform === 'linux') {
    const storageMode = await app.evaluate(({ safeStorage }) => {
      if (safeStorage.isEncryptionAvailable()) return 'native';

      // Headless Linux runners have no Secret Service. Electron provides this
      // fallback specifically for that environment; tokenStore still calls
      // safeStorage and writes ciphertext, and the temporary profile is
      // deleted after the test. A real desktop keyring remains preferred.
      safeStorage.setUsePlainTextEncryption(true);
      return safeStorage.isEncryptionAvailable() ? 'test-fallback' : 'unavailable';
    });
    if (storageMode === 'unavailable') {
      await app.close();
      throw new Error(
        'Electron safeStorage remained unavailable after enabling its Linux fallback',
      );
    }

    // The renderer may have attempted its first credential read before the
    // test enabled the fallback. Reload after setup so every assertion begins
    // at the same application boundary.
    const page = await app.firstWindow();
    await page.reload();
  }

  return app;
}
