#!/usr/bin/env node
// MCP 工具发现验收脚本
// 仅验证 mcp-adapter.js 能否正常启动、tools/list 是否返回预期工具。
// 不依赖 daemon 与 Chrome 连接 —— 它只测 MCP 工具发现，不发 tools/call。
//
// 用法: node orchestrator/scripts/check-mcp-tools.js
// 缺少必需工具时退出码非 0。

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADAPTER_PATH = join(__dirname, '..', 'mcp-adapter.js');

// 计划第 8 节“必需工具清单”：本轮完成后至少包含以下工具。
const REQUIRED_TOOLS = [
  'browser_wait_for_selector',
  'browser_close_tab',
  'browser_go_forward',
  'browser_create_tab',
  'browser_get_visible_dom',
  'browser_click_node',
  'browser_type_node',
  'browser_visual_start',
  'browser_finalize_tabs',
  'system_status',
];

// 启动 adapter 子进程，完成 initialize 握手后请求 tools/list。
// 解析按行分隔的 JSON-RPC 响应，返回工具名数组。
function discoverTools() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ADAPTER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('验收超时：未在 10s 内完成 tools/list'));
    }, 10000);

    const onLine = (line) => {
      const text = line.trim();
      if (!text) return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return; // 非 JSON 行忽略
      }
      // 只处理带 id 的响应（initialize / tools/list 的回应）
      if (msg.id === 1 && msg.result) {
        // initialize 响应到位，紧接着发 tools/list
        child.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}
        }) + '\n');
        return;
      }
      if (msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
        settled = true;
        clearTimeout(timer);
        child.stdin.end();
        child.kill();
        resolve(msg.result.tools.map(t => t.name).filter(Boolean));
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        onLine(stdoutBuf.slice(0, nl));
        stdoutBuf = stdoutBuf.slice(nl + 1);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderrBuf += chunk; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('启动 mcp-adapter 失败: ' + err.message));
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`mcp-adapter 提前退出，code=${code}${stderrBuf ? '\nstderr: ' + stderrBuf.trim() : ''}`));
    });

    // 先发 initialize
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'check-mcp-tools', version: '1.0.0' }
      }
    }) + '\n');
  });
}

async function main() {
  const tools = await discoverTools();
  const toolSet = new Set(tools);

  console.log(`MCP 工具发现成功，共 ${tools.length} 个工具：`);
  for (const name of tools) {
    console.log(`  - ${name}`);
  }

  const missing = REQUIRED_TOOLS.filter(name => !toolSet.has(name));
  if (missing.length > 0) {
    console.error(`\n❌ 缺少必需工具 ${missing.length} 个：`);
    for (const name of missing) {
      console.error(`  - ${name}`);
    }
    process.exit(1);
  }

  console.log(`\n✅ 必需工具校验通过（${REQUIRED_TOOLS.length}/${REQUIRED_TOOLS.length}）`);
}

main().catch((err) => {
  console.error('❌ 验收失败: ' + err.message);
  process.exit(1);
});
