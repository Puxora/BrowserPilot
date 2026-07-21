#!/usr/bin/env node
// BrowserPilot - MCP Adapter
// stdio transport → HTTP 转发到 daemon API
// Claude Code 通过 stdio 启动此进程，实现 MCP 集成

import { readFile } from 'fs/promises';
import { request } from 'http';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';

const DAEMON_API = resolveDaemonApi();
const API_TOKEN = await resolveApiToken();
let requestId = 0;
const controller = {
  label: normalizeControllerLabel(process.env.CA_CONTROLLER_LABEL),
  sessionId: randomUUID(),
  controlledTabIds: new Set(),
};

function resolveDaemonApi() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--daemon-api');
  const fromArg = idx >= 0 ? args[idx + 1] : null;
  return normalizeDaemonApi(fromArg || process.env.CA_DAEMON_API || 'http://127.0.0.1:9876/api');
}

function normalizeDaemonApi(value) {
  return String(value || '').replace(/\/+$/, '') || 'http://127.0.0.1:9876/api';
}

function normalizeControllerLabel(value) {
  const label = String(value || '').trim().replace(/[\x00-\x1f\x7f]/g, '');
  return label.slice(0, 80) || 'BrowserPilot';
}

async function resolveApiToken() {
  if (process.env.CA_API_TOKEN) return process.env.CA_API_TOKEN;
  const path = process.env.CA_API_TOKEN_PATH || join(homedir(), '.browserpilot', 'api-token');
  try { return (await readFile(path, 'utf8')).trim(); } catch { return null; }
}

// ── MCP Tool 定义 ────────────────────────

