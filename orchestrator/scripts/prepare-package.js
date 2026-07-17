import { cp, copyFile, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const workspaceRoot = join(packageRoot, '..');

const generatedPaths = [
  join(packageRoot, 'README.md'),
  join(packageRoot, 'README.en.md'),
  join(packageRoot, 'LICENSE'),
  join(packageRoot, 'SECURITY.md'),
  join(packageRoot, 'CHANGELOG.md'),
  join(packageRoot, 'chrome-extension')
];

for (const target of generatedPaths) {
  await rm(target, { recursive: true, force: true });
}

await copyFile(join(workspaceRoot, 'README.md'), join(packageRoot, 'README.md'));
await copyFile(join(workspaceRoot, 'LICENSE'), join(packageRoot, 'LICENSE'));
await copyFile(join(workspaceRoot, 'SECURITY.md'), join(packageRoot, 'SECURITY.md'));
await copyFile(join(workspaceRoot, 'CHANGELOG.md'), join(packageRoot, 'CHANGELOG.md'));

const englishReadme = join(workspaceRoot, 'README.en.md');
if (existsSync(englishReadme)) {
  await copyFile(englishReadme, join(packageRoot, 'README.en.md'));
}

await rewritePackageReadme(join(packageRoot, 'README.md'), {
  contribution: '- 完整贡献流程与社区行为准则会随源码仓库提供。\n',
  security: '- 安全报告渠道见 [SECURITY.md](./SECURITY.md)，请勿公开披露未修复安全问题。\n',
  changelog: '- 版本变更见 [CHANGELOG.md](./CHANGELOG.md)。\n'
});
await rewritePackageReadme(join(packageRoot, 'README.en.md'), {
  contribution: '- Contribution guidance and the community code of conduct are provided with the source repository.\n',
  security: '- Report vulnerabilities through [SECURITY.md](./SECURITY.md), not public issues.\n',
  changelog: '- See [CHANGELOG.md](./CHANGELOG.md) for released changes.\n'
});

await cp(join(workspaceRoot, 'chrome-extension'), join(packageRoot, 'chrome-extension'), {
  recursive: true
});

async function rewritePackageReadme(file, replacement) {
  if (!existsSync(file)) return;
  const content = await readFile(file, 'utf8');
  const compacted = content
    .replace(/- .*CONTRIBUTING\.md.*\r?\n/, replacement.contribution)
    .replace(/- .*SECURITY\.md.*\r?\n/, replacement.security)
    .replace(/- .*CODE_OF_CONDUCT\.md.*\r?\n/, '')
    .replace(/- .*CHANGELOG\.md.*\r?\n/, replacement.changelog);
  await writeFile(file, compacted, 'utf8');
}
