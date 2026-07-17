# 安全策略

## 支持范围

当前主分支和最新 npm 正式版本接受安全修复。请不要在公开 Issue 中披露可利用的 Token、远程访问、Native Messaging 或浏览器数据泄露细节。

## 报告漏洞

请通过 [GitHub Private Vulnerability Reporting](https://github.com/Puxora/BrowserPilot/security/advisories/new) 报告，并提供：受影响版本、复现步骤、影响范围和建议修复方向。维护者会尽量在 5 个工作日内确认报告，完成评估、修复后在发布说明中致谢（除非你要求匿名）。

## 部署要求

- daemon 默认仅监听 `127.0.0.1`；不要将其暴露到不可信网络。
- 非 loopback 监听必须显式设置 `CA_API_TOKEN`、`CA_TRUSTED_HOSTS`、`CA_TRUSTED_ORIGINS`，并限制防火墙来源。
- 使用 `browserpilot token create` 为 WSL、容器和自动化客户端创建独立 Token；不再使用时立即撤销。
- 不要在任务源码、日志、Issue、截图或共享 MCP 配置中保存 Token、密码或私密页面数据。
- 仅安装可信来源的扩展和 npm 包。Native Messaging Host 能在本机启动进程，必须视为高权限组件。

## 权限模型

BrowserPilot 需要 Chrome 的标签页、脚本注入、Native Messaging、下载和通知能力来执行其核心功能。页面 JavaScript、标签关闭、下载和文件选择器均受本地策略控制；审批超时默认拒绝。
