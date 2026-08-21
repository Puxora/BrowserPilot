# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，并采用 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.6] - 2026-08-21

### Added

- 截图工具支持 MCP 图片内容返回，以及由 Agent 指定绝对或相对路径保存本地文件。
- 新增受认证的全局设置局部更新接口，供 DSH 等受信任的本机集成同步权限且不覆盖站点例外。

### Changed

- 普通浏览器操作首次接管后持续显示控制提示栏，页面导航从新文档加载开始阶段立即恢复；明确释放、用户取消、连接结束或租约到期时再关闭。
- 长截图统一采用滚动拼接并移除扩展 debugger 权限，旧客户端传入 debugger 策略时也不会再触发 Chrome 原生调试提示栏。
- `browser_navigate` 未指定 `tabId` 时改为创建新标签页，避免覆盖 Agent 自身页面或用户当前活动页面。
- 所有普通与长截图统一经过全局节流队列（最少间隔 650ms）并对 Chrome 临时图像读回/额度错误退避重试，避免 `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` 限流。
- 长截图期间会临时隐藏 BrowserPilot 自绘提示条、指针及其页面占位空间，避免它们被重复拼接到截图中。

### Fixed

- 控制结束、扩展重载或 Chrome 重启时会幂等清理所有 BrowserPilot 控制态 favicon，并重新激活网页原图标，避免 Chrome favicon 缓存导致标签绿点遗留。

## [1.1.5] - 2026-08-20

### Changed

- 完善中英文卸载文档与 CLI 命令参考，明确 DSH 集成的清理顺序、残留原因和 `--purge` 数据边界。

## [1.1.4] - 2026-08-20

### Added

- 新增 `browserpilot uninstall`，可停止 daemon 并清理 BrowserPilot 创建的 Native Messaging 配置、Chrome 注册表项和桥接文件。
- 新增 `browserpilot uninstall --purge`，用于在显式确认下同时删除本地配置、Token、任务和日志。

## [1.1.3] - 2026-07-21

### Fixed

- 顶部调试控制栏的提示内容与取消按钮恢复整体居中，同时继续为网页内容预留独立空间。

## [1.1.2] - 2026-07-21

### Fixed

- 顶部调试控制栏改为紧凑左对齐布局，并持续为网页内容预留独立空间。
- 点击“取消”会中断当前操作、后续自动化步骤和关联定时任务，并释放控制租约。
- 修复部分网站监听键盘事件时逐字符输入被重复插入的问题。

## [1.1.1] - 2026-07-21

### Fixed

- 顶部可视化调试栏会按实际高度推动页面内容，并在调试结束后恢复原始布局，避免遮挡网页顶部区域。

## [1.1.0] - 2026-07-17

### Added

- 可创建、列出和撤销的远程 MCP Token。
- WSL/跨主机 MCP 配置中的 `CA_API_TOKEN` 支持。
- API 全量认证、文件选择器审批与受控标签页下载策略。
- MIT 协议、贡献指南和安全策略。
- Windows CI、Native Relay Host 可复现构建检查和 npm Trusted Publishing 工作流。

### Changed

- 下载审批超时从自动放行改为默认取消。
- 标签关闭纳入高风险操作审批。
- npm lockfile 改为使用 npm 官方 registry。
- 正式源码仓库迁移至 `Puxora/BrowserPilot`，npm 包迁移至 `@puxora/browserpilot`。

### Removed

- 清理本机路径、无效调试截图和备份文件。

## [1.0.2] - 2026-07-16

### Added

- 新增 `browserpilot --version`、`browserpilot -v` 和 `browserpilot version`。

## [1.0.1] - 2026-07-16

### Added

- 新增 daemon 后台启动、停止、重启和状态管理命令。

## [1.0.0] - 2026-07-03

### Added

- 初始 BrowserPilot daemon、Chrome 扩展、MCP adapter 和本地任务调度能力。
