# Puxora 开源迁移记录

日期：2026-07-17

## 决策

- `pulab-dev` 作为开发账号，`Puxora` 作为独立发布账号和正式公开仓库所有者，两个 GitHub 账号不建立组织关联。
- npm 使用 `puxora` 发布账号持有 `@puxora` scope。
- 正式 npm 包迁移为 `@puxora/browserpilot`，首个 Puxora 版本为 `1.1.0`。
- 旧 `@pulab/browserpilot` 保留但在新包验证后标记弃用，不删除旧 npm 账号。
- 正式公开仓库使用干净的首次开源历史，不公开带公司邮箱和本机路径的旧私有提交。

## 仓库变更

- 统一 npm 包、Chrome 扩展、Codex 插件、MCP server 和 Web UI 版本为 `1.1.0`。
- 更新 GitHub、npm、作者、许可证、问题跟踪和安装文档为 Puxora 身份。
- 删除无效调试截图、备份文件和当前文档中的本机绝对路径。
- 增加 Issue 表单、PR 模板、Dependabot、Windows/Linux CI 和 npm OIDC 发布工作流。
- 增加锁定 .NET SDK 的 Native Relay Host 确定性构建与 SHA-256 校验。
- 增加包元数据、跨组件版本和 CLI 版本测试。

## 验证结果

- `npm run release:check`：通过。
- Node 测试：15/15 通过。
- MCP 工具发现：40 个工具，必需工具 10/10 通过。
- npm 依赖审计：0 个已知漏洞。
- Native Relay Host SHA-256：`aba09e6be82fcf2cb758007a7a586c331d68dc6862fffd30d5dc1a5edcd16fd7`，连续两次源码构建一致。
- npm dry-run：`@puxora/browserpilot@1.1.0`，50 个文件，170984 bytes。
- 隔离全局安装：`browserpilot --version` 输出 `BrowserPilot 1.1.0`，帮助命令正常。
- 最终发布审查：Git 工作区、发布工作流、账号角色说明和发布手册已复核；修正首次发布包名检查的命令序号。

## 外部操作状态

- GitHub `Puxora/BrowserPilot`：公开仓库已创建，单提交 `main` 和 `v1.1.0` 标签已完成首次推送；推送使用单独验证的 `Puxora` 凭据，不改变 `pulab-dev` 的日常开发身份。
- npm `@puxora/browserpilot@1.1.0`：等待 `puxora` 发布账号登录和首次发布。
- `@pulab/browserpilot` 弃用提示：必须在新包安装验证完成后执行。

## 回滚与兼容

- 旧 npm 包不会取消发布，已有安装继续可用。
- 包名迁移不会删除用户的 `~/.browserpilot` 配置、Token 或任务数据。
- 旧私有 Git 仓库应保留为只读备份，不向 Puxora 公共仓库推送旧分支或标签。
