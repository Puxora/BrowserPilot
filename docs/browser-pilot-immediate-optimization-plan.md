# BrowserPilot 即刻优化开发计划

## 1. 目标

本文档用于指导 BrowserPilot 下一轮马上需要开展的优化开发。范围限定为当前能力评估后已经明确的缺口，不展开长期路线图。

本轮目标：

1. 补齐底层已有但 MCP 未暴露的浏览器工具。
2. 修正协议声明、扩展实现、MCP 工具、README 和 Skill 文档之间的不一致。
3. 提升插件与 Codex 内置浏览器插件相近的基础体验。
4. 保持改动小步可验收，避免一次性重构。

## 2. 当前能力结论

当前 MCP adapter 已能正常发现 35 个工具，主链路能力已经可用：

- 浏览器基础操作：导航、点击、输入、滚动、截图、长截图、页面内容读取。
- 标签页主流程：列出标签、新建标签、接管标签、释放标签、收尾释放或关闭指定标签。
- DOM 定位增强：可见 DOM 快照、完整 DOM 快照、node_id 点击/输入、文本点击、role 点击、label 输入。
- 页面等待：等待加载完成、等待 URL 导航。
- 可视化调试：开启、关闭、更新状态。
- 任务管理：创建、列表、详情、更新、删除、运行、日志。
- 安全能力：敏感操作审批、下载拦截、`execute` 受开发者模式配置控制。

因此本轮不是重做插件，而是补齐能力闭环。

## 3. 优先级总览

| 优先级 | 优化项 | 目标 |
| --- | --- | --- |
| P0 | 暴露 `browser_wait_for_selector` | 让 Agent 能等待页面元素出现，减少固定等待 |
| P0 | 暴露 `browser_close_tab` | 给新建标签提供明确关闭入口 |
| P0 | 处理 `goForward` 不一致 | 补齐前进能力或移除协议占位 |
| P1 | 同步 README 与 Skill 工具清单 | 避免用户和 Agent 被过期文档误导 |
| P1 | 补充 MCP 工具发现与验收脚本 | 每次改工具后可快速确认工具列表 |
| P2 | 梳理与内置浏览器插件的能力差距 | 作为后续迭代输入，不阻塞本轮 |

## 4. P0：暴露 `browser_wait_for_selector`

### 背景

`waitForSelector` 已在底层存在：

- `chrome-extension/background.js` 已转发 `waitForSelector`。
- `chrome-extension/content.js` 已实现 `waitForSelector(selector, timeoutMs)`。
- `orchestrator/src/task-engine.js` 的 `wait` 步骤在传入 selector 时已经调用该能力。

但 MCP adapter 未暴露 `browser_wait_for_selector`，导致 Agent 只能通过任务 YAML 间接使用，无法在交互式浏览器控制中直接等待元素。

### 开发任务

1. 在 `orchestrator/mcp-adapter.js` 的 `TOOLS` 中新增 `browser_wait_for_selector`。
2. 在 `BROWSER_ACTION_MAP` 中新增映射：
   - `browser_wait_for_selector` -> `waitForSelector`
3. 输入参数建议：
   - `selector`: string，必填。
   - `timeoutMs`: number，可选，默认由底层处理。
   - `tabId`: number，可选。

### 验收标准

1. `tools/list` 能看到 `browser_wait_for_selector`。
2. 在普通页面等待已存在元素时返回 `found: true`。
3. 等待不存在元素且超时后返回 `found: false`，不导致 MCP adapter 崩溃。
4. 文档中明确该工具优先于固定 `wait` 时间。

## 5. P0：暴露 `browser_close_tab`

### 背景

底层已实现 `closeTab`：

- `orchestrator/src/protocol.js` 声明了 `closeTab`。
- `chrome-extension/background.js` 已处理 `closeTab`。
- `browser_finalize_tabs` 已能通过 `closeTabIds` 关闭标签。

