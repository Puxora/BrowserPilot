import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const packageFile = fileURLToPath(new URL('../package.json', import.meta.url));
const packageMetadata = JSON.parse(readFileSync(packageFile, 'utf8'));

export function createRuntimeInfo(moduleUrl, entryFile = process.argv[1]) {
  return {
    packageName: packageMetadata.name,
    packageVersion: packageMetadata.version,
    sourceRoot: dirname(packageFile),
    entryFile: entryFile ? resolve(entryFile) : null,
    moduleFile: fileURLToPath(moduleUrl),
    cwd: process.cwd(),
    pid: process.pid,
    nodeExecutable: process.execPath,
  };
}
