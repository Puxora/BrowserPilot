import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

export const NATIVE_HOST_NAMES = [
  'com.browserpilot.bridge',
  'com.chrome-automation.bridge',
  'com.chrome_automation.bridge'
];

export function getNativeMessagingHostDirectory({
  platform = process.platform,
  home = homedir(),
  localAppData = process.env.LOCALAPPDATA
} = {}) {
  if (platform === 'win32') {
    const appData = localAppData || path.join(home, 'AppData', 'Local');
    return path.join(appData, 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts');
  }

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  }

  return path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts');
}

async function removeOwnedManifest(manifestPath, hostName, filesystem) {
  let manifest;
  try {
    manifest = JSON.parse(await filesystem.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', path: manifestPath };
    return { status: 'skipped', path: manifestPath, reason: 'invalid' };
  }

  if (manifest.name !== hostName) {
    return { status: 'skipped', path: manifestPath, reason: 'unexpected-name' };
  }

  await filesystem.rm(manifestPath, { force: true });
  return { status: 'removed', path: manifestPath };
}

function removeWindowsRegistryKey(hostName, commandRunner) {
  const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
  try {
    commandRunner('reg.exe', ['delete', key, '/f'], { stdio: 'ignore', windowsHide: true });
    return { status: 'removed', key };
  } catch {
    return { status: 'missing-or-failed', key };
  }
}

export async function uninstallNativeMessagingHost({
  platform = process.platform,
  home = homedir(),
  localAppData = process.env.LOCALAPPDATA,
  filesystem = fs,
  commandRunner = execFileSync
} = {}) {
  const manifestDirectory = getNativeMessagingHostDirectory({ platform, home, localAppData });
  const manifests = [];

  for (const hostName of NATIVE_HOST_NAMES) {
    const manifestPath = path.join(manifestDirectory, `${hostName}.json`);
    manifests.push(await removeOwnedManifest(manifestPath, hostName, filesystem));
  }

  const registry = platform === 'win32'
    ? NATIVE_HOST_NAMES.map((hostName) => removeWindowsRegistryKey(hostName, commandRunner))
    : [];

  const bridgeDirectory = path.join(home, '.browserpilot', 'bridge');
  await filesystem.rm(bridgeDirectory, { recursive: true, force: true });

  return { manifestDirectory, manifests, registry, bridgeDirectory };
}