但没有独立的 MCP 工具 `browser_close_tab`。Agent 新建标签后，如果只想关闭一个标签，需要借助 `browser_finalize_tabs`，语义不够直接。

### 开发任务

1. 在 `orchestrator/mcp-adapter.js` 的 `TOOLS` 中新增 `browser_close_tab`。
2. 在 `BROWSER_ACTION_MAP` 中新增映射：
   - `browser_close_tab` -> `closeTab`
3. 输入参数建议：
   - `tabId`: number，必填。
4. 工具描述必须强调谨慎关闭用户页面，优先关闭由本次任务创建的标签。

### 验收标准

1. `tools/list` 能看到 `browser_close_tab`。
2. 通过 `browser_create_tab` 新建标签后，可用 `browser_close_tab` 关闭。
3. 未传 `tabId` 时应返回友好错误，不应误关当前活动标签。
4. Skill 文档中注明关闭标签属于有副作用操作，使用前需确认是否是任务创建的标签。

## 6. P0：处理 `goForward` 不一致

### 背景

`orchestrator/src/protocol.js` 中声明了 `goForward`，但当前未看到完整实现和 MCP 暴露。该状态容易造成维护误判：协议看起来支持前进，实际工具不可用。

### 可选方案

方案 A：补齐前进能力，推荐。

1. 在 `chrome-extension/background.js` 中实现 `handleGoForward(tabId)`。
2. 使用 Chrome Tabs API 的前进能力。
3. 在 `handleCommand` 中新增 `goForward` 分支。
4. 在 `orchestrator/mcp-adapter.js` 中新增 `browser_go_forward`。
5. 在 `BROWSER_ACTION_MAP` 中映射：
   - `browser_go_forward` -> `goForward`

方案 B：移除占位。

1. 从 `orchestrator/src/protocol.js` 移除 `goForward`。
2. README 和 Skill 不写前进能力。

### 推荐

采用方案 A。原因是内置浏览器插件具备 tab 前进/后退，BrowserPilot 已有 `browser_go_back`，补齐 `browser_go_forward` 能形成自然闭环。

### 验收标准

1. `browser_go_forward` 出现在 MCP 工具列表中。
2. 在有前进历史的标签页中调用成功，并返回当前 URL 与标题。
3. 在没有前进历史时返回友好错误，不导致扩展或 daemon 崩溃。

## 7. P1：同步 README 与 Skill 工具清单

### 背景

当前 README 工具清单落后于实际 MCP 工具。Skill 文档较新，但也未覆盖所有当前工具和待补工具。文档不一致会直接影响 Agent 使用策略，也会影响用户判断插件是否安装成功。

### 开发任务

1. 更新 `README.md` 的 MCP 工具列表。
2. 更新 `skills/control-browser-pilot/SKILL.md` 的推荐工具列表。
3. 按类别整理工具，不只按历史新增顺序堆叠。
4. 明确推荐流程：
   - `browser_list_tabs`
   - `browser_create_tab` 或 `browser_claim_tab`
   - `browser_get_visible_dom`
   - `browser_click_node` / `browser_type_node`
   - 操作后观察
   - `browser_release_tab` / `browser_close_tab` / `browser_finalize_tabs`

### 建议工具分类

- 标签页：`browser_list_tabs`、`browser_create_tab`、`browser_claim_tab`、`browser_release_tab`、`browser_close_tab`、`browser_finalize_tabs`
- 导航：`browser_navigate`、`browser_go_back`、`browser_go_forward`、`browser_reload`
- 等待：`browser_wait_for_load`、`browser_wait_for_navigation`、`browser_wait_for_selector`
- 观察：`browser_get_visible_dom`、`browser_get_dom_snapshot`、`browser_get_content`、`browser_screenshot`、`browser_long_screenshot`
- 交互：`browser_click_node`、`browser_type_node`、`browser_click_text`、`browser_click_role`、`browser_type_by_label`、`browser_click`、`browser_type`、`browser_scroll`
- 高权限：`browser_execute`
- 可视化：`browser_visual_start`、`browser_visual_update`、`browser_visual_stop`
- 任务：`task_create`、`task_list`、`task_get`、`task_update`、`task_delete`、`task_run`、`task_logs`
- 状态：`system_status`