const TOOLS = [
  {
    name: 'browser_controller_config',
    description: '配置当前 MCP 连接的全局浏览器控制标识。后续浏览器工具会自动继承该名称，并在执行前展示控制提示条和页面内模拟指针；不配置时默认 BrowserPilot',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '控制者显示名称，例如 OpenClaw；仅影响当前 MCP 连接' }
      },
      required: ['label']
    }
  },
  {
    name: 'browser_navigate',
    description: '在浏览器中导航到指定URL或查找已有标签页',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要导航到的URL地址' },
        tabId: { type: 'number', description: '可选，目标标签页ID' }
      },
      required: ['url']
    }
  },
  {
    name: 'browser_create_tab',
    description: '创建一个新的 Chrome 标签页，可选指定初始 URL。需要避免影响用户当前页面时优先使用',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '可选，新标签页 URL，默认 about:blank' }
      }
    }
  },
  {
    name: 'browser_close_tab',
    description: '关闭指定标签页。属于有副作用操作：请谨慎关闭用户页面，优先只关闭由本次任务通过 browser_create_tab 创建的标签。tabId 必填',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '必填，要关闭的标签页ID' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'browser_go_back',
    description: '让目标标签页后退一步',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '可选，目标标签页ID' }
      }
    }
  },
  {
    name: 'browser_go_forward',
    description: '让目标标签页前进一步（对应浏览器前进按钮）。无前进历史时返回友好错误',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '可选，目标标签页ID' }
      }
    }
  },
  {
    name: 'browser_reload',
    description: '刷新目标标签页并等待加载完成',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '可选，目标标签页ID' }
      }
    }
  },
  {
    name: 'browser_click',
    description: '点击页面中匹配CSS选择器的元素，模拟真实鼠标事件',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS选择器' },
        tabId: { type: 'number', description: '可选，目标标签页ID' }
      },
      required: ['selector']
    }
  },
  {
    name: 'browser_type',
    description: '在匹配选择器的输入框中逐字符输入文本，模拟人类打字速度（50-150ms/字符）',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS选择器，定位输入框' },
        text: { type: 'string', description: '要输入的文本内容' },
        tabId: { type: 'number', description: '可选' }
      },
      required: ['selector', 'text']
    }
  },
  {
    name: 'browser_scroll',
    description: '平滑滚动页面，使用 requestAnimationFrame 逐帧滚动模拟人类操作',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向' },
        distance: { type: 'number', description: '滚动距离（像素），默认500' },
        tabId: { type: 'number', description: '可选' }
      },
      required: ['direction']
    }
  },
  {
    name: 'browser_wait_for_load',
    description: '等待目标标签页达到加载完成状态，并返回当前URL和标题',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '可选，目标标签页ID' },
        timeoutMs: { type: 'number', description: '超时时间，默认30000ms' }
      }
    }
  },
  {
    name: 'browser_wait_for_navigation',
    description: '等待目标标签页URL发生变化或匹配指定URL片段',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '可选，目标标签页ID' },
        fromUrl: { type: 'string', description: '可选，当前URL；不传则自动读取' },
        urlContains: { type: 'string', description: '可选，等待URL包含该文本' },
        timeoutMs: { type: 'number', description: '超时时间，默认15000ms' }
      }
    }
  },
  {
    name: 'browser_wait_for_selector',
    description: '等待匹配 CSS 选择器的元素出现并可见。优先使用本工具而非固定 wait 时间；返回 found: true/false',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '必填，CSS 选择器' },
        timeoutMs: { type: 'number', description: '可选，超时时间(ms)，默认由底层处理(约10000ms)' },
        tabId: { type: 'number', description: '可选，目标标签页ID' }
      },
      required: ['selector']
    }
  },
  {
    name: 'browser_screenshot',
    description: '截取当前标签页的可视区域截图，返回base64编码',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number', description: '可选' } }
    }
  },
  {
    name: 'browser_long_screenshot',
    description: '截取当前标签页长截图。优先使用 Chrome Debugger 的 fullPage 截图，失败时自动分段滚动拼接',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '可选，目标标签页ID' },
        strategy: { type: 'string', enum: ['auto', 'debugger', 'stitch'], description: '截图策略，默认 auto' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'debugger 策略下的图片格式，默认 png' },
        quality: { type: 'number', description: 'jpeg 质量 1-100，默认90' },
        maxHeight: { type: 'number', description: '最大截图高度，默认30000px，避免超大页面撑爆消息' },
        delayMs: { type: 'number', description: 'stitch 策略每次滚动后的等待时间，默认350ms' },
        hideFixed: { type: 'boolean', description: 'stitch 策略是否临时隐藏 fixed/sticky 元素，默认 true' }
      }
    }
  },
  {
    name: 'browser_get_content',
    description: '获取当前页面的标题、URL、文本内容和指定元素的HTML',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '可选，CSS选择器。不指定则获取整个页面内容' },
        tabId: { type: 'number', description: '可选' }
      }
    }
  },
  {
    name: 'browser_list_tabs',
    description: '列出浏览器中所有打开的标签页（ID、URL、标题）',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_claim_tab',
    description: '显式接管一个 Chrome 标签页。控制提示会自动使用当前全局控制者名称；未传 tabId 时接管当前活动标签页',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '可选，要接管的标签页ID' },
        visual: { type: 'boolean', description: '是否显示提示条，默认 true' },
        showCancel: { type: 'boolean', description: '是否显示取消按钮，默认 true' }
      }
    }
  },
  {
    name: 'browser_release_tab',
    description: '释放标签页控制并关闭“正在被控制”的可视化提示',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '可选，目标标签页ID' },
        reason: { type: 'string', description: '释放原因，默认 released' }
      }
    }
  },
  {
    name: 'browser_get_visible_dom',
    description: '获取当前页面可见且可交互元素的轻量 DOM 快照，返回 node_id；后续优先用 browser_click_node / browser_type_node 操作',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '可选，目标标签页ID' }
      }
    }
  },
  {
    name: 'browser_get_dom_snapshot',
    description: '获取更完整的可读 DOM 快照，包含标题、URL、可交互元素和主要文本结构',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '可选，目标标签页ID' },
        limit: { type: 'number', description: '最多返回多少个节点，默认200' }
      }
    }
  },
  {
    name: 'browser_click_node',
    description: '点击最近一次 browser_get_visible_dom 返回的 node_id 对应元素',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: '可见 DOM 快照中的 node_id' },
        tabId: { type: 'number', description: '可选，目标标签页ID' }
      },
      required: ['nodeId']
    }
  },
  {
    name: 'browser_click_text',
    description: '点击包含指定可见文本的元素。优先用于没有稳定 node_id 或需要语义定位的页面',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要匹配的可见文本' },
        exact: { type: 'boolean', description: '是否精确匹配，默认 false' },
        tabId: { type: 'number', description: '可选，目标标签页ID' }
      },
      required: ['text']
    }
  },
  {
    name: 'browser_click_role',
    description: '点击匹配 role 和可选名称的元素，例如 button/link/tab/menuitem',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'ARIA role 或常见语义角色，如 button/link/textbox' },
        name: { type: 'string', description: '可选，元素可访问名称或可见文本' },
        exact: { type: 'boolean', description: '是否精确匹配名称，默认 false' },
        tabId: { type: 'number', description: '可选，目标标签页ID' }
      },
      required: ['role']
    }
  },
  {
    name: 'browser_type_node',
    description: '向最近一次 browser_get_visible_dom 返回的 node_id 对应输入元素输入文本',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: '可见 DOM 快照中的 node_id' },
        text: { type: 'string', description: '要输入的文本' },
        tabId: { type: 'number', description: '可选，目标标签页ID' }
      },
      required: ['nodeId', 'text']
    }
  },
  {
    name: 'browser_type_by_label',
    description: '根据 label、placeholder、aria-label 或相邻文本找到输入元素并输入文本',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '标签、占位符或可访问名称' },
        text: { type: 'string', description: '要输入的文本' },
        exact: { type: 'boolean', description: '是否精确匹配，默认 false' },
        tabId: { type: 'number', description: '可选，目标标签页ID' }
      },
      required: ['label', 'text']
    }
  },
  {
    name: 'browser_execute',
    description: '在页面上下文中执行自定义JavaScript代码并返回结果',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的JS代码' },
        tabId: { type: 'number', description: '可选' }
      },
      required: ['code']
    }
  },
  {
    name: 'browser_visual_start',
    description: '显式开启页面可视化控制。常规浏览器工具会自动开启，通常无需调用；显示名称来自当前全局控制者配置',
    inputSchema: {
      type: 'object',
      properties: {
        showCancel: { type: 'boolean', description: '是否显示取消按钮，默认 true' },
        theme: { type: 'string', enum: ['light', 'dark'], description: '提示条主题，默认 light' },
        cursor: { type: 'boolean', description: '是否显示光晕指针，默认 true' },
        tabId: { type: 'number', description: '可选，目标标签页ID' }
      }
    }
  },
  {
    name: 'browser_visual_stop',
    description: '关闭可视化调试：移除页面顶部提示条与光晕指针',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '关闭原因，如 completed / cancelled' },
        tabId: { type: 'number', description: '可选' }
      }
    }
  },
  {
    name: 'browser_visual_update',
    description: '更新可视化调试状态：刷新提示条文案与运行状态（running/error/done）',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '新的提示条文案' },
        state: { type: 'string', enum: ['running', 'error', 'done'], description: '运行状态' },
        tabId: { type: 'number', description: '可选' }
      }
    }
  },
  {
    name: 'browser_finalize_tabs',
    description: '收尾浏览器会话：释放控制提示，并可选择关闭指定标签页。默认只释放提示，不关闭页面',
    inputSchema: {
      type: 'object',
      properties: {
        releaseTabIds: {
          type: 'array',
          description: '需要关闭控制提示的标签页ID列表',
          items: { type: 'number' }
        },
        closeTabIds: {
          type: 'array',
          description: '需要关闭的标签页ID列表。谨慎使用',
          items: { type: 'number' }
        }
      }
    }
  },
  {
    name: 'task_create',
    description: '创建一个新的 JS 定时自动化任务。source 必须是完整的 ES 模块源码，默认导出 { name, schedule, async run(ctx) {} }。先用浏览器工具分析页面，再在 run(ctx) 中编排循环、条件和浏览器动作。',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: "完整 ES 模块源码，例如 export default { name: '巡检', schedule: '*/30 * * * *', async run(ctx) { await ctx.navigate('https://example.com'); await ctx.waitForLoad(); } };" }
      },
      required: ['source']
    }
  },
  {
    name: 'task_list',
    description: '列出所有已注册的任务及其状态',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'task_get',
    description: '获取指定任务的详细信息',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId']
    }
  },
  {
    name: 'task_update',
    description: '以完整 JS 模块源码原子更新已有任务。源码校验、cron 校验或调度重载失败时会恢复之前的版本。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        source: { type: 'string', description: '完整 ES 模块源码' }
      },
      required: ['taskId', 'source']
    }
  },
  {
    name: 'task_delete',
    description: '删除指定任务',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId']
    }
  },
  {
    name: 'task_run',
    description: '立即运行一次指定任务（手动触发，不改变cron调度）',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId']
    }
  },
  {
    name: 'task_cancel',
    description: '取消正在执行的任务，并中断当前步骤、重试和后续步骤',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId']
    }
  },
  {
    name: 'task_logs',
    description: '获取指定任务的执行日志',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        limit: { type: 'number', description: '返回条数，默认20' }
      },
      required: ['taskId']
    }
  },
  {
    name: 'system_status',
    description: '获取系统状态：Chrome连接状态、任务数量、调度器状态',
    inputSchema: { type: 'object', properties: {} }
  }
];

