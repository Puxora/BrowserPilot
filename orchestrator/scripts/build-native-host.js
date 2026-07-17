import { createHash } from 'crypto';
import { copyFile, mkdtemp, readFile, rm } from 'fs/promises';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(scriptDir, '..');
const projectPath = join(packageRoot, 'native-relay-host.csproj');
const targetPath = join(packageRoot, 'native-relay-host.exe');
const verifyOnly = process.argv.includes('--verify');
const outputDir = await mkdtemp(join(tmpdir(), 'browserpilot-native-host-'));

try {
  const result = spawnSync('dotnet', [
    'build', projectPath,
    '--configuration', 'Release',
    '--nologo',
    '--output', outputDir,
    '--property:ContinuousIntegrationBuild=true'
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  if (result.error) {
    throw new Error(`无法启动 dotnet: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Native Relay Host 构建失败:\n${result.stdout}${result.stderr}`);
  }

  const builtPath = join(outputDir, 'native-relay-host.exe');
  const builtHash = await sha256(builtPath);

  if (verifyOnly) {
    const committedHash = await sha256(targetPath);
    if (builtHash !== committedHash) {
      throw new Error(`Native Relay Host 与源码构建结果不一致：expected ${builtHash}, received ${committedHash}`);
    }
    console.log(`Native Relay Host 可复现构建校验通过：${builtHash}`);
  } else {
    await copyFile(builtPath, targetPath);
    console.log(`Native Relay Host 已由源码生成：${builtHash}`);
  }
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

async function sha256(file) {
  const content = await readFile(file);
  return createHash('sha256').update(content).digest('hex');
}
