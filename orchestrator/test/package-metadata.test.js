import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageJson = await readJson(new URL('../package.json', import.meta.url));
const extensionManifest = await readJson(new URL('../../chrome-extension/manifest.json', import.meta.url));
const pluginManifest = await readJson(new URL('../../.codex-plugin/plugin.json', import.meta.url));

test('published metadata uses the Puxora identity', () => {
  assert.equal(packageJson.name, '@puxora/browserpilot');
  assert.equal(packageJson.author, 'Puxora');
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.repository.url, 'git+https://github.com/Puxora/BrowserPilot.git');
  assert.equal(packageJson.bugs.url, 'https://github.com/Puxora/BrowserPilot/issues');
});

test('package, extension, and Codex plugin versions stay aligned', () => {
  assert.equal(extensionManifest.version, packageJson.version);
  assert.equal(pluginManifest.version, packageJson.version);
  assert.equal(pluginManifest.license, packageJson.license);
});

test('CLI reports the package version', () => {
  const cliPath = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cliPath, '--version'], {
    encoding: 'utf8',
    timeout: 10_000
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `BrowserPilot ${packageJson.version}`);
});

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}
