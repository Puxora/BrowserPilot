# BrowserPilot 可视化调试能力开发计划

## 1. 背景与目标

目标是在 BrowserPilot 中实现类似 Codex Chrome 控制时的两类视觉效果：

1. 页面顶部调试提示条：例如 `"Codex" 已开始调试此浏览器`，并提供取消/停止按钮。
2. 页面内自动化指针：一个带蓝色光晕的鼠标指针，必须接入真实动作执行链路，在点击、输入、滚动等动作发生前像人工鼠标一样移动到目标位置，并与实际事件触发保持同步。

该能力主要用于让用户直观看到当前浏览器正在被自动化控制，减少“后台偷偷操作”的不透明感，同时方便开发者调试任务执行步骤。注意：光标不是装饰层，它是 `humanClick`、`humanType`、`humanScroll` 等动作的可视化前置步骤和状态反馈。

## 2. 现有架构分析

当前项目链路如下：

```text
MCP Adapter / Web UI
  -> Express REST API
  -> BrowserWsServer
  -> Native Relay
  -> Chrome Extension background.js
  -> content.js
  -> 页面 DOM
```

关键文件：

- `chrome-extension/background.js`
  - `handleCommand` 在第 145 行附近分发浏览器动作。
  - `executeInTab` 在第 210 行附近向 content script 转发 `click/type/scroll/getContent/execute/waitForSelector`。
  - `handleListTabs` 在第 238 行附近列出标签页。
  - `getConnectionStatus` 在第 347 行附近给 popup 返回连接状态。

- `chrome-extension/content.js`
  - `humanClick` 在第 77 行附近实现点击。
  - `humanType` 在第 116 行附近实现输入.
  - `humanScroll` 在第 162 行附近实现滚动。
  - `handleAction` 在第 250 行附近分发页面内动作。

- `orchestrator/src/ws-server.js`
  - `sendCommand` 在第 48 行附近向 Chrome 发送命令。
  - `_handleMessage` 在第 124 行附近处理 Chrome 返回结果。

- `orchestrator/src/web-server.js`
  - `/api/status` 在第 51 行附近。
  - `/api/browser/:action` 在第 245 行附近。

- `orchestrator/mcp-adapter.js`
  - `TOOLS` 在第 14 行附近。
  - `browserActions` 在第 287 行附近。

当前缺口：

- content script 只执行 DOM 操作，没有统一的 overlay UI。
- 页面内没有“视觉鼠标”和“事件鼠标”的同步机制。现在 `humanClick` 会直接派发 DOM 事件，用户无法看到鼠标逐步移向目标。
- background 只做命令转发，没有“自动化会话开始/结束/取消”的状态模型。
- orchestrator 只知道 Chrome 是否连接，不知道当前是否正在自动化控制某个 tab。
- MCP 和 Web UI 没有提供开启/关闭可视化调试的工具或开关。

## 3. 推荐实现方案

采用“扩展侧注入视觉层 + 现有协议下发控制命令”的方案，不引入额外浏览器自动化框架。

核心设计：

1. 在 `content.js` 中新增一个独立的 `VisualOverlayController`。
2. 所有视觉 DOM 均使用固定前缀 id/class，例如 `ca-visual-overlay-*`，避免污染业务页面。
3. 顶部提示条和光晕指针都插入到页面 `document.documentElement` 下，使用 `position: fixed`、超高 `z-index` 和 `pointer-events: none`。
4. 取消按钮需要允许点击，因此按钮区域单独设置 `pointer-events: auto`。
5. background 新增 `visualStart`、`visualStop`、`visualUpdate`、`visualPointerMove` 等 action。
6. 在现有 `click/type/scroll` 执行动作时，content script 必须先驱动 overlay 指针完成移动动画，再派发真实 DOM 事件，保证用户看到的鼠标位置和页面收到的事件坐标一致。
7. orchestrator/MCP 只负责透传和提供开关，不需要理解页面视觉细节。

需要明确区分两层：

