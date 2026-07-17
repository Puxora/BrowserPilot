// BrowserPilot - 配置管理
// 所有配置集中管理，支持环境变量覆盖

import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdir, readFile, writeFile, chmod } from 'fs/promises';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

export function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(host || '').toLowerCase());
}

const config = {
  // ── 端口 ──────────────────────────────────
  /** WebSocket 端口：Native Relay ↔ Daemon */
  wsPort: parseInt(process.env.CA_WS_PORT || '9877'),

  /** HTTP 端口：Web UI + REST API */
  webPort: parseInt(process.env.CA_WEB_PORT || '9876'),

  /** HTTP 监听地址：默认只允许本机访问；WSL/容器访问需显式改为 0.0.0.0 */
  webHost: process.env.CA_WEB_HOST || '127.0.0.1',

  /** 写入 API 使用的随机令牌；启动时由 index.js 从受限文件加载或创建。 */
  apiToken: process.env.CA_API_TOKEN || null,

  /** API 令牌存放路径，供本机 MCP 适配器读取。 */
  apiTokenPath: process.env.CA_API_TOKEN_PATH || join(homedir(), '.browserpilot', 'api-token'),

  /** 供 WSL、容器和远程 MCP 客户端使用的可撤销令牌库。 */
  tokenStorePath: process.env.CA_TOKEN_STORE_PATH || join(homedir(), '.browserpilot', 'tokens.json'),

  relayToken: process.env.CA_RELAY_TOKEN || null,
  relayTokenPath: process.env.CA_RELAY_TOKEN_PATH || join(homedir(), '.browserpilot', 'relay-token'),

  /** 可额外访问 Web UI/API 的受信任 Origin，逗号分隔。 */
  trustedOrigins: (process.env.CA_TRUSTED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),

  /** 非本机监听时允许的 Host 名称或 IP，逗号分隔。 */
  trustedHosts: (process.env.CA_TRUSTED_HOSTS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean),

  // ── 存储路径 ──────────────────────────────
  /** JS 任务模块目录（*.task.mjs） */
  taskDir: process.env.CA_TASK_DIR || join(homedir(), '.browserpilot', 'tasks'),

  /** 执行日志目录 */
  logDir: process.env.CA_LOG_DIR || join(homedir(), '.browserpilot', 'logs'),

  /** 用户设置配置文件 */
  settingsPath: join(homedir(), '.browserpilot', 'settings.json'),

  /** Web UI 静态文件目录 */
  webUiDir: join(projectRoot, 'web-ui'),

  // ── Native Messaging ──────────────────────
  /** Native Host 名称（需与 manifest.json 一致） */
  nativeHostName: 'com.browserpilot.bridge',

  // ── 反检测参数 ────────────────────────────
  /** 按键间最小间隔 ms */
  typingDelayMin: parseInt(process.env.CA_TYPING_DELAY_MIN || '50'),

  /** 按键间最大间隔 ms */
  typingDelayMax: parseInt(process.env.CA_TYPING_DELAY_MAX || '150'),

  /** 操作间最小等待 ms */
  actionDelayMin: parseInt(process.env.CA_ACTION_DELAY_MIN || '500'),

  /** 操作间最大等待 ms */
  actionDelayMax: parseInt(process.env.CA_ACTION_DELAY_MAX || '3000'),

  // ── 超时与并发 ────────────────────────────
  /** 浏览器操作默认超时 ms */
  defaultTimeoutMs: parseInt(process.env.CA_DEFAULT_TIMEOUT || '30000'),

  /** MCP 控制提示条租约；客户端异常退出后自动清理 */
  visualControlLeaseMs: parseInt(process.env.CA_VISUAL_CONTROL_LEASE_MS || '30000'),

  /** 最大并发任务数 */
  maxConcurrentTasks: parseInt(process.env.CA_MAX_CONCURRENT || '3'),

  // ── 文件大小限制 ──────────────────────────
  /** 单日志文件最大行数 */
  maxLogLines: 10000,
};

async function loadOrCreateSecret(path, existingValue) {
  if (existingValue) return existingValue;
  try {
    const token = (await readFile(path, 'utf8')).trim();
    if (token) return token;
  } catch {}
  const token = randomUUID();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return token;
}

export async function initializeSecrets() {
  config.apiToken = await loadOrCreateSecret(config.apiTokenPath, config.apiToken);
  config.relayToken = await loadOrCreateSecret(config.relayTokenPath, config.relayToken);
  return config;
}

export default config;
