# BrowserPilot

[![CI](https://github.com/Puxora/BrowserPilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Puxora/BrowserPilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@puxora/browserpilot.svg)](https://www.npmjs.com/package/@puxora/browserpilot)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

English | [简体中文](./README.md)

BrowserPilot is a local browser-control bridge for AI agents. It combines a Chrome extension, Native Messaging Bridge, local daemon, and stdio MCP server so that Codex, Claude Code, Antigravity, VS Code/Copilot, Cline, and other MCP clients can safely operate a real Chrome browser.

Browser content, screenshots, tasks, and approval records remain on the local machine by default. The daemon listens on `127.0.0.1` by default; WSL, container, or LAN access requires revocable Tokens.

## Contents

- [Capabilities](#capabilities)
- [Quick start (production use)](#quick-start-production-use)
- [Remote and WSL](#remote-and-wsl)
- [MCP clients](#mcp-clients)
- [Scheduled automation](#scheduled-automation)
- [CLI](#cli)
- [MCP tools](#mcp-tools)
- [Permissions and security](#permissions-and-security)
- [Architecture](#architecture)
- [Development deployment](#development-deployment)
- [Contributing, releases, and changes](#contributing-releases-and-changes)

## Capabilities

| Capability | What it does |
| --- | --- |
| Real Chrome control | Navigate, click, type, scroll, capture, and manage tabs in the user's logged-in browser. |
| Observable interaction | Inspect visible DOM, snapshots, content, and screenshots before acting. |
| Multi-agent MCP access | Connect Codex, Claude Code, Antigravity, VS Code/Copilot, Cline, and other stdio MCP clients. |
| Scheduled browser automation | Store trusted JavaScript jobs locally; run them on Cron schedules, manually trigger or cancel them, and inspect logs. |
| Local dashboard | Inspect connections, tasks, next run times, logs, approvals, and policy settings. |
| Enforced permissions | Write actions, page JavaScript, downloads, and uploads are governed by executable policies with deny-by-default timeouts. |
| Remote/WSL support | Connect an MCP adapter in WSL or another trusted environment to a Windows daemon using revocable Tokens. |

## Quick start (production use)

This is the recommended production path. It requires Node.js 18+ and Google Chrome.

### 1. Install and register the local bridge

```bash
npm install -g @puxora/browserpilot
browserpilot install
```

To migrate from the former package, run `npm uninstall -g @pulab/browserpilot` before installing `@puxora/browserpilot`. Changing the npm package name does not remove local configuration or task data under `~/.browserpilot`.

The command registers the Native Messaging Host for the current user. Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the `chrome-extension` directory printed by the CLI.

### Uninstall

npm does not automatically remove the Chrome registry entries and Native Messaging configuration created by the CLI. Clean up the local bridge before removing the npm package:

```bash
browserpilot uninstall
npm uninstall -g @puxora/browserpilot
```

`browserpilot uninstall` retains configuration, Tokens, tasks, and logs under `~/.browserpilot`. To permanently delete that local data too, explicitly run `browserpilot uninstall --purge`. Remove the Chrome extension separately from `chrome://extensions`.

### 2. Start the local service

```bash
browserpilot start
```

`start` launches the daemon, Web UI, and scheduler in the background by default and returns the shell immediately. The dashboard is available at `http://127.0.0.1:9876`. Opening it from a local browser creates a loopback-only authentication cookie.

Common lifecycle commands:

```bash
browserpilot status
browserpilot stop
browserpilot restart
```

To keep logs attached to the current terminal, run:

```bash
browserpilot start --foreground
```

### 3. Connect an MCP client

Any stdio MCP client can start with this configuration:

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

Use `system_status` and `browser_list_tabs` first to verify the daemon and extension connection.

## Remote and WSL

Local clients do not need a manually supplied Token. For WSL, containers, or another host, create a revocable Token on the machine that runs the Windows daemon:

```bash
browserpilot token create --name wsl-agent
```

The complete Token is shown only once. Keep it in the client's secure secret store or environment; never commit it, put it in a URL, or add it to task source.

```bash
browserpilot token list
browserpilot token revoke --id <token-id>
```

Generate a generic client configuration in the remote environment:

```bash
browserpilot mcp config --client generic \
  --daemon-api http://<windows-host-ip>:9876/api \
  --token <token>
```

The Windows daemon must explicitly opt into non-loopback access and intentionally restrict hosts, origins, and firewall rules:

```powershell
$env:CA_API_TOKEN = "<daemon-bootstrap-secret>"
$env:CA_TRUSTED_HOSTS = "<windows-host-ip>"
$env:CA_TRUSTED_ORIGINS = "http://<windows-host-ip>:9876"
browserpilot start --listen-host 0.0.0.0
```

Use this mode only on a trusted network. The daemon bootstrap secret and client Tokens should be stored separately.

## MCP clients

BrowserPilot is a stdio MCP server: the client starts `browserpilot mcp`, which forwards calls to the local or selected daemon API.

### Codex

```bash
codex mcp add browserpilot -- npx -y @puxora/browserpilot mcp
```

For WSL, add the following to `~/.codex/config.toml`:

```toml
[mcp_servers.browserpilot]
command = "npx"
args = ["-y", "@puxora/browserpilot", "mcp", "--daemon-api", "http://<windows-host-ip>:9876/api"]

[mcp_servers.browserpilot.env]
CA_API_TOKEN = "bp_..."
```

Restart Codex and use `/mcp` or `codex mcp list`. See the [Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp.md).

### Claude Code

```bash
claude mcp add-json browserpilot '{"type":"stdio","command":"npx","args":["-y","@puxora/browserpilot","mcp"],"env":{}}'
```

For WSL, append `--daemon-api` to `args` and define `CA_API_TOKEN` in `env`. Verify with `claude mcp`. See [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp).

### Antigravity (recommended Google client)

Google has transitioned individual Gemini CLI users to Antigravity CLI. Use `/mcp` to open its MCP Manager, or edit global `~/.gemini/config/mcp_config.json`; project-local configuration is `.agents/mcp_config.json`.

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

For WSL, use:

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

Run `/mcp` to inspect connection status and logs. Antigravity can migrate legacy Gemini CLI MCP configuration; review the result to ensure Tokens are not written into a project file. See [Antigravity MCP](https://antigravity.google/docs/mcp) and its [Gemini CLI migration guide](https://antigravity.google/docs/gcli-migration).

### Gemini CLI (legacy compatibility)

Since 2026-06-18, free, Google AI Pro, and Google AI Ultra users should use Antigravity CLI. Gemini CLI remains relevant for enterprise Gemini Code Assist, Google Cloud, and certain paid API-key scenarios. If your organization still uses it:

```bash
gemini mcp add --scope user browserpilot npx -y @puxora/browserpilot mcp
```

Follow the [official transition announcement](https://github.com/google-gemini/gemini-cli/discussions/27274) for current eligibility.

### VS Code and GitHub Copilot Chat

Create `.vscode/mcp.json` or use **MCP: Add Server**. Do not commit a real Token in project configuration:

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

Remove `env` for local use. Run **MCP: List Servers** to verify. See the [VS Code reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) and [Copilot MCP guide](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp).

### Cline and generic stdio clients

Cline commonly stores global settings in `~/.cline/data/settings/cline_mcp_settings.json`, with `.cline/mcp.json` for project configuration. Other stdio MCP clients use the same shape:

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

Remove `env` for local use and keep the client's own tool approval enabled. See [Cline configuration](https://docs.cline.bot/getting-started/config).

## Scheduled automation

Tasks are useful for status checks, periodic collection, and workflows that may later require an upload/download approval. A task is a trusted local ES module with a name, Cron schedule, enabled flag, and `run(ctx)` function. Create it from the dashboard or MCP.

```js
export default {
  name: 'Daily status check',
  description: 'Inspect the dashboard every morning',
  schedule: '0 9 * * *',
  enabled: true,
  async run(ctx) {
    await ctx.navigate('https://example.com/dashboard');
    await ctx.waitForLoad();
  },
};
```

| Workflow | How it works |
| --- | --- |
| Create/update | Submit a complete module with `task_create` or `task_update`. The module and Cron are validated; a failed update keeps the previous version. |
| Enable/disable | `enabled: false` stops scheduling. Restoring it to `true` reloads the job. Deleting a task or using `task_delete` stops it. |
| Run now | `task_run` executes once without changing the Cron schedule. |
| Cancel | `task_cancel` aborts a currently running job. |
| Observe | `task_list` and `task_get` show state and next run; `task_logs` provides start, result, and failure records. |
| Overlap/concurrency | A job is not started again while its previous run is active; daemon concurrency limits also apply. |

Cron expressions use five fields, such as `0 9 * * *` (09:00 daily) and `*/30 * * * *` (every 30 minutes). Validate a job manually before enabling its schedule. Task source can control the browser: only run code you trust. Clicks, page JavaScript, uploads, and downloads are still constrained by BrowserPilot's active policy.

## CLI

| Command | Description |
| --- | --- |
| `browserpilot --version` / `browserpilot -v` / `browserpilot version` | Show the current CLI version. |
| `browserpilot install` | Register the Chrome Native Messaging Host for the current user. |
| `browserpilot uninstall` | Stop the daemon and remove BrowserPilot-created Native Messaging manifests, Chrome registry entries, and bridge files while retaining local data. |
| `browserpilot uninstall --purge` | Permanently remove configuration, Tokens, tasks, and logs under `~/.browserpilot` after the standard cleanup. |
| `browserpilot start` | Start the daemon, dashboard, and scheduler in the background on `127.0.0.1:9876` by default. |
| `browserpilot start --foreground` | Start the daemon in the current terminal for debugging or live logs. |
| `browserpilot start --listen-host <ip> --port <port>` | Set the HTTP listener and port; non-loopback use requires explicit security configuration. |
| `browserpilot stop` | Stop the background daemon. |
| `browserpilot restart` | Restart the background daemon. |
| `browserpilot status` | Show the daemon PID, Web UI URL, and log path. |
| `browserpilot mcp` | Start the stdio MCP server; starts the local daemon if it is absent. |
| `browserpilot mcp --daemon-api <url> --token <token>` | Connect to a selected daemon; `CA_API_TOKEN` is also supported. |
| `browserpilot mcp config --client <name> [--wsl] [--daemon-api <url>] [--token <token>]` | Print a reusable generic MCP JSON configuration. |
| `browserpilot token create --name <name>` | Create a revocable remote MCP Token and show its plaintext once. |
| `browserpilot token list` | List Token IDs, names, and creation dates without plaintext. |
| `browserpilot token revoke --id <id>` | Revoke a Token immediately. |

## MCP tools

Run `npm run check:tools` for the complete list. Prefer an **observe → act → verify** flow and stable `node_id` or semantic targets over fragile CSS selectors.

| Category | Representative tools | Use |
| --- | --- | --- |
| Tabs | `browser_list_tabs`, `browser_create_tab`, `browser_claim_tab`, `browser_release_tab` | Inspect, create, and exclusively control tabs. |
| Navigation | `browser_navigate`, `browser_go_back`, `browser_reload` | Open pages and use browser history. |
| Observation | `browser_get_visible_dom`, `browser_get_dom_snapshot`, `browser_get_content` | Read structure, visible content, and state. |
| Interaction | `browser_click_node`, `browser_type_node`, `browser_click_role`, `browser_type_by_label` | Click and type by stable nodes or semantic targets. |
| Wait and images | `browser_wait_for_load`, `browser_wait_for_selector`, `browser_screenshot`, `browser_long_screenshot` | Wait for state transitions and inspect results. |
| Sensitive actions | `browser_execute`, `browser_close_tab` | Run page JavaScript or close a tab; both are gated by developer settings, approvals, and leases. |
| Tasks | `task_create`, `task_update`, `task_run`, `task_cancel`, `task_logs` | Manage, schedule, cancel, and audit local jobs. |
| Status | `system_status`, `browser_controller_config` | Inspect connection status and declare the current controller. |

Ordinary target-tab tools claim control before the first operation and keep the control banner visible until `browser_release_tab`, `browser_finalize_tabs`, user cancellation, connection shutdown, or lease expiry. During navigation, the banner is restored as soon as the new document starts and checked again when loading completes. `browser_navigate` creates a new tab when `tabId` is omitted so it cannot replace the page hosting an agent or the user's current work; an existing tab is reused only when its `tabId` is explicit. Screenshots return native MCP image content by default instead of placing Base64 in text. Pass `output: "file"` or `path` to save a local file. `path` may be absolute or relative to the MCP adapter working directory, and existing files are overwritten only with `overwrite: true`. Full-page screenshots always use scroll stitching and never trigger Chrome's native debugging banner; legacy `strategy: "debugger"` input safely falls back to stitching.

## Permissions and security

Every dashboard setting maps to browser execution:

- **Write-action approval** gates clicks, typing, page JavaScript, and closing tabs. Site exceptions only change this approval and never relax transfer policy.
- **Page JavaScript developer permission** rejects `browser_execute` when disabled; when enabled, write-action approval still applies.
- **Download policy** applies only to downloads initiated by BrowserPilot-controlled tabs. `always` permits, `ask` waits for approval, and `none` cancels. Timeout cancels by default.
- **Upload policy** runs before AI opens a file input. `always`, `ask`, and `none` determine whether the system file picker opens. The user still selects local files; timeout denies by default.
- **Remote authentication** protects every `/api` endpoint with a Token. The Web UI receives an HttpOnly, SameSite cookie only on loopback; remote MCP uses Bearer Tokens.

The extension uses permissions including `tabs`, `scripting`, `nativeMessaging`, and `downloads` to control the real browser. Install only trusted builds, do not expose the daemon on an untrusted network, and never store passwords or Tokens in task source.

## Architecture

```text
MCP client
  -> BrowserPilot MCP Adapter (stdio)
  -> daemon API / Token / approval and policy
  -> loopback WebSocket
  -> Chrome extension
  -> real Chrome tabs

Dashboard -> daemon API
Scheduler -> local task store -> same policy and browser execution path
```

BrowserPilot is designed to be local-first, explicit about remote exposure, observable before action, guarded for sensitive operations, and isolated across controller sessions through tab leases.

## Development deployment

Run from source:

```bash
git clone https://github.com/Puxora/BrowserPilot.git
cd BrowserPilot/orchestrator
npm ci
node bin/cli.js install
npm start
```

Load the repository-root `chrome-extension` in Chrome. During development run:

```bash
npm test
npm run test:coverage
npm run check:tools
npm audit --package-lock-only --audit-level=moderate
npm pack --dry-run
```

## Contributing, releases, and changes

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution flow and test expectations.
- Report vulnerabilities through [SECURITY.md](./SECURITY.md), not public issues.
- Follow [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
- See [CHANGELOG.md](./CHANGELOG.md) for released changes. Before publishing, run tests, audit, and `npm pack --dry-run`, then publish using semantic versioning.

Licensed under the [MIT License](./LICENSE).
