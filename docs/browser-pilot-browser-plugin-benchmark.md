# BrowserPilot 与 Codex 内置浏览器插件能力对标

## 1. 目标

本文对标 Codex 内置浏览器插件的实际运行时能力，梳理 BrowserPilot 已满足、待补齐和可超越的方向。

对标目标不是逐字复刻内置插件，而是吸收其稳定交互方法，并发挥 BrowserPilot 控制真实 Chrome、可视化提示、安全审批和任务调度的本地插件优势。

## 2. 内置浏览器插件的关键做法

内置浏览器插件的优势主要体现在四类能力：

1. **多层操作面**
   - Tab 基础操作：新建、关闭、前进、后退、刷新、URL、标题、截图。
   - DOM CUA：基于可见 DOM 的 node_id 点击、输入、滚动、快捷键。
   - Playwright-like API：`domSnapshot`、locator、role/label/text/testId、frame locator、导航期望、URL 等待、加载状态等待。
   - CUA 坐标层：点击、双击、拖拽、滚动、键盘、鼠标移动。

2. **强 locator 纪律**
   - 优先 `data-testid`、稳定 `data-*`、稳定 `href`。
   - 其次用 scoped role/name、text、CSS selector。
   - 行动前确认 locator 唯一性，失败后重新 snapshot，不反复重试旧 locator。

3. **观察与等待纪律**
   - 操作前基于最新可见 DOM 或截图确认页面状态。
   - 操作后只做必要的最小验证。
   - 避免固定 sleep，优先等待具体 URL、加载状态、元素状态或导航事件。

4. **辅助能力**
   - 剪贴板读写。
   - console log 读取。
   - JavaScript dialog 处理。
   - viewport/visibility 控制。
   - page assets 收集。
   - iframe 范围 locator。

## 3. BrowserPilot 当前已满足的能力

### 3.1 标签页与导航

已具备：

- `browser_list_tabs`
- `browser_create_tab`
- `browser_claim_tab`
- `browser_release_tab`
- `browser_close_tab`
- `browser_finalize_tabs`
- `browser_navigate`
- `browser_go_back`
- `browser_go_forward`
- `browser_reload`

优势：

- 操作的是真实用户 Chrome，而不是应用内浏览器。
- `claim/release/finalize` 有明确控制生命周期。
- 页面提示条能让用户知道 AI 正在控制浏览器。

### 3.2 观察与截图

已具备：

- `browser_get_visible_dom`
- `browser_get_dom_snapshot`
- `browser_get_content`
- `browser_screenshot`
- `browser_long_screenshot`

优势：

- 长截图支持 fullPage 优先、失败后滚动拼接。
- 可见 DOM 直接返回 node_id，适合 Agent 做 observe-act-check。

### 3.3 交互

已具备：

- `browser_click_node`
- `browser_type_node`
- `browser_click_text`
- `browser_click_role`
- `browser_type_by_label`
- `browser_click`
- `browser_type`
- `browser_scroll`

优势：

- 鼠标和输入动作带人类化延迟与可视化指针。
- 支持同源 iframe 的部分 CSS 查找。

### 3.4 等待

已具备：

- `browser_wait_for_load`
- `browser_wait_for_navigation`
- `browser_wait_for_selector`

待增强：

- 缺少等待元素状态：visible/hidden/attached/detached。
- 缺少组合式“执行动作并期待导航”工具。

### 3.5 安全与任务

已具备：

- `browser_execute` 受开发者模式开关控制。
- 敏感操作审批。
- 下载拦截审批。
- 定时任务：`task_create/list/get/update/delete/run/logs`。
- `system_status`。

优势：

- 这是 BrowserPilot 最容易超越内置浏览器插件的方向：本地自动化任务、安全策略、审批中心、下载管控和可视化控制状态可以形成完整产品能力。

## 4. 当前差距清单

### P0：稳定性补齐

1. `browser_go_back` / `browser_go_forward`
   - 需要保证真实 Chrome 历史导航可用。
   - 无历史时返回友好中文错误。

2. `browser_wait_for_selector`
   - 可见性判断应覆盖 `body`、根级容器、fixed/sticky 元素。

3. `browser_close_tab`
   - 缺少 `tabId` 时必须返回友好错误，不透出 Chrome API 签名错误。

