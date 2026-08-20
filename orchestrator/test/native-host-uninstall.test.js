import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getNativeMessagingHostDirectory,
  uninstallNativeMessagingHost
} from '../src/native-host-uninstall.js';

test('native host uninstall removes only BrowserPilot-owned manifests and bridge files', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'browserpilot-uninstall-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const manifestDirectory = getNativeMessagingHostDirectory({ platform: 'linux', home });
  const ownedManifest = path.join(manifestDirectory, 'com.browserpilot.bridge.json');
  const foreignManifest = path.join(manifestDirectory, 'com.chrome-automation.bridge.json');
  const bridgeFile = path.join(home, '.browserpilot', 'bridge', 'native-relay-host.exe');

  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(ownedManifest, JSON.stringify({ name: 'com.browserpilot.bridge' }), 'utf8');
  await mkdir(path.dirname(bridgeFile), { recursive: true });
  await writeFile(foreignManifest, JSON.stringify({ name: 'not-browserpilot' }), 'utf8');
  await writeFile(bridgeFile, 'bridge', 'utf8');

  const result = await uninstallNativeMessagingHost({ platform: 'linux', home });

  await assert.rejects(readFile(ownedManifest, 'utf8'), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(foreignManifest, 'utf8')).name, 'not-browserpilot');
  await assert.rejects(readFile(bridgeFile, 'utf8'), { code: 'ENOENT' });
  assert.equal(result.registry.length, 0);
  assert.equal(result.manifests.find((item) => item.path === ownedManifest)?.status, 'removed');
  assert.equal(result.manifests.find((item) => item.path === foreignManifest)?.status, 'skipped');
});

test('native host directory uses the platform-specific Chrome location', () => {
  assert.equal(
    getNativeMessagingHostDirectory({ platform: 'win32', home: 'C:\\Users\\test', localAppData: 'C:\\Users\\test\\AppData\\Local' }),
    path.join('C:\\Users\\test\\AppData\\Local', 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts')
  );
  assert.equal(
    getNativeMessagingHostDirectory({ platform: 'darwin', home: '/Users/test' }),
    path.join('/Users/test', 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
  );
});