// ── MCP 协议处理 ─────────────────────────

let buffer = '';
let pendingRequestCount = 0;
let stdinEnded = false;

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;

  // 按行解析 JSON-RPC
  while (buffer.includes('\n')) {
    const nl = buffer.indexOf('\n');
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);

    if (!line) continue;

    pendingRequestCount++;
    try {
      const msg = JSON.parse(line);
      const response = await handleMessage(msg);
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (err) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'JSON 解析错误: ' + err.message }
      }) + '\n');
    } finally {
      pendingRequestCount--;
      if (stdinEnded && pendingRequestCount === 0) void shutdown('mcp_session_ended');
    }
  }
});

let shutdownPromise = null;

async function releaseControlledTabs(reason) {
  const releaseTabIds = [...controller.controlledTabIds];
  if (releaseTabIds.length === 0) return;

  try {
    await httpPost(`${DAEMON_API}/browser/finalizeTabs`, {
      releaseTabIds,
      reason,
      controllerSessionId: controller.sessionId,
    });
  } catch (err) {
    // The daemon lease is the fallback for forced shutdowns or connection loss.
    console.error('释放浏览器控制提示失败:', err.message);
  } finally {
    controller.controlledTabIds.clear();
  }
}

function shutdown(reason) {
  if (!shutdownPromise) {
    shutdownPromise = releaseControlledTabs(reason).finally(() => process.exit(0));
  }
  return shutdownPromise;
}

