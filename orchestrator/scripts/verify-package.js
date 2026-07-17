import { execFileSync } from 'child_process';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
const npmCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const npmArgs = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm pack --dry-run --json']
  : ['pack', '--dry-run', '--json'];

const requiredFields = [
  'name', 'version', 'description', 'license', 'author', 'homepage',
  'repository', 'bugs', 'bin', 'files', 'engines', 'publishConfig'
];
for (const field of requiredFields) {
  if (!packageJson[field]) fail(`package.json 缺少发布必需字段: ${field}`);
}

if (packageJson.private === true) fail('package.json 的 private 不能为 true');
if (packageJson.name !== '@puxora/browserpilot') fail('发布包名称必须为 @puxora/browserpilot');
if (packageJson.license !== 'MIT') fail('发布版本必须使用 MIT 协议');
if (packageJson.author !== 'Puxora') fail('发布包 author 必须为 Puxora');
if (packageJson.repository?.url !== 'git+https://github.com/Puxora/BrowserPilot.git') {
  fail('发布包 repository 必须指向 Puxora/BrowserPilot');
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
  fail(`版本号不是有效 SemVer: ${packageJson.version}`);
}
if (packageJson.publishConfig.registry !== 'https://registry.npmjs.org/') {
  fail('publishConfig.registry 必须是 npm 官方 registry');
}
if (packageJson.publishConfig.access !== 'public') {
  fail('publishConfig.access 必须是 public');
}
if (!String(packageJson.engines.node || '').startsWith('>=')) {
  fail('engines.node 必须声明最低 Node.js 版本');
}
if (packageJson.bin.browserpilot !== 'bin/cli.js') {
  fail('bin.browserpilot 必须是标准相对路径 bin/cli.js');
}

let packed;
try {
  const output = execFileSync(npmCommand, npmArgs, {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  });
  packed = JSON.parse(output)[0];
} catch (error) {
  fail(`无法生成 npm dry-run 包: ${error.message}`);
}

const files = new Set((packed.files || []).map(file => file.path));
for (const requiredFile of [
  'package.json', 'README.md', 'README.en.md', 'LICENSE', 'SECURITY.md',
  'CHANGELOG.md', 'bin/cli.js', 'chrome-extension/manifest.json',
  'native-relay.js', 'native-relay-host.cs', 'native-relay-host.csproj',
  'native-relay-host.exe', 'global.json'
]) {
  if (!files.has(requiredFile)) fail(`发布包缺少必需文件: ${requiredFile}`);
}

const forbidden = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)node_modules\//i,
  /(^|\/)native-relay-host\.config$/i,
  /(^|\/)CONTRIBUTING\.md$/i,
  /(^|\/)CODE_OF_CONDUCT\.md$/i,
  /(^|\/)scratch\//i,
  /(^|\/)[^/]+\.tgz$/i,
  /(^|\/)\.git(?:\/|$)/i
];
for (const file of files) {
  if (forbidden.some(pattern => pattern.test(file))) {
    fail(`发布包包含禁止文件: ${file}`);
  }
}

console.log(`✅ 发布包校验通过：${packageJson.name}@${packageJson.version}，${files.size} 个文件，${packed.size} bytes`);

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}
