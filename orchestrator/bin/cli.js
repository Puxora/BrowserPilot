#!/usr/bin/env node

import fs from 'fs/promises';
import { existsSync, openSync, closeSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { execFileSync, execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import net from 'net';
import config, { isLoopbackHost } from '../src/config.js';
import { ApiTokenStore } from '../src/token-store.js';
import { uninstallNativeMessagingHost } from '../src/native-host-uninstall.js';
import packageJson from '../package.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const BROWSERPILOT_DIR = path.join(HOME, '.browserpilot');
const PID_FILE = path.join(BROWSERPILOT_DIR, 'daemon.pid');
const STATE_FILE = path.join(BROWSERPILOT_DIR, 'daemon.json');
const DEFAULT_LOG_FILE = path.join(BROWSERPILOT_DIR, 'logs', 'daemon.log');

function isPortReachable(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 1500 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

function getArgValue(args, name, fallback = undefined) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

function normalizeApiUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function printVersion() {
  console.log(`BrowserPilot ${packageJson.version}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDaemonOptions(args) {
  const port = parseInt(getArgValue(args, '--port', process.env.CA_WEB_PORT || '9876'), 10);
  const wsPort = parseInt(getArgValue(args, '--ws-port', process.env.CA_WS_PORT || String(port + 1)), 10);
  const listenHost = getArgValue(args, '--listen-host',
    getArgValue(args, '--host', process.env.CA_WEB_HOST || '127.0.0.1'));
  const foreground = args.includes('--foreground');

  if (!Number.isInteger(port) || port <= 0) throw new Error('请提供有效的 --port');
  if (!Number.isInteger(wsPort) || wsPort <= 0) throw new Error('请提供有效的 --ws-port');

  return { port, wsPort, listenHost, foreground };
}

async function ensureDaemonRuntimeDirs() {
  await fs.mkdir(path.dirname(PID_FILE), { recursive: true });
  await fs.mkdir(path.dirname(DEFAULT_LOG_FILE), { recursive: true });
}

async function readPidFile() {
  try {
    const raw = await fs.readFile(PID_FILE, 'utf8');
    const pid = parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function removeDaemonState() {
  await fs.rm(PID_FILE, { force: true }).catch(() => {});
  await fs.rm(STATE_FILE, { force: true }).catch(() => {});
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function getProcessCommandLine(pid) {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function isBrowserPilotDaemonProcess(pid) {
  const commandLine = getProcessCommandLine(pid);
  if (!commandLine) return false;
  const normalized = commandLine.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('daemon-run')
    && (normalized.includes('browserpilot') || normalized.includes('/bin/cli.js'));
}

async function getDaemonState() {
  const pid = await readPidFile();
  if (!pid) return { pid: null, running: false, stale: false };

  const running = isProcessRunning(pid);
  if (!running || !isBrowserPilotDaemonProcess(pid)) {
    await removeDaemonState();
    return { pid, running: false, stale: true };
  }

  let metadata = {};
  try {
    metadata = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    metadata = {};
  }

  return { pid, running: true, stale: false, metadata };
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await sleep(150);
  }
  return !isProcessRunning(pid);
}

async function readRecentLog(file, maxBytes = 4000) {
  try {
    const stat = await fs.stat(file);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString('utf8').trim();
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

function resolveExtensionDir(packageRoot) {
  const candidates = [
    path.join(packageRoot, 'chrome-extension'),
    path.join(packageRoot, '..', 'chrome-extension')
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function printHelp() {
  console.log('BrowserPilot CLI');
  console.log('用法:');
  console.log('  browserpilot install');
  console.log('      注册 Chrome Native Messaging Host');
  console.log('');
  console.log('  browserpilot uninstall [--purge]');
  console.log('      清理 Chrome Native Messaging Host 与桥接文件；--purge 同时删除本地数据');
  console.log('');
  console.log('  browserpilot --version | -v | version');
  console.log('      输出当前 CLI 版本');
  console.log('');
  console.log('  browserpilot start [--listen-host <ip>] [--port <port>] [--foreground]');
  console.log('  browserpilot stop');
  console.log('  browserpilot restart [--listen-host <ip>] [--port <port>]');
  console.log('  browserpilot status');
  console.log('  browserpilot daemon <start|stop|restart|status>');
  console.log('      管理 Daemon 服务、Web UI 与调度器；start 默认后台运行');
  console.log('');
  console.log('  browserpilot mcp [--daemon-api <url>]');
  console.log('  browserpilot mcp [--host <ip>] [--port <port>]');
  console.log('      作为 MCP 服务器运行 (stdio)，默认连接 http://127.0.0.1:9876/api');
  console.log('');
  console.log('  browserpilot mcp config --client openclaw --wsl');
  console.log('      输出 WSL/OpenClaw 可用的 MCP 配置示例');
  console.log('');
  console.log('  browserpilot token create --name <名称>');
  console.log('  browserpilot token list');
  console.log('  browserpilot token revoke --id <令牌ID>');
  console.log('      管理可撤销的远程 MCP API Token');
}

function detectWslGateway() {
  try {
    const route = execSync('ip route show default', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const match = route.match(/\bdefault\s+via\s+(\S+)/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function printMcpConfig(args) {
  const client = getArgValue(args, '--client', 'openclaw');
  const wsl = args.includes('--wsl');
  const explicitApi = getArgValue(args, '--daemon-api');
  const token = getArgValue(args, '--token');
  const daemonApi = normalizeApiUrl(explicitApi || (
    wsl ? `http://${detectWslGateway() || '<windows-host-ip>'}:9876/api` : 'http://127.0.0.1:9876/api'
  ));

  if (client !== 'openclaw') {
    console.warn(`[Warning] 未知 client: ${client}，仍输出通用 MCP 配置`);
  }

  const config = {
    mcpServers: {
      browserpilot: {
        command: 'npx',
        args: ['-y', 'browserpilot', 'mcp', '--daemon-api', daemonApi],
        ...(token ? { env: { CA_API_TOKEN: token } } : {})
      }
    }
  };
  console.log(JSON.stringify(config, null, 2));
}

async function runTokenCommand(args) {
  const store = new ApiTokenStore(config);
  const subcommand = args[0];
  if (subcommand === 'create') {
    const token = await store.create(getArgValue(args, '--name', 'external-mcp'));
    console.log('Token 已创建。请立即保存，之后不会再次显示完整值：');
    console.log(`ID: ${token.id}`);
    console.log(`名称: ${token.name}`);
    console.log(`Token: ${token.token}`);
    return;
  }
  if (subcommand === 'list') {
    const tokens = await store.list();
    if (!tokens.length) return console.log('没有已创建的远程 MCP Token。');
    for (const token of tokens) {
      console.log(`${token.id}  ${token.name}  ${token.createdAt}`);
    }
    return;
  }
  if (subcommand === 'revoke') {
    const id = getArgValue(args, '--id');
    if (!id) throw new Error('请使用 --id 指定要撤销的 Token');
    if (!await store.revoke(id)) throw new Error('未找到指定 Token');
    console.log('Token 已撤销。');
    return;
  }
  throw new Error('Token 命令仅支持 create、list、revoke');
}

async function runDaemonForeground(args, label = '正在前台启动 Daemon...') {
  const options = parseDaemonOptions(args);
  console.log(label);
  process.env.CA_WEB_PORT = options.port.toString();
  process.env.CA_WS_PORT = options.wsPort.toString();
  process.env.CA_WEB_HOST = options.listenHost;
  await import('../src/index.js');
}

function toDaemonRunArgs(options) {
  return [
    'daemon-run',
    '--port', String(options.port),
    '--ws-port', String(options.wsPort),
    '--listen-host', options.listenHost
  ];
}

async function startDaemonBackground(args) {
  const options = parseDaemonOptions(args);
  await ensureDaemonRuntimeDirs();

  const current = await getDaemonState();
  if (current.running) {
    const webUrl = current.metadata?.webUrl || `http://${options.listenHost}:${options.port}`;
    console.log(`Daemon 已在后台运行，PID: ${current.pid}`);
    console.log(`Web UI: ${webUrl}`);
    console.log(`日志: ${current.metadata?.logFile || DEFAULT_LOG_FILE}`);
    return;
  }

  const logFile = DEFAULT_LOG_FILE;
  const logFd = openSync(logFile, 'a');
  let child;
  try {
    child = spawn(process.execPath, [path.join(__dirname, 'cli.js'), ...toDaemonRunArgs(options)], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: {
        ...process.env,
        CA_WEB_PORT: String(options.port),
        CA_WS_PORT: String(options.wsPort),
        CA_WEB_HOST: options.listenHost,
        BROWSERPILOT_DAEMON: '1'
      }
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  await fs.writeFile(PID_FILE, String(child.pid), 'utf8');
  const state = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    webHost: options.listenHost,
    webPort: options.port,
    wsPort: options.wsPort,
    webUrl: `http://${options.listenHost}:${options.port}`,
    logFile
  };
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');

  await sleep(800);
  if (!isProcessRunning(child.pid)) {
    const recentLog = await readRecentLog(logFile);
    await removeDaemonState();
    throw new Error(`Daemon 后台启动失败。${recentLog ? `\n最近日志:\n${recentLog}` : `请查看日志: ${logFile}`}`);
  }

  console.log(`Daemon 已后台启动，PID: ${child.pid}`);
  console.log(`Web UI: ${state.webUrl}`);
  console.log(`日志: ${logFile}`);
}

async function stopDaemon() {
  await ensureDaemonRuntimeDirs();
  const current = await getDaemonState();
  if (!current.running) {
    console.log(current.stale ? 'Daemon 未运行，已清理过期 PID 文件。' : 'Daemon 未运行。');
    return;
  }

  if (!isBrowserPilotDaemonProcess(current.pid)) {
    throw new Error(`拒绝停止 PID ${current.pid}：该进程看起来不是 BrowserPilot 后台 daemon。请手动检查后再处理。`);
  }

  process.kill(current.pid, 'SIGTERM');
  let stopped = await waitForProcessExit(current.pid, 5000);

  if (!stopped && process.platform === 'win32') {
    execFileSync('taskkill.exe', ['/PID', String(current.pid), '/T', '/F'], {
      stdio: ['ignore', 'ignore', 'ignore']
    });
    stopped = await waitForProcessExit(current.pid, 3000);
  }

  if (!stopped) {
    throw new Error(`Daemon 停止超时，PID: ${current.pid}`);
  }

  await removeDaemonState();
  console.log('Daemon 已停止。');
}

async function restartDaemon(args) {
  await stopDaemon();
  await startDaemonBackground(args);
}

async function printDaemonStatus() {
  await ensureDaemonRuntimeDirs();
  const current = await getDaemonState();
  if (!current.running) {
    console.log(current.stale ? 'Daemon 未运行（已清理过期 PID 文件）。' : 'Daemon 未运行。');
    return;
  }

  const metadata = current.metadata || {};
  console.log('Daemon 正在运行。');
  console.log(`PID: ${current.pid}`);
  if (metadata.webUrl) console.log(`Web UI: ${metadata.webUrl}`);
  if (metadata.wsPort) console.log(`WS 端口: ${metadata.wsPort}`);
  if (metadata.startedAt) console.log(`启动时间: ${metadata.startedAt}`);
  console.log(`日志: ${metadata.logFile || DEFAULT_LOG_FILE}`);
}

// ── 安装 Native Messaging Host ──────────
async function runInstall() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║      BrowserPilot - 注册桥接 Host        ║');
  console.log('╚══════════════════════════════════════════╝\n');
  
  const HOME = homedir();
  const bridgeDir = path.join(HOME, '.browserpilot', 'bridge');
  await fs.mkdir(bridgeDir, { recursive: true });

  const sourceDir = path.join(__dirname, '..'); // package root
  
  const filesToCopy = [
    'native-relay.js',
    'native-relay-host.cs',
    'native-relay-host.exe'
  ];

  for (const file of filesToCopy) {
    const src = path.join(sourceDir, file);
    const dest = path.join(bridgeDir, file);
    if (existsSync(src)) {
      try {
        await fs.copyFile(src, dest);
      } catch (err) {
        if (err.code === 'EBUSY') {
          console.warn(`[Warning] 桥接文件忙，跳过复制: ${file}`);
        } else {
          throw err;
        }
      }
    }
  }

  // 确保 config 正确
  const nodeExe = process.execPath;
  const packageRelayJs = path.join(sourceDir, 'native-relay.js');
  const configContent = [nodeExe, packageRelayJs, ''].join('\r\n');
  await fs.writeFile(path.join(bridgeDir, 'native-relay-host.config'), configContent, 'utf8');

  const extId = 'pmnpjmejdgnenigelhgpjjeiefabfile';
  const manifest = {
    name: 'com.browserpilot.bridge',
    description: 'BrowserPilot Native Messaging Bridge',
    path: path.join(bridgeDir, 'native-relay-host.exe'),
    type: 'stdio',
    allowed_origins: ['chrome-extension://' + extId + '/']
  };

  const manifestPath = path.join(bridgeDir, 'com.browserpilot.bridge.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[OK] 已在 ${manifestPath} 生成 Manifest 配置`);

  if (process.platform === 'win32') {
    const manifestDir = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts');
    await fs.mkdir(manifestDir, { recursive: true });
    
    const chromeManifestPath = path.join(manifestDir, 'com.browserpilot.bridge.json');
    await fs.copyFile(manifestPath, chromeManifestPath);

    const regPath = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.browserpilot.bridge';
    try {
      execSync(`reg add "${regPath}" /ve /t REG_SZ /d "${chromeManifestPath}" /f`);
      console.log('[OK] 注册表写入成功 (HKCU)');
    } catch (err) {
      console.error('[Error] 注册表写入失败，尝试以管理员权限重新运行。', err.message);
    }
  } else {
    // macOS / Linux Support
    let targetDir = '';
    if (process.platform === 'darwin') {
      targetDir = path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
    } else {
      targetDir = path.join(HOME, '.config', 'google-chrome', 'NativeMessagingHosts');
    }
    await fs.mkdir(targetDir, { recursive: true });
    const chromeManifestPath = path.join(targetDir, 'com.browserpilot.bridge.json');
    
    const shellScriptPath = path.join(bridgeDir, 'native-relay-host.sh');
    const shellContent = `#!/bin/sh\n"${nodeExe}" "${packageRelayJs}" "$@"\n`;
    await fs.writeFile(shellScriptPath, shellContent, { mode: 0o755 });
    
    manifest.path = shellScriptPath;
    await fs.writeFile(chromeManifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`[OK] 已在 ${chromeManifestPath} 注册 Native Messaging Host`);
  }

  console.log('\n✓ 安装配置完成！');
  console.log('1. 打开 Chrome, 地址栏输入 chrome://extensions 并开启"开发者模式"');
  console.log('2. 点击"加载已解压的扩展程序"，选择目录:');
  console.log(`   ${resolveExtensionDir(sourceDir)}`);
  console.log('3. 扩展加载后，ID 应为 pmnpjmejdgnenigelhgpjjeiefabfile\n');
}

async function runUninstall(args) {
  const purge = args.includes('--purge');
  const unknownArgs = args.filter((arg) => arg !== '--purge');
  if (unknownArgs.length > 0) {
    throw new Error(`不支持的 uninstall 参数: ${unknownArgs.join(' ')}`);
  }

  console.log('╔══════════════════════════════════════════╗');
  console.log('║      BrowserPilot - 卸载本地桥接         ║');
  console.log('╚══════════════════════════════════════════╝\n');

  await stopDaemon();
  const result = await uninstallNativeMessagingHost();
  const removedManifests = result.manifests.filter((item) => item.status === 'removed').length;
  const skippedManifests = result.manifests.filter((item) => item.status === 'skipped');

  console.log(`[OK] 已清理 ${removedManifests} 个 Native Messaging manifest 和桥接文件。`);
  for (const manifest of skippedManifests) {
    console.warn(`[Warning] 未删除 ${manifest.path}：文件内容不属于 BrowserPilot。`);
  }
  if (process.platform === 'win32') {
    console.log('[OK] 已尝试清理 BrowserPilot 的 Chrome 注册表项。');
  }

  if (purge) {
    await fs.rm(BROWSERPILOT_DIR, { recursive: true, force: true });
    console.log(`[OK] 已删除本地数据目录: ${BROWSERPILOT_DIR}`);
  } else {
    console.log(`本地配置、Token、任务和日志仍保留在: ${BROWSERPILOT_DIR}`);
    console.log('如需一并删除，请执行: browserpilot uninstall --purge');
  }

  console.log('\n请在 Chrome 的 chrome://extensions 页面手动移除 BrowserPilot 扩展。');
}

// ── 核心启动逻辑 ─────────────────────────
async function main() {
  const args = process.argv.slice(2);
  
  // 每次启动时，静默刷新 config 中的路径以实现自愈和正确的模块依赖解析
  try {
    const HOME = homedir();
    const bridgeDir = path.join(HOME, '.browserpilot', 'bridge');
    if (existsSync(bridgeDir)) {
      const nodeExe = process.execPath;
      const sourceDir = path.join(__dirname, '..');
      const packageRelayJs = path.join(sourceDir, 'native-relay.js');
      const configContent = [nodeExe, packageRelayJs, ''].join('\r\n');
      await fs.writeFile(path.join(bridgeDir, 'native-relay-host.config'), configContent, 'utf8');
    }
  } catch (err) {
    // 静默忽略自愈错误
  }
  
  if (args.includes('--help') || (args.includes('-h') && args.length === 1)) {
    printHelp();
    process.exit(0);
  }

  if (args.length === 1 && ['--version', '-v', 'version'].includes(args[0])) {
    printVersion();
    process.exit(0);
  }

  if (args[0] === 'install') {
    await runInstall();
    process.exit(0);
  }

  if (args[0] === 'uninstall') {
    await runUninstall(args.slice(1));
    process.exit(0);
  }

  if (args[0] === 'token') {
    await runTokenCommand(args.slice(1));
    process.exit(0);
  }

  const command = args[0] && !args[0].startsWith('-') ? args[0] : 'mcp';
  const commandArgs = command === 'mcp' ? args.slice(args[0] === 'mcp' ? 1 : 0) : args.slice(1);

  if (command === 'daemon-run') {
    await runDaemonForeground(commandArgs, '正在运行 BrowserPilot Daemon...');
    return;
  }

  if (command === 'mcp' && commandArgs[0] === 'config') {
    printMcpConfig(commandArgs.slice(1));
    process.exit(0);
  }

  const daemonCommand = command === 'daemon' ? args[1] : command;
  const daemonArgs = command === 'daemon' ? args.slice(2) : commandArgs;
  if (['start', 'stop', 'restart', 'status'].includes(daemonCommand)) {
    if (daemonCommand === 'start') {
      if (daemonArgs.includes('--foreground')) {
        await runDaemonForeground(daemonArgs);
      } else {
        await startDaemonBackground(daemonArgs);
      }
      return;
    }
    if (daemonCommand === 'stop') {
      await stopDaemon();
      return;
    }
    if (daemonCommand === 'restart') {
      await restartDaemon(daemonArgs);
      return;
    }
    if (daemonCommand === 'status') {
      await printDaemonStatus();
      return;
    }
  }

  if (command === 'daemon') {
    console.error(`未知 daemon 命令: ${args[1] || ''}`);
    printHelp();
    process.exit(1);
    return;
  }

  if (command !== 'mcp') {
    console.error(`未知命令: ${command}`);
    printHelp();
    process.exit(1);
  }

  const port = parseInt(getArgValue(commandArgs, '--port', '9876'), 10);
  const wsPort = parseInt(getArgValue(commandArgs, '--ws-port', String(port + 1)), 10);
  const daemonHost = getArgValue(commandArgs, '--daemon-host', getArgValue(commandArgs, '--host', '127.0.0.1'));
  const daemonApi = normalizeApiUrl(getArgValue(commandArgs, '--daemon-api',
    process.env.CA_DAEMON_API || `http://${daemonHost}:${port}/api`));
  const token = getArgValue(commandArgs, '--token');
  const shouldAutoStartLocalDaemon = daemonApi === `http://127.0.0.1:${port}/api` || daemonApi === `http://localhost:${port}/api`;

  // 作为 MCP stdio 运行
  // 1. 如果是 localhost，检测 daemon API 端口是否可连接。若不可连接，自动在后台拉起 Daemon。
  if (shouldAutoStartLocalDaemon) {
    const reachable = await isPortReachable(daemonHost, port);
    if (!reachable) {
      // 端口未被占用，静默在当前 Node 进程后台启动 Daemon
      process.env.CA_WEB_PORT = port.toString();
      process.env.CA_WS_PORT = wsPort.toString();
      process.env.CA_WEB_HOST = '127.0.0.1';
      
      // 确保存储目录存在
      const { mkdir } = await import('fs/promises');
      const { default: config, initializeSecrets } = await import('../src/config.js');
      await initializeSecrets();
      if (!isLoopbackHost(config.webHost) && (!process.env.CA_API_TOKEN || !config.trustedHosts.length || !config.trustedOrigins.length)) {
        throw new Error('拒绝非本机监听：必须显式设置 CA_API_TOKEN、CA_TRUSTED_HOSTS 和 CA_TRUSTED_ORIGINS');
      }
      await mkdir(config.taskDir, { recursive: true }).catch(() => {});
      await mkdir(config.logDir, { recursive: true }).catch(() => {});

      // 启动 WS + Web Server
      const { BrowserWsServer } = await import('../src/ws-server.js');
      const wsServer = new BrowserWsServer(config);
      await wsServer.start();

      const { WebUiServer } = await import('../src/web-server.js');
      const webServer = new WebUiServer(config, wsServer);
      await webServer.start();

      const { TaskScheduler } = await import('../src/scheduler.js');
      const scheduler = new TaskScheduler(config, wsServer);
      webServer.setScheduler(scheduler);
      await scheduler.start();
      
      // 将服务绑定在全局，让 mcp-adapter 直接共享通信，避免外部 HTTP 请求
      global.browserPilotWsServer = wsServer;
      global.browserPilotScheduler = scheduler;
      global.browserPilotWebServer = webServer;
    }
  }

  // 2. 载入 mcp-adapter.js 启动 stdio 通信
  process.env.CA_DAEMON_API = daemonApi;
  if (token) process.env.CA_API_TOKEN = token;
  await import('../mcp-adapter.js');
}

main().catch(err => {
  console.error('CLI 启动失败:', err);
  process.exit(1);
});