### 验收标准

1. README、Skill 和 MCP adapter 的工具清单一致。
2. 文档明确 node_id 工具优先，CSS selector 工具作为补充。
3. 文档明确关闭标签、执行 JS、提交表单、下载等属于高风险操作。

## 8. P1：补充工具发现验收脚本

### 背景

MCP 工具改动后，需要快速确认 adapter 能正常启动、`tools/list` 正常返回、工具数量和名称符合预期。

### 开发任务

1. 在 `orchestrator` 下新增一个轻量检查脚本，例如 `scripts/check-mcp-tools.js`。
2. 脚本通过 stdio 启动 `orchestrator/mcp-adapter.js`。
3. 发送 `initialize` 和 `tools/list` 请求。
4. 输出工具数量和工具名。
5. 若缺少必需工具，退出码为非 0。

### 必需工具清单

本轮完成后至少包含：

- `browser_wait_for_selector`
- `browser_close_tab`
- `browser_go_forward`
- `browser_create_tab`
- `browser_get_visible_dom`
- `browser_click_node`
- `browser_type_node`
- `browser_visual_start`
- `browser_finalize_tabs`
- `system_status`

### 验收标准

1. 执行脚本能打印工具数量。
2. 缺少 P0 工具时脚本失败。
3. 脚本不要求 daemon 和 Chrome 已连接，因为它只验证 MCP 工具发现。

## 9. P2：后续能力差距记录

这些能力不建议塞进本轮 P0，但应记录为后续方向：

1. 剪贴板工具：
   - 读取文本剪贴板。
   - 写入文本剪贴板。
   - 注意敏感数据确认。

2. 控制台日志读取：
   - 获取当前标签页 console error/warn/log。
   - 用于调试本地 Web 应用。

3. 更细的 locator 能力：
   - 类似 Playwright 的 role/name/label/testId 定位。
   - 当前已有 role、label 和文本工具，后续可补 testId。

4. iframe 支持增强：
   - 当前 content script 对同源 iframe 有有限支持。
   - 后续可考虑跨 frame 快照结构和 frame 级操作。

5. 可视化取消后的任务级中断：
   - 当前取消按钮更偏 UI 层。
   - 后续应让 scheduler/task-engine 支持 abort signal。

## 10. 建议开发顺序

1. 先补 `browser_wait_for_selector`。
2. 再补 `browser_close_tab`。
3. 再实现或清理 `goForward`，推荐实现 `browser_go_forward`。
4. 跑 MCP 工具发现检查，确认工具列表。
5. 更新 README 与 Skill。
6. 用真实 Chrome 标签页做端到端验证。

## 11. 端到端验收流程

建议用一个普通网页执行以下流程：

1. `browser_create_tab` 打开 `https://example.com`。
2. `browser_wait_for_load` 等待加载。
3. `browser_get_visible_dom` 获取可见 DOM。
4. `browser_wait_for_selector` 等待 `body`。
5. `browser_go_back` 在有历史时验证后退。
6. `browser_go_forward` 验证前进。
7. `browser_screenshot` 验证截图仍可用。
8. `browser_close_tab` 关闭由步骤 1 创建的标签。
9. `tools/list` 确认新增工具可发现。

## 12. 完成定义

本轮优化完成需同时满足：

1. P0 三项全部完成。
2. README 与 Skill 的工具清单和实际 MCP 工具一致。
3. MCP 工具发现检查通过。
4. 不破坏现有 35 个工具。
5. 对不可用页面、缺失 tabId、无前进历史等情况返回友好错误。
6. 没有引入大范围重构。