process.stdin.on('end', () => {
  stdinEnded = true;
  if (pendingRequestCount === 0) void shutdown('mcp_session_ended');
});
process.on('SIGINT', () => { void shutdown('mcp_interrupted'); });
process.on('SIGTERM', () => { void shutdown('mcp_terminated'); });

async function handleMessage(msg) {
  const { jsonrpc, id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2025-03-26',
          serverInfo: { name: 'browser-pilot', version: '1.1.2' },
          capabilities: { tools: {} }
        }
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0', id,
        result: { tools: TOOLS }
      };

    case 'tools/call':
      try {
        const result = await callTool(params.name, params.arguments || {});
        return {
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
          }
        };
      } catch (err) {
        return {
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text: '操作失败: ' + err.message }],
            isError: true
          }
        };
      }

    case 'notifications/initialized':
      return null;

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    default:
      return {
        jsonrpc: '2.0', id,
        error: { code: -32601, message: `未知方法: ${method}` }
      };
  }
}

// ── 工具执行 → HTTP 转发 ────────────────

async function callTool(name, args) {
  if (name === 'browser_controller_config') {
    controller.label = normalizeControllerLabel(args.label);
    return { label: controller.label, scope: 'current_mcp_connection' };
  }

  // 浏览器操作 → /api/browser/:action
  // 显式 map：下划线工具名映射到驼峰 action 名，避免简单 replace 出错
  const BROWSER_ACTION_MAP = {
    browser_navigate:       'navigate',
    browser_create_tab:     'createTab',
    browser_close_tab:      'closeTab',
    browser_go_back:        'goBack',
    browser_go_forward:     'goForward',
    browser_reload:         'reload',
    browser_click:          'click',
    browser_type:           'type',
    browser_scroll:         'scroll',
    browser_wait_for_load:  'waitForLoad',
    browser_wait_for_navigation:'waitForNavigation',
    browser_wait_for_selector:'waitForSelector',
    browser_screenshot:     'screenshot',
    browser_long_screenshot:'longScreenshot',
    browser_get_content:    'getContent',
    browser_list_tabs:      'listTabs',
    browser_claim_tab:      'claimTab',
    browser_release_tab:    'releaseTab',
    browser_finalize_tabs:  'finalizeTabs',
    browser_get_visible_dom:'getVisibleDom',
    browser_get_dom_snapshot:'getDomSnapshot',
    browser_click_node:     'clickNode',
    browser_type_node:      'typeNode',
    browser_click_text:     'clickText',
    browser_click_role:     'clickRole',
    browser_type_by_label:  'typeByLabel',
    browser_execute:        'execute',
    browser_visual_start:   'visualStart',
    browser_visual_stop:    'visualStop',
    browser_visual_update:  'visualUpdate',
  };

  if (name in BROWSER_ACTION_MAP) {
    const actionName = BROWSER_ACTION_MAP[name];
    return callBrowserTool(name, actionName, args);
  }

  // 任务管理
  const taskActions = {
    task_create:  ['POST', '/tasks'],
    task_list:    ['GET',  '/tasks'],
    task_get:     ['GET',  `/tasks/${args.taskId}`],
    task_update:  ['PUT',  `/tasks/${args.taskId}`],
    task_delete:  ['DELETE', `/tasks/${args.taskId}`],
    task_run:     ['POST', `/tasks/${args.taskId}/run`],
    task_cancel:  ['POST', `/tasks/${args.taskId}/cancel`],
    task_logs:    ['GET',  `/tasks/${args.taskId}/logs?limit=${args.limit || 20}`],
  };

  const [method, path] = taskActions[name] || [];
  if (method && path) {
    if (method === 'GET' || method === 'DELETE') {
      return httpRequest(method, `${DAEMON_API}${path}`);
    }
    return httpPost(`${DAEMON_API}${path}`, args);
  }

  // 系统状态
  if (name === 'system_status') {
    return httpRequest('GET', `${DAEMON_API}/status`);
  }

  throw new Error(`未知工具: ${name}`);
}

