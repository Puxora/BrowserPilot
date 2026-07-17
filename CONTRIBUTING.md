# 贡献指南

感谢你为 BrowserPilot 做出贡献。请先阅读 [SECURITY.md](./SECURITY.md)：浏览器自动化、Native Messaging 和远程 Token 的改动通常具有安全影响。

## 开始前

1. Fork 仓库并基于默认分支创建清晰的功能分支。
2. 在 `orchestrator/` 中运行 `npm ci`。
3. 本地加载 `chrome-extension/` 时请只使用测试账号和测试页面。

构建 Native Relay Host 需要 `orchestrator/global.json` 指定的 .NET SDK。Windows 安装包中的 `native-relay-host.exe` 必须由仓库源码生成：

```bash
cd orchestrator
npm run build:native-host
npm run check:native-host
```

构建使用确定性编译并校验提交的 EXE 与源码输出一致。代码签名证书不存放在仓库中；若发布流程增加 Authenticode 签名，必须在签名前保留并公布未签名构建的 SHA-256。

## 开发要求

- 保持 daemon API、MCP adapter、Native Relay 和 Chrome 扩展之间的协议兼容。
- 不要将 Token、真实 Cookie、页面内容、用户文件或本机绝对路径提交到仓库。
- 新增高风险浏览器动作时，必须定义其审批、日志与失败行为。
- 任何后台开关都必须有实际服务端/扩展端执行点和自动化测试；不要加入占位权限。
- 任务与 API 错误不能向远程客户端暴露堆栈或敏感上下文。

## 验证

提交前在 `orchestrator/` 运行：

```bash
npm ci
npm test
npm run check:tools
npm run check:native-host
npm audit --package-lock-only
npm pack --dry-run
```

涉及扩展时，额外手工验证：连接状态、标签页接管/释放、审批拒绝与批准、下载、文件选择器审批以及 service worker 重连。

## Pull Request

PR 请包含：

- 要解决的问题与行为变化；
- 安全和权限影响；
- 测试命令与结果；
- 用户可见变化对应的 README/CHANGELOG 更新；
- UI 或扩展变化的截图（如适用）。

保持 PR 聚焦。破坏性变更需说明迁移步骤和版本影响。