- 视觉鼠标：页面 overlay 中的指针 DOM，用户能看到。
- 事件鼠标：`PointerEvent` / `MouseEvent` 中的 `clientX`、`clientY` 等坐标，页面能接收到。

两者必须同步。点击按钮时，流程应是“视觉鼠标移动到按钮中心附近 -> 视觉鼠标按下反馈 -> 页面收到 pointerdown/mousedown -> 页面收到 pointerup/mouseup/click -> 视觉鼠标点击脉冲”，不能出现按钮已经被点击但视觉鼠标还停在别处的割裂感。

## 4. 协议设计

建议新增浏览器动作：

```text
visualStart
visualStop
visualUpdate
visualPointerMove
visualPointerPulse
```

参数建议：

```json
{
  "visualStart": {
    "label": "Claude",
    "message": "\"Claude\" 已开始调试此浏览器",
    "showCancel": true,
    "theme": "light",
    "cursor": true
  }
}
```

```json
{
  "visualUpdate": {
    "message": "正在点击：登录按钮",
    "state": "running"
  }
}
```

```json
{
  "visualPointerMove": {
    "x": 640,
    "y": 360,
    "duration": 280
  }
}
```

```json
{
  "visualStop": {
    "reason": "completed"
  }
}
```

取消按钮事件建议：

- content script 点击取消按钮后，向 background 发送 `{ source: 'visualOverlay', type: 'cancelRequested', tabId }`。
- background 再转发给 native/orchestrator，或至少本地设置 tab 的 cancelled 状态。
- 第一版可以只实现隐藏 overlay 并返回“用户已取消”的错误，第二版再做任务级中断。

## 5. 文件级开发步骤

### 阶段一：content script 视觉层

修改 `chrome-extension/content.js`：

1. 新增常量：
   - `OVERLAY_ROOT_ID`
   - `OVERLAY_STYLE_ID`
   - `POINTER_ID`
   - `BANNER_ID`

2. 新增 `VisualOverlayController`：
   - `ensureStyle()`
   - `start(options)`
   - `stop(reason)`
   - `update(options)`
   - `movePointer(x, y, options)`
   - `movePointerHumanLike(x, y, options)`
   - `pointerDown()`
   - `pointerUp()`
   - `pulsePointer(options)`
   - `showActionHint(text)`

3. CSS 要点：
   - 顶部提示条 fixed top。
   - 指针 fixed，默认 `transform: translate3d(x, y, 0)`。
   - 光晕使用 `box-shadow` 或伪元素。
   - 尊重 `prefers-reduced-motion`。
   - overlay 的 root 使用 `all: initial` 降低页面 CSS 污染。

4. 在 `handleAction` 中加入新 action：
   - `visualStart`
   - `visualStop`
   - `visualUpdate`
   - `visualPointerMove`
   - `visualPointerPulse`

5. 将现有动作接入视觉反馈，并把它作为动作执行流程的一部分：
   - `humanClick` 找到元素后，先将页面滚到目标可见，再计算目标点击坐标，然后用人类轨迹移动指针到目标中心附近，最后才派发鼠标事件序列，点击后 pulse。
   - `humanType` 聚焦输入框前移动到输入框中心或输入框左侧可输入位置，视觉上表现为鼠标先选中输入框，再开始输入。
   - `humanScroll` 开始前将指针移动到页面中部或滚动容器中部，显示滚动提示，再执行逐帧滚动。

6. 新增动作坐标工具函数：
   - `getElementTargetPoint(el, options)`：根据元素 rect 返回适合点击的位置，默认元素中心，允许 1-3px 随机偏移。
   - `getViewportSafePoint(x, y)`：确保坐标落在 viewport 内，避免指针跑出屏幕。
   - `dispatchPointerSequence(el, point)`：统一派发 `pointerdown/mousedown/pointerup/mouseup/click`。

7. 指针移动不能瞬移。建议使用 `requestAnimationFrame` 按路径移动：
   - 起点为上一次指针位置。
   - 终点为目标元素点击位置。
   - 距离越远，动画耗时越长，建议 180-900ms。
   - 路径使用二次/三次贝塞尔曲线。
   - 中途加入极小随机抖动，但终点必须准确落在事件坐标附近。
   - 支持 `prefers-reduced-motion`，用户减少动画时缩短移动时间。