const AUTO_CONTROLLED_TOOLS = new Set([
  'browser_navigate', 'browser_go_back', 'browser_go_forward', 'browser_reload',
  'browser_click', 'browser_type', 'browser_scroll', 'browser_wait_for_load',
  'browser_wait_for_navigation', 'browser_wait_for_selector', 'browser_screenshot',
  'browser_long_screenshot', 'browser_get_content', 'browser_get_visible_dom',
  'browser_get_dom_snapshot', 'browser_click_node', 'browser_type_node',
  'browser_click_text', 'browser_click_role', 'browser_type_by_label', 'browser_execute',
]);

async function callBrowserTool(name, actionName, args) {
  if (name === 'browser_create_tab') {
    const result = await httpPost(`${DAEMON_API}/browser/${actionName}`, args);
    const tabId = result?.tabId;
    if (Number.isInteger(tabId)) await ensureVisualControl(tabId);
    return result;
  }

  if (name === 'browser_claim_tab') {
    const result = await httpPost(`${DAEMON_API}/browser/${actionName}`, {
      ...args,
      controllerSessionId: controller.sessionId,
      label: controller.label,
      visual: true,
      cursor: true,
      showCancel: args.showCancel !== false,
    });
    if (Number.isInteger(result?.tabId)) controller.controlledTabIds.add(result.tabId);
    return result;
  }

  if (AUTO_CONTROLLED_TOOLS.has(name)) {
    const tabId = await ensureVisualControl(args.tabId);
    return httpPost(`${DAEMON_API}/browser/${actionName}`, {
      ...args,
      tabId,
      controllerSessionId: controller.sessionId,
    });
  }

  if (name === 'browser_release_tab') {
    if (!Number.isInteger(args.tabId)) {
      return finalizeControlledTabs(args.reason || 'released');
    }
    const result = await httpPost(`${DAEMON_API}/browser/${actionName}`, {
      ...args,
      controllerSessionId: controller.sessionId,
    });
    if (Number.isInteger(args.tabId)) controller.controlledTabIds.delete(args.tabId);
    else controller.controlledTabIds.clear();
    return result;
  }

  if (name === 'browser_close_tab') {
    const result = await httpPost(`${DAEMON_API}/browser/${actionName}`, {
      ...args,
      controllerSessionId: controller.sessionId,
    });
    controller.controlledTabIds.delete(args.tabId);
    return result;
  }

  if (name === 'browser_finalize_tabs') {
    const result = await httpPost(`${DAEMON_API}/browser/${actionName}`, {
      ...args,
      controllerSessionId: controller.sessionId,
    });
    for (const tabId of args.releaseTabIds || []) controller.controlledTabIds.delete(tabId);
    for (const tabId of args.closeTabIds || []) controller.controlledTabIds.delete(tabId);
    return result;
  }

  if (name === 'browser_visual_start') {
    const result = await httpPost(`${DAEMON_API}/browser/${actionName}`, {
      ...args,
      controllerSessionId: controller.sessionId,
      label: controller.label,
      cursor: true,
    });
    if (Number.isInteger(result?.tabId)) controller.controlledTabIds.add(result.tabId);
    return result;
  }

  if (name === 'browser_visual_stop') {
    if (!Number.isInteger(args.tabId)) {
      return finalizeControlledTabs(args.reason || 'visual_stopped');
    }
    const result = await httpPost(`${DAEMON_API}/browser/${actionName}`, {
      ...args,
      controllerSessionId: controller.sessionId,
    });
    if (Number.isInteger(args.tabId)) controller.controlledTabIds.delete(args.tabId);
    else controller.controlledTabIds.clear();
    return result;
  }

  if (name === 'browser_visual_update') {
    return httpPost(`${DAEMON_API}/browser/${actionName}`, {
      ...args,
      controllerSessionId: controller.sessionId,
    });
  }

  return httpPost(`${DAEMON_API}/browser/${actionName}`, args);
}

