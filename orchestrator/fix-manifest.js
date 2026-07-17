#!/usr/bin/env node
// 重写 Native Messaging manifest：纯 ASCII、CRLF 行尾、无 BOM、2 空格缩进
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = process.env.LOCALAPPDATA || process.env.APPDATA;
const manifestDir = path.join(HOME, 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts');
if (!fs.existsSync(manifestDir)) fs.mkdirSync(manifestDir, { recursive: true });

const hostName = 'com.browserpilot.bridge';
const extId = process.argv[2] || 'nlfkbefhagchnapgcamcjmalacmplkhc';
const nodeExe = process.argv[3] || 'D:\\Software\\nodejs\\node.exe';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const relayScript = path.resolve(__dirname, 'native-relay.js');
const relayDir = path.dirname(relayScript);
const launcherPath = path.join(relayDir, 'native-relay-host.exe');
const launcherSourcePath = path.join(relayDir, 'native-relay-host.cs');
const launcherConfigPath = path.join(relayDir, 'native-relay-host.config');

fs.writeFileSync(launcherConfigPath, [nodeExe, relayScript, ''].join('\r\n'), 'utf8');

if (!fs.existsSync(launcherPath)) {
  const cscExe = findCsc();
  if (!cscExe) {
    console.error('未找到 csc.exe，无法编译 native-relay-host.exe');
    process.exit(1);
  }
  const result = spawnSync(cscExe, [
    '/nologo',
    '/target:exe',
    `/out:${launcherPath}`,
    launcherSourcePath
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error('native-relay-host.exe 编译失败');
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
    process.exit(result.status || 1);
  }
}

// 仅使用 ASCII 字符
const manifest = {
  name: hostName,
  description: 'Chrome Automation Native Messaging Bridge - relays browser commands to the orchestrator daemon',
  path: launcherPath,
  type: 'stdio',
  allowed_origins: ['chrome-extension://' + extId + '/']
};

// 2 空格缩进产生换行，再统一为 CRLF
let json = JSON.stringify(manifest, null, 2);
json = json.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

const outPath = path.join(manifestDir, hostName + '.json');
fs.writeFileSync(outPath, json, 'latin1'); // latin1 不会引入 BOM，且内容全为 ASCII

const reb = fs.readFileSync(outPath);
console.log('已写入:', outPath);
console.log('大小:', reb.length, '字节');
console.log('首3字节:', reb.slice(0, 3).toString('hex'), '(应为 7b0d0a，无 BOM)');
console.log('末4字节:', reb.slice(-4).toString('hex'), '(应为 222c 0d0a -> 预期结尾)');
console.log('---内容---');
console.log(reb.toString('latin1'));

// 立即校验
const m = JSON.parse(fs.readFileSync(outPath, 'utf8'));
console.log('\n校验通过:');
console.log('  name =', JSON.stringify(m.name), '(', m.name.length, '字符 )');
console.log('  name === hostName =', m.name === hostName);
console.log('  path =', m.path, '| 存在 =', fs.existsSync(m.path));
console.log('  relay =', relayScript, '| 存在 =', fs.existsSync(relayScript));
console.log('  allowed_origins =', JSON.stringify(m.allowed_origins));
console.log('  type =', m.type);

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