注意：不要在 content script 顶层暴露全局变量；可以封装在 IIFE 内部。

### 阶段二：background 动作转发

修改 `chrome-extension/background.js`：

1. 在 `handleCommand` 的 switch 中加入：
   - `visualStart`
   - `visualStop`
   - `visualUpdate`
   - `visualPointerMove`
   - `visualPointerPulse`

2. 这些 action 走 `executeInTab(tabId, { action, params })`。

3. 可选：维护 `activeAutomationTabs`：
   - key: tabId
   - value: `{ startedAt, label, cancelled }`

4. 支持取消按钮：
   - 在 `chrome.runtime.onMessage` 中处理 `{ source: 'visualOverlay', type: 'cancelRequested' }`。
   - 第一版可以给 content script 回 `{ ok: true }`，并向 Native 发送一个 `event` 类型消息。

### 阶段三：协议与 API

修改 `orchestrator/src/protocol.js`：

1. `BROWSER_ACTIONS` 加入新增 visual action。

修改 `orchestrator/src/web-server.js`：

1. `/api/browser/:action` 可以继续复用，无需新路由。
2. 如要管理会话状态，可新增：
   - `POST /api/visual/start`
   - `POST /api/visual/stop`
   - `GET /api/visual/status`

第一版建议复用 `/api/browser/visualStart`、`/api/browser/visualStop`，减少改动。

### 阶段四：MCP 工具

修改 `orchestrator/mcp-adapter.js`：

1. 在 `TOOLS` 中新增：
   - `browser_visual_start`
   - `browser_visual_stop`
   - `browser_visual_update`

2. 在 `browserActions` 中加入这些工具。

3. 映射规则：
   - `browser_visual_start` -> `/api/browser/visualStart`
   - `browser_visual_stop` -> `/api/browser/visualStop`
   - `browser_visual_update` -> `/api/browser/visualUpdate`

注意：当前简单 `replace('browser_', '')` 映射不适合下划线 action，建议改成显式 map：

```text
browser_navigate -> navigate
browser_get_content -> getContent
browser_visual_start -> visualStart
browser_visual_stop -> visualStop
browser_visual_update -> visualUpdate
```

### 阶段五：Web UI 调试入口

修改 `orchestrator/web-ui/app.js` 和 `orchestrator/web-ui/style.css`：

1. 在浏览器测试页增加：
   - “开启可视化调试”按钮
   - “关闭可视化调试”按钮
   - “移动指针测试”按钮
   - “滚动测试”按钮

2. 测试流程：
   - 点击开启：调用 `/api/browser/visualStart`
   - 点击移动：调用 `/api/browser/visualPointerMove`
   - 点击关闭：调用 `/api/browser/visualStop`

3. UI 仅用于调试，不影响任务调度。

### 阶段六：任务自动包裹

修改 `orchestrator/src/task-engine.js`：

1. 在 `execute(task)` 开始时，如果配置开启可视化：
   - 调用 `visualStart`

2. 每一步执行前调用：
   - `visualUpdate({ message: "正在执行第 N 步：click" })`

3. 结束时：
   - 成功：`visualStop({ reason: "completed" })`
   - 失败：`visualUpdate({ state: "error", message: err.message })`，短暂停留后 `visualStop`

4. 配置项建议：

```yaml
options:
  visualDebug: true
  visualLabel: Claude
```

默认可设为 false，避免定时任务无人值守时影响页面。

## 6. 视觉细节建议

### 顶部提示条

样式目标：

- 固定在页面顶部，宽度 100%。
- 背景白色或根据系统主题。
- 文案居中。
- 右侧或文案旁有蓝色“取消”按钮。
- 高度约 44-56px。
- `z-index` 建议 `2147483646`。

### 光晕指针

样式目标：