async function ensureVisualControl(tabId) {
  if (Number.isInteger(tabId) && controller.controlledTabIds.has(tabId)) return tabId;

  const claim = await httpPost(`${DAEMON_API}/browser/claimTab`, {
    ...(Number.isInteger(tabId) ? { tabId } : {}),
    controllerSessionId: controller.sessionId,
    label: controller.label,
    visual: true,
    cursor: true,
    showCancel: true,
  });
  const resolvedTabId = claim?.tabId ?? tabId;
  if (Number.isInteger(resolvedTabId)) controller.controlledTabIds.add(resolvedTabId);
  return resolvedTabId;
}

async function finalizeControlledTabs(reason) {
  const releaseTabIds = [...controller.controlledTabIds];
  if (releaseTabIds.length === 0) return { released: [] };

  const result = await httpPost(`${DAEMON_API}/browser/finalizeTabs`, {
    releaseTabIds,
    reason,
    controllerSessionId: controller.sessionId,
  });
  controller.controlledTabIds.clear();
  return result;
}

// ── HTTP 客户端 ──────────────────────────

function httpRequest(method, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      timeout: 30000,
      headers: API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : undefined,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 0 || json.code === undefined) {
            resolve(json.data !== undefined ? json.data : json);
          } else {
            reject(new Error(json.message || '请求失败'));
          }
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', (err) => reject(new Error('无法连接到 Daemon，请确认调度器已启动: ' + err.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {})
      }
    }, (res) => {
      let response = '';
      res.on('data', c => response += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(response);
          if (json.code === 0 || json.code === undefined) {
            resolve(json.data !== undefined ? json.data : json);
          } else {
            reject(new Error(json.message || '请求失败'));
          }
        } catch {
          resolve(response);
        }
      });
    });
    req.on('error', (err) => reject(new Error('无法连接到 Daemon，请确认调度器已启动: ' + err.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(data);
    req.end();
  });
}
