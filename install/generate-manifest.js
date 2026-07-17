#!/usr/bin/env node
// 安装期：生成 Native Messaging manifest
// 用法: node install/generate-manifest.js <EXTENSION_ID> [NODE_EXE] [RELAY_JS] [MANIFEST_DIR]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const HOME = process.env.LOCALAPPDATA || process.env.APPDATA;

const extId     = args[0] || '';
const nodeExe   = args[1] || process.execPath;                 // 默认当前 node
const relayJs   = args[2] || path.join(process.cwd(), '..', 'orchestrator', 'native-relay.js');
const manifestDir = args[3] || path.join(HOME, 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts');

if (!extId || !/^[a-p]{32}$/.test(extId)) {
  console.error('[错误] 扩展 ID 无效（需 32 位 a-p 小写字母）:', extId);
  process.exit(1);
}
if (!fs.existsSync(nodeExe))   { console.error('[错误] node.exe 不存在:', nodeExe); process.exit(1); }
if (!fs.existsSync(relayJs))   { console.error('[错误] native-relay.js 不存在:', relayJs); process.exit(1); }

if (!fs.existsSync(manifestDir)) fs.mkdirSync(manifestDir, { recursive: true });

const hostName = 'com.browserpilot.bridge';
const relayDir = path.dirname(relayJs);
const launcherPath = path.join(relayDir, 'native-relay-host.exe');
const launcherSourcePath = path.join(relayDir, 'native-relay-host.cs');
const launcherConfigPath = path.join(relayDir, 'native-relay-host.config');

fs.writeFileSync(launcherConfigPath, [nodeExe, relayJs, ''].join('\r\n'), 'utf8');

if (!fs.existsSync(launcherPath)) {
  const cscExe = findCsc();
  if (!cscExe) {
    console.error('[错误] 未找到 csc.exe，无法编译 native-relay-host.exe');
    process.exit(1);
  }
  const result = spawnSync(cscExe, [
    '/nologo',
    '/target:exe',
    `/out:${launcherPath}`,
    launcherSourcePath
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error('[错误] native-relay-host.exe 编译失败');
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
    process.exit(result.status || 1);
  }
}

const manifest = {
  name: hostName,
  description: 'BrowserPilot Native Messaging Bridge - relays browser commands to the orchestrator daemon',
  path: launcherPath,
  type: 'stdio',
  allowed_origins: ['chrome-extension://' + extId + '/']
};

let json = JSON.stringify(manifest, null, 2);
json = json.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

const outPath = path.join(manifestDir, hostName + '.json');
fs.writeFileSync(outPath, json, 'latin1'); // 纯 ASCII、无 BOM、CRLF

const m = JSON.parse(fs.readFileSync(outPath, 'utf8'));
console.log('manifest 已生成:', outPath);
console.log('  path  =', m.path, '| 存在 =', fs.existsSync(m.path));
console.log('  relay =', relayJs, '| 存在 =', fs.existsSync(relayJs));
console.log('  origin=', m.allowed_origins[0]);

function findCsc() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v3.5', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v3.5', 'csc.exe')
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}
