// BrowserPilot - JS 任务模块、日志和设置存储

import { readdir, readFile, writeFile, unlink, mkdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve, relative } from 'path';
import { homedir } from 'os';
import { pathToFileURL } from 'url';
import { buildTaskTemplate, validateTaskDefinition, validateTaskId } from './task-definition.js';

const DEFAULT_SETTINGS = {
  approval: 'always',
  download: 'ask',
  upload: 'ask',
  cdpEnabled: false,
  sitePermissions: []
};

const APPROVAL_VALUES = new Set(['always', 'none']);
const TRANSFER_VALUES = new Set(['always', 'ask', 'none']);

export { validateTaskId };

export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置必须是对象');
  const allowedKeys = new Set(['approval', 'download', 'upload', 'cdpEnabled', 'sitePermissions']);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw new Error(`不支持的设置项: ${key}`);
  }
  const settings = { ...DEFAULT_SETTINGS, ...input };
  if (!APPROVAL_VALUES.has(settings.approval)) throw new Error('approval 设置无效');
  if (!TRANSFER_VALUES.has(settings.download) || !TRANSFER_VALUES.has(settings.upload)) throw new Error('下载或上传设置无效');
  if (typeof settings.cdpEnabled !== 'boolean') throw new Error('cdpEnabled 必须是布尔值');
  if (!Array.isArray(settings.sitePermissions) || settings.sitePermissions.length > 100) throw new Error('sitePermissions 设置无效');
  settings.sitePermissions = settings.sitePermissions.map(permission => {
    if (!permission || typeof permission !== 'object' || Array.isArray(permission) ||
        Object.keys(permission).some(key => key !== 'site' && key !== 'approval') ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(permission.site || '') ||
        !APPROVAL_VALUES.has(permission.approval)) {
      throw new Error('sitePermissions 包含无效规则');
    }
    return { site: permission.site.toLowerCase(), approval: permission.approval };
  });
  return settings;
}

export class TaskStore {
  constructor(config) {
    this.config = config;
    this.taskDir = config.taskDir;
    this.logDir = config.logDir;
  }

  async list() {
    await this._ensureDir();
    const files = (await readdir(this.taskDir)).filter(file => file.endsWith('.task.mjs'));
    const tasks = await Promise.all(files.map(file => this._readTaskFile(file)));
    return tasks.filter(Boolean);
  }

  async get(id) {
    const safeId = validateTaskId(id);
    const file = this._taskPath(safeId);
    if (!existsSync(file)) return null;
    return this._loadTaskModule(file, safeId);
  }

  async getSource(id) {
    const file = this._taskPath(id);
    if (!existsSync(file)) return null;
    return readFile(file, 'utf8');
  }

  async createSource(source) {
    await this._ensureDir();
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const file = this._taskPath(id);
    await writeFile(file, source, 'utf8');
    try {
      return await this._loadTaskModule(file, id);
    } catch (error) {
      await unlink(file).catch(() => {});
      throw error;
    }
  }

  async saveSource(id, source) {
    const file = this._taskPath(id);
    if (!existsSync(file)) throw new Error('任务不存在');
    const previousSource = await readFile(file, 'utf8');
    await writeFile(file, source, 'utf8');
    try {
      return await this._loadTaskModule(file, id);
    } catch (error) {
      await writeFile(file, previousSource, 'utf8');
      throw error;
    }
  }

  async setEnabled(id, enabled) {
    const file = this._taskPath(id);
    const source = await this.getSource(id);
    if (source === null) throw new Error('任务不存在');
    const nextSource = /\benabled\s*:\s*(true|false)\b/.test(source)
      ? source.replace(/\benabled\s*:\s*(true|false)\b/, `enabled: ${Boolean(enabled)}`)
      : source.replace(/export\s+default\s*\{/, `export default {\n  enabled: ${Boolean(enabled)},`);
    await writeFile(file, nextSource, 'utf8');
    try {
      return await this._loadTaskModule(file, validateTaskId(id));
    } catch (error) {
      await writeFile(file, source, 'utf8');
      throw error;
    }
  }

  async createTemplate(metadata) {
    return this.createSource(buildTaskTemplate(metadata));
  }

  async delete(id) {
    const safeId = validateTaskId(id);
    const file = this._taskPath(safeId);
    if (existsSync(file)) await unlink(file);
    const logFile = this._logPath(safeId);
    if (existsSync(logFile)) await unlink(logFile).catch(() => {});
  }

  async appendLog(taskId, entry) {
    await this._ensureDir();
    const logFile = this._logPath(taskId);
    const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() });
    await import('fs').then(fs => fs.appendFileSync(logFile, `${line}\n`, 'utf8'));
  }

  async getLogs(taskId, limit = 20) {
    const logFile = this._logPath(taskId);
    if (!existsSync(logFile)) return [];
    const content = await readFile(logFile, 'utf8');
    return content.trim().split('\n').filter(Boolean).slice(-limit)
      .map(line => { try { return JSON.parse(line); } catch { return { raw: line }; } });
  }

  async _ensureDir() {
    await mkdir(this.taskDir, { recursive: true }).catch(() => {});
    await mkdir(this.logDir, { recursive: true }).catch(() => {});
  }

  async _readTaskFile(filename) {
    const id = filename.slice(0, -'.task.mjs'.length);
    try {
      const task = await this._loadTaskModule(join(this.taskDir, filename), id);
      return { ...task, file: filename };
    } catch (error) {
      console.error(`[TaskStore] 忽略无效任务 ${filename}: ${error.message}`);
      return null;
    }
  }

  async _loadTaskModule(file, id) {
    const fileStat = await stat(file);
    const moduleUrl = `${pathToFileURL(file).href}?version=${fileStat.mtimeMs}`;
    const module = await import(moduleUrl);
    return validateTaskDefinition(module.default, id);
  }

  _taskPath(id) {
    return this._resolveInside(this.taskDir, `${validateTaskId(id)}.task.mjs`);
  }

  _logPath(id) {
    return this._resolveInside(this.logDir, `${validateTaskId(id)}.log.jsonl`);
  }

  _resolveInside(directory, filename) {
    const root = resolve(directory);
    const path = resolve(root, filename);
    const pathRelative = relative(root, path);
    if (!pathRelative || pathRelative.startsWith('..')) throw new Error('路径超出允许目录');
    return path;
  }

  async getSettings() {
    const file = this.config.settingsPath || join(homedir(), '.browserpilot', 'settings.json');
    if (!existsSync(file)) {
      await this.saveSettings(DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS };
    }
    try {
      return validateSettings(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async saveSettings(settings) {
    const file = this.config.settingsPath || join(homedir(), '.browserpilot', 'settings.json');
    await mkdir(dirname(file), { recursive: true }).catch(() => {});
    await writeFile(file, JSON.stringify(validateSettings(settings), null, 2), 'utf8');
  }
}
