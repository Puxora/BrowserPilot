import { rm } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');

await rm(join(packageRoot, 'README.md'), { force: true });
await rm(join(packageRoot, 'README.en.md'), { force: true });
await rm(join(packageRoot, 'LICENSE'), { force: true });
await rm(join(packageRoot, 'SECURITY.md'), { force: true });
await rm(join(packageRoot, 'CHANGELOG.md'), { force: true });
await rm(join(packageRoot, 'chrome-extension'), { recursive: true, force: true });
