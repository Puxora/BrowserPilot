import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageJson = await readJson(new URL('../package.json', import.meta.url));
const packageLock = await readJson(new URL('../package-lock.json', import.meta.url));
const extensionManifest = await readJson(new URL('../../chrome-extension/manifest.json', import.meta.url));
const pluginManifest = await readJson(new URL('../../.codex-plugin/plugin.json', import.meta.url));
const webUiSource = await readFile(new URL('../web-ui/index.html', import.meta.url), 'utf8');
const mcpAdapterSource = await readFile(new URL('../mcp-adapter.js', import.meta.url), 'utf8');
const wsServerSource = await readFile(new URL('../src/ws-server.js', import.meta.url), 'utf8');

test('published metadata uses the Puxora identity', () => {
  assert.equal(packageJson.name, '@puxora/browserpilot');
  assert.equal(packageJson.author, 'Puxora');
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.repository.url, 'git+https://github.com/Puxora/BrowserPilot.git');
  assert.equal(packageJson.bugs.url, 'https://github.com/Puxora/BrowserPilot/issues');
});

test('package, extension, and Codex plugin versions stay aligned', () => {
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.equal(extensionManifest.version, packageJson.version);
  assert.equal(pluginManifest.version, packageJson.version);
  assert.equal(pluginManifest.license, packageJson.license);
  assert.match(webUiSource, new RegExp(`monitor-version">v${escapeRegExp(packageJson.version)}<`));
  assert.match(
    mcpAdapterSource,
    new RegExp(`serverInfo: \\{ name: 'browser-pilot', version: '${escapeRegExp(packageJson.version)}' \\}`)
  );
  assert.match(
    wsServerSource,
    new RegExp(`payload: \\{ version: '${escapeRegExp(packageJson.version)}' \\}`)
  );
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
