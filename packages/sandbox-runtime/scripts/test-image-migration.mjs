/** Opt-in, billed Runtime acceptance test. Only resources carrying this run's nonce are deleted. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  SdkRuntimeApi,
  RuntimeSandboxProvider,
  sandboxNameFor,
  IMAGE_LABEL,
  UPGRADE_BACKUP_ROLE,
  COMPUTER_LABEL,
} from '../dist/index.js';

if (process.argv[2] !== '--run') {
  console.error(
    'Build the package, configure the Runtime credential, then run: node scripts/test-image-migration.mjs --run [source image ref] [target image ref]',
  );
  process.exit(2);
}
const sourceRef = process.argv[3] ?? 'crewaid-sandbox:v0.0.8';
const targetRef = process.argv[4] ?? 'crewaid-sandbox:latest';
const nonce = randomUUID();
const computerId = `migration-test-${nonce}`;
const api = new SdkRuntimeApi();
const testLabel = { 'crewaid-migration-test': nonce };
const fixture = String.raw`
import os, pathlib, sqlite3
home = pathlib.Path('/home/bot/.crewaid-migration-test')
home.mkdir(exist_ok=True)
db = sqlite3.connect(str(home / 'Cookies'))
db.execute('CREATE TABLE cookies (name TEXT, value TEXT)')
db.execute('INSERT INTO cookies VALUES (?, ?)', ('session', 'synthetic-session'))
db.commit()
db.close()
os.chmod(home / 'Cookies', 0o600)
pathlib.Path('/workspace/migration-sentinel.bin').write_bytes(bytes(range(256)) * 8192)
`;
const verify = String.raw`
import os, pathlib, sqlite3, urllib.request
home = pathlib.Path('/home/bot/.crewaid-migration-test')
db = sqlite3.connect(str(home / 'Cookies'))
assert db.execute('SELECT value FROM cookies WHERE name = ?', ('session',)).fetchone()[0] == 'synthetic-session'
assert os.stat(home / 'Cookies').st_mode & 0o777 == 0o600
assert pathlib.Path('/workspace/migration-sentinel.bin').read_bytes() == bytes(range(256)) * 8192
assert pathlib.Path('/workspace/.crewaid-home/.crewaid-migration-test/Cookies').is_file()
assert urllib.request.urlopen('http://127.0.0.1:7070/health').status == 200
print('Home, SQLite profile, permissions, binary workspace and restored bridge verified')
`;
try {
  const [sourceImage, targetImage] = await Promise.all([
    api.resolveImage(sourceRef),
    api.resolveImage(targetRef),
  ]);
  assert(
    sourceImage && targetImage && sourceImage.id !== targetImage.id,
    'Two different ready images are required',
  );
  console.log('Creating a disposable source from', sourceRef);
  const source = await api.create(sandboxNameFor(computerId), {
    image: sourceImage.id,
    vcpu: 2,
    memoryMiB: 4096,
    diskMiB: 20480,
    labels: { ...testLabel, crewaid: 'migration-test', [IMAGE_LABEL]: sourceImage.id },
  });
  await api.keepWhilePaused(source.id);
  const wrote = await api.exec(source.id, ['python3', '-c', fixture]);
  assert.equal(wrote.exitCode, 0, wrote.stderr);
  await api.pause(source.id);
  console.log('Starting the disposable computer against', targetRef);
  const provider = new RuntimeSandboxProvider({
    api,
    image: targetRef,
    log: (message) => console.log(message),
  });
  const started = await provider.resumeSession({ sessionId: computerId });
  assert.notEqual(
    started.containerId,
    source.id,
    'Acceptance requires the cross-server fallback, not an in-place switch',
  );
  const restored = await api.exec(started.containerId, ['python3', '-c', verify]);
  assert.equal(restored.exitCode, 0, restored.stderr);
  console.log(restored.stdout.trim());
  assert.equal((await api.get(started.containerId)).labels[IMAGE_LABEL], targetImage.id);
  const backup = await api.get(source.id);
  assert.equal(backup.state, 'paused');
  assert.equal(backup.labels[COMPUTER_LABEL.key], UPGRADE_BACKUP_ROLE);
  const again = await provider.resumeSession({ sessionId: computerId });
  assert.equal(again.containerId, started.containerId);
  await provider.attachSession({ sessionId: computerId }).then((session) => session?.stop());
  console.log('PASS: real Runtime migration, retained backup, and repeated start');
} finally {
  for (const machine of await api.list(testLabel)) {
    assert.equal(machine.labels['crewaid-migration-test'], nonce);
    await api.delete(machine.id);
  }
  assert.equal((await api.list(testLabel)).length, 0);
  console.log('Removed this acceptance run’s disposable sandboxes');
}