- 使用 CSS 绘制，不依赖图片。
- 箭头可以用 `clip-path: polygon(...)` 或内联 SVG。
- 光晕使用径向渐变背景：
  - 中心亮蓝
  - 外圈透明
- 指针 root 设置 `pointer-events: none`。
- 移动使用 `transition: transform 180ms ease-out` 或 JS requestAnimationFrame。

行为目标：

- 指针必须记录当前坐标，下一次移动从当前位置开始。
- 第一次显示时可以从视口中心或目标附近淡入，避免从 `(0, 0)` 突兀飞入。
- 鼠标按下时指针应有轻微缩放或阴影变化。
- 鼠标抬起后恢复，并触发点击脉冲。
- 如果目标元素需要先滚动到可见区域，应先滚动页面，再移动指针到滚动后的元素坐标。

### 点击反馈

- 点击时在指针中心产生一个圆形扩散动画。
- 动画 300-500ms 自动消失。

### 滚动反馈

- 滚动时在指针旁显示短文案，例如“向下滚动”。
- 500-800ms 后淡出。

## 7. 兼容性与风险

1. `chrome://`、Chrome Web Store、扩展页面、本地 PDF 等页面可能无法注入 content script。
   - 需要返回友好错误：当前页面不支持可视化调试。

2. 某些网站 CSP 不影响 content script 注入的 CSS/DOM，但页面极端样式可能污染 overlay。
   - 使用 shadow DOM 更稳；第一版可不用，第二版建议迁移到 shadow root。

3. SPA 页面跳转后 overlay DOM 可能被页面重绘影响。
   - 每次 action 前调用 `ensureOverlay()`。

4. 多标签页同时自动化时需要按 tabId 隔离状态。
   - background 可维护 tabId 状态；content script 本身天然按页面隔离。

5. 取消按钮的任务中断是跨层能力。
   - 第一版只做 UI 隐藏和事件上报。
   - 第二版再让 scheduler/task-engine 支持 abort signal。

## 8. 验收标准

1. 在任意普通网页调用 `browser_visual_start` 后，页面顶部出现提示条和取消按钮。
2. 调用 `browser_visual_stop` 后，提示条和指针全部移除。
3. 执行 `browser_click` 时，指针先以可见动画移动到目标元素中心附近，然后页面才收到点击事件，并出现点击脉冲。
4. 执行 `browser_scroll` 时，指针先移动到页面或滚动容器中部，再滚动页面，同时能看到滚动提示或指针状态变化。
5. 执行 `browser_type` 时，指针先移动到输入框附近，输入框获得焦点后再开始逐字符输入。
6. 不影响原有 `click/type/scroll/screenshot/getContent/listTabs` 功能。
7. 在不可注入页面返回明确错误，不导致 background 崩溃。
8. Web UI 可以手动开启/关闭可视化调试。
9. MCP 工具列表能看到新增 visual 工具，并能通过 Claude 调用。
10. 截图或肉眼观察时，不能出现“按钮已点击但指针还在远处”的不同步现象。

## 9. 建议交给 Claude 的开发顺序

1. 先实现 `content.js` 的 overlay controller，并用 `browser_execute` 或手动 action 验证 DOM 效果。
2. 再接入 background 的 visual action 转发。
3. 再补 protocol 和 MCP tool 映射。
4. 最后做 Web UI 按钮和 task-engine 自动包裹。
5. 每完成一阶段都用真实 Chrome 标签页验证一次，避免最后端到端排查困难。

## 10. 最小可行版本范围

MVP 只做以下内容即可：

1. `visualStart`
2. `visualStop`
3. `humanClick` 自动移动指针、按下反馈、事件派发和点击脉冲，并保证视觉坐标与事件坐标一致。
4. `humanScroll` 先移动指针到滚动区域，再显示滚动提示并执行滚动。
5. MCP 新增 `browser_visual_start` / `browser_visual_stop`

暂缓内容：

1. 取消按钮真正中断任务。
2. 多任务并发状态面板。
3. shadow DOM 隔离。
4. 高级鼠标轨迹拟人化。
