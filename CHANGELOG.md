# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，并采用 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
