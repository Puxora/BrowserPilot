import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function safeEquals(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export class ApiTokenStore {
  constructor(config) {
    this.path = config.tokenStorePath;
    this.localToken = config.apiToken;
  }

  async create(name = 'external-mcp') {
    const label = String(name).trim().slice(0, 80);
    if (!label) throw new Error('令牌名称不能为空');
    const token = `bp_${randomBytes(32).toString('base64url')}`;
    const entry = {
      id: randomUUID(),
      name: label,
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString()
    };
    const entries = await this._read();
    entries.push(entry);
    await this._write(entries);
    return { ...entry, token };
  }

  async list() {
    return (await this._read()).map(({ tokenHash, ...entry }) => entry);
  }

  async revoke(id) {
    const entries = await this._read();
    const next = entries.filter(entry => entry.id !== id);
    if (next.length === entries.length) return false;
    await this._write(next);
    return true;
  }

  async verify(token) {
    if (!token) return false;
    if (this.localToken && safeEquals(token, this.localToken)) return true;
    const tokenHash = hashToken(token);
    return (await this._read()).some(entry => safeEquals(entry.tokenHash, tokenHash));
  }

  async _read() {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      return Array.isArray(parsed?.tokens) ? parsed.tokens.filter(isValidEntry) : [];
    } catch {
      throw new Error('Token 库无法读取，请检查 tokens.json 格式');
    }
  }

  async _write(entries) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify({ version: 1, tokens: entries }, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600
    });
    await chmod(this.path, 0o600).catch(() => {});
  }
}

function isValidEntry(entry) {
  return entry && typeof entry === 'object' &&
    typeof entry.id === 'string' && typeof entry.name === 'string' &&
    /^[a-f0-9]{64}$/i.test(entry.tokenHash) && typeof entry.createdAt === 'string';
}