### P1：对标内置插件的高价值工具

建议优先新增：

1. `browser_get_console_logs`
   - 对标 `tab.dev.logs`。
   - 支持 `levels`、`limit`、`filter`。
   - 用于调试本地 Web 应用和页面错误。

2. `browser_clipboard_read_text` / `browser_clipboard_write_text`
   - 对标 `tab.clipboard.readText/writeText`。
   - 写入剪贴板属于敏感操作，应走审批或明确安全说明。

3. `browser_click_testid` / `browser_type_testid`
   - 对标 `getByTestId`。
   - 适合测试工程和现代前端应用。

4. `browser_wait_for_element_state`
   - 支持 `state: visible | hidden | attached | detached`。
   - 比单纯 selector 等待更接近 Playwright 的稳定等待模型。

5. `browser_expect_navigation`
   - 输入：`action` 或简化为“记录当前 URL 后等待变化/匹配”。
   - 用于替代点击后手写 `wait_for_navigation` 的易错流程。

### P2：能力增强

1. `browser_get_accessibility_snapshot`
   - 输出 role/name/state，用于更稳的语义定位。

2. iframe 增强
   - DOM snapshot 明确输出 frame 层级。
   - 支持 frame-scoped selector / role / text / testId。

3. JavaScript dialog 工具
   - `browser_get_dialog`
   - `browser_accept_dialog`
   - `browser_dismiss_dialog`
   - prompt 支持传入文本。

4. viewport 工具
   - `browser_set_viewport`
   - `browser_reset_viewport`
   - 用于响应式验证。

5. page assets 工具
   - 收集当前页图片、视频、样式、脚本等资源 URL。
   - 可选打包为本地临时文件。

6. 坐标层增强
   - double click、drag、keypress、mouse move。
   - 适合 canvas、复杂编辑器、地图和拖拽 UI。

## 5. BrowserPilot 可以超越的方向

### 5.1 真实 Chrome 自动化产品化

内置浏览器插件偏“会话内操作”，BrowserPilot 可以继续强化：

- 持久任务调度。
- 审批中心。
- 下载安全策略。
- 用户可见控制条。
- 任务运行日志和回放。
- 站点级权限策略。

### 5.2 安全策略更细

可增强：

- 按站点、动作、数据类型设置审批策略。
- 剪贴板、下载、上传、表单提交分级审批。
- 对 `browser_execute` 增加只读模式或 allowlist。
- 敏感字段识别：password、token、OTP、payment、address。

### 5.3 面向 Agent 的工具纪律内建

把内置插件文档里的交互纪律变成工具层能力：

- 操作前自动校验 node_id 是否来自最新 snapshot。
- locator 多匹配时返回候选列表，不直接点击第一个。
- 点击/输入失败时返回“建议重新 snapshot”的结构化错误。
- 文档中明确 locator 优先级：testId > data-* > href > role/name > text > CSS > 坐标。

### 5.4 本地开发调试闭环

BrowserPilot 可以面向本地开发场景提供：

- console logs。
- network error 摘要。
- screenshot + visible DOM + console logs 一键诊断包。
- localhost 页面热更新后自动 reload + 验证。

## 6. 建议迭代顺序

1. 修复并验收当前 P0 稳定性问题。
2. 新增 `browser_get_console_logs`。
3. 新增 `browser_click_testid` / `browser_type_testid`。
4. 新增剪贴板文本读写，并接入安全审批。
5. 新增 `browser_wait_for_element_state`。
6. 增强 iframe snapshot 与 frame-scoped 操作。
7. 增加 dialog、viewport、page assets、坐标层高级动作。

## 7. 文档与 Skill 建议

`skills/control-browser-pilot/SKILL.md` 应吸收以下原则：

- 永远优先 observe-act-check。
- 操作前优先 `browser_get_visible_dom` 或 `browser_get_dom_snapshot`。
- locator 优先级：node_id / testId / role / label / text / CSS。
- 点击、输入、滚动后只做必要的最小验证。
- 失败后重新观察，不重复执行同一个失败 locator。
- 关闭标签、执行 JS、剪贴板写入、下载、上传、提交表单均属于高风险动作。
