// Chrome Automation Plugin - Daemon 主入口
// 启动 WebSocket 服务器 + 调度器 + Web UI

import config, { initializeSecrets, isLoopbackHost } from './config.js';
import { BrowserWsServer } from './ws-server.js';

let wsServer = null;

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║          BrowserPilot - Daemon          ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // 解析命令行参数
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === '--stop') {
    console.log('停止 daemon...');
    process.exit(0);
  }

  // 确保存储目录存在
  await ensureDirectories();
  await initializeSecrets();

  if (!isLoopbackHost(config.webHost) && (!process.env.CA_API_TOKEN || !config.trustedHosts.length || !config.trustedOrigins.length)) {
    throw new Error('拒绝非本机监听：必须显式设置 CA_API_TOKEN、CA_TRUSTED_HOSTS 和 CA_TRUSTED_ORIGINS');
  }

  // 启动 WebSocket 服务器（接收 Native Relay 连接）
  wsServer = new BrowserWsServer(config);
  try {
    await wsServer.start();
  } catch (err) {
    console.error('✗ WebSocket 服务器启动失败:', err.message);
    console.error('  请确认端口', config.wsPort, '未被占用');
    process.exit(1);
  }

  // 启动 Web UI 服务器
  let webServer = null;
  try {
    const { WebUiServer } = await import('./web-server.js');
    webServer = new WebUiServer(config, wsServer);
    await webServer.start();
  } catch (err) {
    console.warn('⚠ Web UI 启动失败:', err.message);
    console.warn('  MCP 适配器和浏览器操作仍可正常使用');
  }

  // 启动调度器。任务策略由 WebUiServer 提供；如果 Web UI 未能启动，
  // 宁可停用自动任务，也不能让敏感步骤在没有统一审批策略时执行。
  let scheduler = null;
  if (webServer) try {
    const { TaskScheduler } = await import('./scheduler.js');
    scheduler = new TaskScheduler(config, wsServer);
    if (webServer) webServer.setScheduler(scheduler);
    await scheduler.start();

    console.log(`✓ 调度器已启动，已加载 ${scheduler.taskCount} 个任务`);
  } catch (err) {
    console.warn('⚠ 调度器启动失败:', err.message);
  } else {
    console.warn('⚠ Web UI 未启动，已禁用任务调度以保护审批策略');
  }

  // ── 输出状态 ────────────────────────────

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Daemon 已就绪');
  console.log(`  WS 端口:  ${config.wsPort}  (Native Relay 连接)`);
  console.log(`  Web UI:   http://${config.webHost}:${config.webPort}`);
  console.log(`  MCP 适配器: orchestrator/mcp-adapter.js`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('等待 Chrome 扩展连接...');
  console.log('');

  // ── 优雅退出 ────────────────────────────

  process.on('SIGINT', async () => {
    console.log('\n正在关闭 daemon...');
    if (scheduler) scheduler.stop();
    if (webServer) await webServer.stop();
    if (wsServer) wsServer.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    if (scheduler) scheduler.stop();
    if (webServer) await webServer.stop();
    if (wsServer) wsServer.stop();
    process.exit(0);
  });
}

async function ensureDirectories() {
  const { mkdir } = await import('fs/promises');
  await mkdir(config.taskDir, { recursive: true }).catch(() => {});
  await mkdir(config.logDir, { recursive: true }).catch(() => {});
}

main().catch(err => {
  console.error('Daemon 启动失败:', err);
  process.exit(1);
});

export { wsServer };
