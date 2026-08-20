# BrowserPilot

[![CI](https://github.com/Puxora/BrowserPilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Puxora/BrowserPilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@puxora/browserpilot.svg)](https://www.npmjs.com/package/@puxora/browserpilot)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

[English](./README.en.md) | 简体中文

BrowserPilot 是面向 AI Agent 的本地浏览器控制桥。它把 Chrome 扩展、Native Messaging Bridge、本地 daemon 与 MCP stdio server 组合起来，让 Codex、Claude Code、Antigravity、VS Code/Copilot、Cline 等客户端安全地操作真实 Chrome。

浏览器内容、截图、任务、审批记录默认留在本机。daemon 默认仅监听 `127.0.0.1`；跨 WSL、容器或局域网访问必须使用可撤销 Token。

## 目录

- [产品能力](#产品能力)
- [快速开始（正式使用）](#快速开始正式使用)
- [远程与 WSL](#远程与-wsl)
- [MCP 客户端配置](#mcp-客户端配置)
- [定时自动化任务](#定时自动化任务)
- [CLI 命令](#cli-命令)
- [MCP 工具](#mcp-工具)
- [权限与安全](#权限与安全)
- [架构与设计](#架构与设计)
- [开发部署](#开发部署)
- [贡献、发布与更新](#贡献发布与更新)

## 产品能力

| 能力 | 说明 |
| --- | --- |
| 真实 Chrome 控制 | 在用户已登录的 Chrome 中导航、点击、输入、滚动、截图和管理标签页。 |
| 可观察的页面交互 | 获取可见 DOM、快照、页面内容与截图；推荐先观察，再用稳定的节点或语义目标操作。 |
| 多 Agent MCP 接入 | 通过 stdio MCP 接入 Codex、Claude Code、Antigravity、VS Code/Copilot、Cline 和其他兼容客户端。 |
| 定时浏览器自动化 | 将受信任的 JavaScript 任务保存到本机，按 Cron 执行、手动运行、取消并查看日志。 |
| 本地管理后台 | 查看连接、任务、下次运行时间、运行状态、日志与待审批操作。 |
| 可执行的权限策略 | 对写操作、页面 JavaScript、下载与上传真实生效；上传和下载都有默认拒绝的超时保护。 |
| 远程/WSL 访问 | 通过可撤销 Token 将 WSL 或其他可信环境中的 MCP adapter 安全连接到 Windows daemon。 |

## 快速开始（正式使用）

以下是推荐的生产使用路径，需要 Node.js 18+ 与 Google Chrome。

### 1. 安装并注册本地桥接

```bash
npm install -g @puxora/browserpilot
browserpilot install
```

从旧包迁移时，先运行 `npm uninstall -g @pulab/browserpilot`，再安装 `@puxora/browserpilot`。本地的 `~/.browserpilot` 配置和任务数据不会因更换 npm 包名而删除。

`install` 会注册当前用户的 Chrome Native Messaging Host。随后打开 `chrome://extensions`，开启“开发者模式”，选择“加载已解压的扩展程序”，并选中 CLI 输出的 `chrome-extension` 目录。

### 卸载

npm 不会自动移除 CLI 创建的 Chrome 注册表和 Native Messaging 配置。请先清理本地桥接，再卸载 npm 包：

```bash
browserpilot uninstall
npm uninstall -g @puxora/browserpilot
```

`browserpilot uninstall` 保留 `~/.browserpilot` 下的配置、Token、任务和日志；如需同时永久删除这些本地数据，请明确执行 `browserpilot uninstall --purge`。Chrome 扩展仍需在 `chrome://extensions` 中手动移除。

### 2. 启动本地服务

```bash
browserpilot start
```

`start` 默认在后台启动 daemon、Web UI 与调度器，并立即返回命令行。管理面板位于 `http://127.0.0.1:9876`。首次在本机浏览器打开时，会获得仅限 loopback 的认证 Cookie。

常用生命周期命令：

```bash
browserpilot status
browserpilot stop
browserpilot restart
```

如需在当前终端查看实时日志，可使用：

```bash
browserpilot start --foreground
```

### 3. 接入 MCP 客户端

任一支持 stdio MCP 的客户端都可先用以下最小配置：

```json
{
  "mcpServers": {
    "browserpilot": {
      "command": "npx",
      "args": ["-y", "@puxora/browserpilot", "mcp"]
    }
  }
}
```

下文提供各客户端可直接复制的配置。首次使用建议让 Agent 先调用 `system_status` 与 `browser_list_tabs`，确认 daemon 和扩展已连接。

## 远程与 WSL

本机默认地址无需手动提供 Token。跨 WSL、容器或其他主机时，在 **运行 Windows daemon 的机器** 创建可撤销 Token：

```bash
browserpilot token create --name wsl-agent
```

完整 Token 仅在创建时显示一次。将它保存在客户端的安全凭据或环境变量中；不要提交到 Git、写入任务源码、URL 或共享配置。管理命令：

```bash
browserpilot token list
browserpilot token revoke --id <token-id>
```

在客户端环境生成通用配置：

```bash
browserpilot mcp config --client generic \
  --daemon-api http://<windows-host-ip>:9876/api \
  --token <刚创建的Token>
```

Windows daemon 必须显式允许非 loopback 监听，并限制可信 Host、Origin 和防火墙范围：

```powershell
$env:CA_API_TOKEN = "<daemon-bootstrap-secret>"
$env:CA_TRUSTED_HOSTS = "<windows-host-ip>"
$env:CA_TRUSTED_ORIGINS = "http://<windows-host-ip>:9876"
browserpilot start --listen-host 0.0.0.0
```

仅在可信网络使用该模式。MCP adapter 端使用 `CA_API_TOKEN`；daemon 的启动密钥与为客户端签发的可撤销 Token 应分别保存。

## MCP 客户端配置

BrowserPilot 是 stdio MCP server：客户端启动 `browserpilot mcp`，该进程再转发请求到本机或指定的 daemon API。

### Codex

本机注册：

```bash
codex mcp add browserpilot -- npx -y @puxora/browserpilot mcp
```

跨 WSL 时，在 `~/.codex/config.toml` 添加：

```toml
[mcp_servers.browserpilot]
command = "npx"
args = ["-y", "@puxora/browserpilot", "mcp", "--daemon-api", "http://<windows-host-ip>:9876/api"]

[mcp_servers.browserpilot.env]
CA_API_TOKEN = "bp_..."
```

重启后使用 `/mcp` 或 `codex mcp list` 检查状态。参见 [Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp.md)。

### Claude Code

本机注册：

```bash
claude mcp add-json browserpilot '{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@puxora/browserpilot", "mcp"],
  "env": {}
}'
```

跨 WSL 时，在 `args` 追加 `--daemon-api`，并在 `env` 加入 `"CA_API_TOKEN": "bp_..."`。完成后使用 `claude mcp` 检查。参见 [Claude Code MCP 文档](https://docs.anthropic.com/en/docs/claude-code/mcp)。

### Antigravity（推荐的 Google 系客户端）

Google 已将面向个人用户的 Gemini CLI 迁移到 Antigravity CLI。使用 `/mcp` 打开 MCP Manager；或编辑全局 `~/.gemini/config/mcp_config.json`，也可在项目根目录创建 `.agents/mcp_config.json`：

```json
{
  "mcpServers": {
    "browserpilot": {
      "command": "npx",
      "args": ["-y", "@puxora/browserpilot", "mcp"],
      "env": {}
    }
  }
}
```

跨 WSL 时使用：

```json
{
  "mcpServers": {
    "browserpilot": {
      "command": "npx",
      "args": ["-y", "@puxora/browserpilot", "mcp", "--daemon-api", "http://<windows-host-ip>:9876/api"],
      "env": { "CA_API_TOKEN": "bp_..." }
    }
  }
}
```

配置完成后在 Antigravity CLI 中执行 `/mcp` 查看连接和日志。若从 Gemini CLI 迁移，Antigravity 可迁移原有 MCP 配置；但请复核 Token 不会被写入项目文件。参见 [Antigravity MCP 文档](https://antigravity.google/docs/mcp) 与 [迁移指南](https://antigravity.google/docs/gcli-migration)。

### Gemini CLI（旧版兼容）

截至 2026-06-18，Google AI 免费、Pro 和 Ultra 用户应改用 Antigravity CLI；Gemini CLI 仅保留给企业 Gemini Code Assist、Google Cloud 及特定付费 API Key 场景。若你的组织仍在使用它，可继续采用原 `mcpServers` 配置或：

```bash
gemini mcp add --scope user browserpilot npx -y @puxora/browserpilot mcp
```

迁移政策请以 [Google 官方公告](https://github.com/google-gemini/gemini-cli/discussions/27274) 为准。

### VS Code / GitHub Copilot Chat

在用户配置或项目的 `.vscode/mcp.json` 添加；项目配置不得提交真实 Token：

```json
{
  "servers": {
    "browserpilot": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@puxora/browserpilot", "mcp"],
      "env": { "CA_API_TOKEN": "${input:browserpilot-token}" }
    }
  },
  "inputs": [{
    "id": "browserpilot-token",
    "type": "promptString",
    "description": "BrowserPilot Token",
    "password": true
  }]
}
```

本机模式可移除 `env`。通过命令面板运行 `MCP: List Servers` 检查。参见 [VS Code MCP 配置参考](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) 和 [Copilot MCP 指南](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp)。

### Cline 与其他 stdio 客户端

Cline 全局配置通常位于 `~/.cline/data/settings/cline_mcp_settings.json`，项目配置可使用 `.cline/mcp.json`。其他兼容 stdio MCP 的 Agent 也使用同一结构：

```json
{
  "mcpServers": {
    "browserpilot": {
      "command": "npx",
      "args": ["-y", "@puxora/browserpilot", "mcp"],
      "env": { "CA_API_TOKEN": "bp_..." }
    }
  }
}
```

本机模式可省略 `env`。不要关闭客户端自身的工具审批。参见 [Cline 配置说明](https://docs.cline.bot/getting-started/config)。

## 定时自动化任务

任务适合巡检页面状态、定时采集、周期性下载前的人工审批流程等。每个任务是保存在本机的 ES 模块，默认导出名称、Cron 表达式、是否启用和 `run(ctx)` 函数。任务可通过管理面板或 MCP 创建。

```js
export default {
  name: '每日状态巡检',
  description: '每天上午 9 点检查控制台',
  schedule: '0 9 * * *',
  enabled: true,
  async run(ctx) {
    await ctx.navigate('https://example.com/dashboard');
    await ctx.waitForLoad();
    // 先观察，再执行需要的点击、输入或抓取操作。
  },
};
```

| 工作流 | 使用方式 |
| --- | --- |
| 创建/修改 | 使用 `task_create`、`task_update` 提交完整任务模块。系统先校验模块和 Cron；更新失败会保留上一版本。 |
| 启停 | `enabled: false` 会取消调度；恢复为 `true` 后重新加载。删除任务文件或调用 `task_delete` 会停止其调度。 |
| 立即运行 | `task_run` 立即执行一次，不改变 Cron。 |
| 取消 | `task_cancel` 中止当前正在执行的任务。 |
| 观察 | `task_list`、`task_get` 返回状态与下次运行时间；`task_logs` 查看启动、结果与失败日志。 |
| 重叠与并发 | 同一任务上一次未结束时不会重复启动；全局并发受 daemon 配置限制。 |

Cron 使用五段表达式，例如 `0 9 * * *`（每天 09:00）、`*/30 * * * *`（每 30 分钟）。请先用手动运行验证选择器和站点行为，再启用周期调度。任务源码拥有浏览器控制能力，**只保存和运行你信任的代码**；所有涉及点击、执行 JavaScript、上传和下载的动作仍受 BrowserPilot 当前权限策略约束。

## CLI 命令

| 命令 | 说明 |
| --- | --- |
| `browserpilot --version` / `browserpilot -v` / `browserpilot version` | 查看当前 CLI 版本。 |
| `browserpilot install` | 注册当前用户的 Chrome Native Messaging Host。 |
| `browserpilot uninstall` | 停止 daemon，并清理 BrowserPilot 创建的 Native Messaging manifest、Chrome 注册表项和桥接文件；保留本地数据。 |
| `browserpilot uninstall --purge` | 在完成普通卸载清理后，永久删除 `~/.browserpilot` 中的配置、Token、任务和日志。 |
| `browserpilot start` | 后台启动 daemon、Web UI 与调度器；默认仅监听 `127.0.0.1:9876`。 |
| `browserpilot start --foreground` | 在当前终端前台启动 daemon，适合调试或查看实时日志。 |
| `browserpilot start --listen-host <ip> --port <port>` | 指定监听地址和 HTTP 端口；非 loopback 必须显式配置安全环境变量。 |
| `browserpilot stop` | 停止后台 daemon。 |
| `browserpilot restart` | 重启后台 daemon。 |
| `browserpilot status` | 查看后台 daemon 的 PID、Web UI 地址和日志位置。 |
| `browserpilot mcp` | 作为 stdio MCP server 运行；本机 daemon 不存在时自动启动。 |
| `browserpilot mcp --daemon-api <url> --token <token>` | 连接指定 daemon；Token 也可用 `CA_API_TOKEN` 提供。 |
| `browserpilot mcp config --client <name> [--wsl] [--daemon-api <url>] [--token <token>]` | 输出可复制的通用 MCP JSON 配置。 |
| `browserpilot token create --name <name>` | 创建可撤销的远程 MCP Token，仅显示一次明文。 |
| `browserpilot token list` | 列出 Token 的 ID、名称和创建时间，不显示明文。 |
| `browserpilot token revoke --id <id>` | 立即撤销指定 Token。 |

## MCP 工具

完整清单可运行 `npm run check:tools` 查看。推荐按“观察 → 操作 → 验证”使用，优先采用可见 DOM 的 `node_id` 或语义目标，避免脆弱的 CSS selector。

| 类别 | 代表工具 | 用途 |
| --- | --- | --- |
| 标签页 | `browser_list_tabs`、`browser_create_tab`、`browser_claim_tab`、`browser_release_tab` | 查询、创建并独占控制标签页。 |
| 导航 | `browser_navigate`、`browser_go_back`、`browser_reload` | 打开页面与历史操作。 |
| 观察 | `browser_get_visible_dom`、`browser_get_dom_snapshot`、`browser_get_content` | 获取页面结构、可见内容与状态。 |
| 交互 | `browser_click_node`、`browser_type_node`、`browser_click_role`、`browser_type_by_label` | 按稳定节点或语义目标点击、输入。 |
| 等待与图像 | `browser_wait_for_load`、`browser_wait_for_selector`、`browser_screenshot`、`browser_long_screenshot` | 等待状态变化并检查操作结果。 |
| 风险操作 | `browser_execute`、`browser_close_tab` | 页面 JavaScript 与关闭标签页；受开发者开关、审批和控制租约约束。 |
| 自动化任务 | `task_create`、`task_update`、`task_run`、`task_cancel`、`task_logs` | 管理、调度、取消并审计本地任务。 |
| 状态 | `system_status`、`browser_controller_config` | 查询连接状态、声明当前控制者。 |

## 权限与安全

管理面板中的设置均有对应的浏览器执行链路：

- **写操作审批**：控制点击、输入、页面 JavaScript 与关闭标签页。站点例外只影响这项审批，不会放宽传输策略。
- **页面 JavaScript 开发者权限**：关闭时拒绝 `browser_execute`；开启后仍需通过写操作审批。
- **下载权限**：只作用于 BrowserPilot 已接管标签页触发的下载。`always` 放行，`ask` 等待审批，`none` 取消；超时默认取消。
- **上传权限**：AI 点击文件输入框前执行 `always`、`ask`、`none` 策略。允许仅代表打开系统文件选择器；用户仍自行选择本地文件，超时默认拒绝。
- **远程认证**：所有 `/api` 端点都需 Token。Web UI 只为 loopback 浏览器提供 HttpOnly、SameSite Cookie；远程 MCP 使用 Bearer Token。

扩展需 `tabs`、`scripting`、`debugger`、`nativeMessaging`、`downloads` 等权限才能操作真实浏览器。只安装可信来源的版本，不要在不可信网络公开 daemon，也不要在任务源码中保存密码或 Token。

## 架构与设计

```text
MCP 客户端
  -> BrowserPilot MCP Adapter（stdio）
  -> daemon API / Token / 审批与权限策略
  -> loopback WebSocket
  -> Chrome 扩展
  -> 真实 Chrome 标签页

管理面板 -> daemon API
任务调度器 -> 本机任务存储 -> 同一权限策略与浏览器执行链路
```

设计原则：

1. **本地优先**：控制、截图、任务定义和审批记录默认存储在用户设备。
2. **最小暴露面**：daemon 默认只监听 loopback；远程访问需要显式网络配置与可撤销 Token。
3. **可观察后执行**：提供 DOM、截图和等待工具，让 Agent 在操作前确认页面状态。
4. **风险动作可撤回**：写操作、上传、下载与页面 JavaScript 可配置审批、拒绝或超时保护。
5. **多会话隔离**：标签页控制租约防止不同 Agent 会话彼此抢占或关闭标签。

## 开发部署

从源码运行：

```bash
git clone https://github.com/Puxora/BrowserPilot.git
cd BrowserPilot/orchestrator
npm ci
node bin/cli.js install
npm start
```

在 Chrome 中加载仓库根目录的 `chrome-extension`。开发期间可运行：

```bash
npm test
npm run test:coverage
npm run check:tools
npm audit --package-lock-only --audit-level=moderate
npm pack --dry-run
```

## 贡献、发布与更新

- 贡献流程、开发约定与测试要求见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
- 漏洞报告渠道见 [SECURITY.md](./SECURITY.md)，请勿公开披露未修复安全问题。
- 社区行为准则见 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。
- 版本变更见 [CHANGELOG.md](./CHANGELOG.md)。发布前请执行测试、审计与 `npm pack --dry-run`，再按 npm 的语义化版本规范发布。

本项目采用 [MIT License](./LICENSE)。
