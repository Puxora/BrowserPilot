# npm 发布准备与操作手册

本文件只描述 npm 发布流程。发布前必须由维护者再次确认功能、版本号和变更范围；不要将本手册视为自动发布授权。

## 发布前准备

1. 确认工作区仅包含本次发布的改动，并完成代码审查。
2. 确认 `orchestrator/package.json` 的版本号、[CHANGELOG.md](./CHANGELOG.md) 的版本条目和 README 一致。
3. 在 `orchestrator` 目录执行：

   ```bash
   npm ci
   npm run release:check
   ```

   该命令会运行测试、MCP 工具检查、依赖审计和 npm dry-run 包检查。`npm publish` 也会通过 `prepublishOnly` 自动执行同一检查。

4. 使用 npm 官方 registry 验证当前身份、`puxora` 发布账号权限与包名状态：

   ```bash
   npm whoami --registry=https://registry.npmjs.org/
   npm profile get --json --registry=https://registry.npmjs.org/
   npm view @puxora/browserpilot --registry=https://registry.npmjs.org/
   ```

   第三条命令在包名尚未发布时会返回 404，这是正常现象；首次发布前应再次确认包名未被占用。

5. 在 Windows 实机手工验证 Chrome 扩展、Native Messaging、Token、上传/下载审批和至少一个定时任务。此步骤不能由当前 Node 单元测试替代。

## 经再次确认后的实际发布

首选在 GitHub npm 环境中配置审批规则，并在 npm 为 `Puxora/BrowserPilot` 配置 Trusted Publishing。创建 `v<version>` GitHub Release 后，`.github/workflows/publish.yml` 会在 Windows runner 上重新构建 Native Relay Host、执行完整检查，并通过 OIDC 发布带 provenance 的包。

需要手工应急发布时，在用户明确授权后进入 `orchestrator`：

```bash
npm run build:native-host
npm publish --access public --provenance
```

`publishConfig` 已固定为官方 npm registry 和 `public` 访问级别。不要把长期 `NPM_TOKEN` 提交到仓库或写进 workflow。

## 发布后核验

```bash
npm view @puxora/browserpilot@<version> version dist.tarball dist.integrity --registry=https://registry.npmjs.org/
npx -y @puxora/browserpilot@<version> --help
```

记录实际版本、发布时间和包完整性信息，并将变更写入 [CHANGELOG.md](./CHANGELOG.md)。如果发现严重问题，优先发布修复版本或使用 npm deprecate 标记有问题的版本；不要把已使用的版本作为常规回滚手段直接撤销。

## 旧包迁移

确认新包可以安装和运行后，为旧 scope 添加迁移提示：

```bash
npm deprecate '@pulab/browserpilot@*' 'Package moved to @puxora/browserpilot. Run: npm uninstall -g @pulab/browserpilot && npm install -g @puxora/browserpilot'
```

保留并启用 `pulab` npm 账号的双因素认证，以便维护弃用信息并防止旧命名空间被接管。不要删除旧账号或取消发布已被用户安装的版本。
