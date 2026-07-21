// Chrome Automation Plugin - Web UI + REST API
// Express 服务器：管理面板静态文件 + 任务管理 API

import express from 'express';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import AdmZip from 'adm-zip';
import { TaskStore } from './storage.js';
import { VisualLeaseManager } from './visual-lease-manager.js';
import { BrowserOperationPolicy } from './security-policy.js';
import { ApiTokenStore } from './token-store.js';
import Cron from 'croner';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

function resolveExtensionDir() {
  const candidates = [
    join(projectRoot, 'chrome-extension'),
    join(projectRoot, '..', 'chrome-extension')
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

const ACTION_LABELS = {
  click: '点击页面元素',
  type: '输入文本',
  execute: '执行脚本',
  clickNode: '点击页面元素',
  typeNode: '输入文本',
  clickText: '点击文本',
  clickRole: '点击页面控件',
  typeByLabel: '按标签输入文本',
  visualStart: '开启可视化控制'
};

function formatActionLabel(action) {
  return ACTION_LABELS[action] || `执行操作 ${action}`;
}

function buildActionApprovalNotice(action) {
  return {
    title: 'BrowserPilot 审批请求',
    message: `检测到自动化操作：${formatActionLabel(action)}`
  };
}

function buildDownloadApprovalNotice(filename) {
  return {
    title: 'BrowserPilot 下载审批',
    message: `检测到自动化下载：${filename || '未命名文件'}`
  };
}

function buildUploadApprovalNotice(accept) {
  return {
    title: 'BrowserPilot 上传审批',
    message: `检测到文件选择请求${accept ? `（允许类型：${accept}）` : ''}`
  };
}

export class WebUiServer {
  constructor(config, wsServer) {
    this.config = config;
    this.wsServer = wsServer;
    this.app = express();
    this.scheduler = null; // 由 index.js 注入
    this.pendingApprovals = new Map(); // id -> { id, action, params, tabId, resolve, reject, createdAt }
    this.pendingDownloads = new Map(); // id -> { id, filename, url, fileSize, mime, resolve, reject, createdAt }
    this.pendingUploads = new Map(); // id -> { id, accept, tabId, resolve, reject, createdAt }
    this.visualLeases = new VisualLeaseManager(wsServer, config.visualControlLeaseMs);
    this.policy = new BrowserOperationPolicy({
      getStore: () => this.scheduler?.store || new TaskStore(this.config),
      wsServer,
      requestApproval: request => this._requestApproval(request)
    });
    this.tokenStore = new ApiTokenStore(config);

    this._setupMiddleware();
    this._setupRoutes();
  }

  setScheduler(scheduler) {
    this.scheduler = scheduler;
    scheduler.setOperationPolicy(this.policy);
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.config.webPort, this.config.webHost, () => {
        console.log(`[Web UI] 管理面板: http://${this.config.webHost}:${this.config.webPort}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async stop() {
    this._rejectPendingApprovals('Daemon 已停止');
    await this.visualLeases.stop();
    if (this.server) this.server.close();
  }

  async _sendSystemNotification(approvalId, title, message) {
    // 通过 Chrome 扩展发送唯一审批通知，保留通知中心的批准/拒绝按钮。
    if (this.wsServer && this.wsServer.isConnected()) {
      console.log(`[Web UI] 正在通过浏览器通道发送系统通知: ${title} -> ${message}`);
      try {
        await this.wsServer.sendCommand('showNotification', {
          approvalId,
          title,
          message
        });
        return;
      } catch (err) {
        console.error('[Web UI] 发送扩展通知失败:', err.message);
      }
    } else {
      console.warn('[Web UI] 浏览器未连接，无法发送审批通知');
    }
  }

  _sendWindowsToast(title, message) {
    try {
      const safeTitle = String(title).replace(/'/g, "''").replace(/[\r\n]+/g, ' ');
      const safeMsg   = String(message).replace(/'/g, "''").replace(/[\r\n]+/g, ' ');
      const script = [
        `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null`,
        `$t  = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)`,
        `$tf = $t.GetElementsByTagName('text')`,
        `$tf.Item(0).AppendChild($t.CreateTextNode('${safeTitle}')) | Out-Null`,
        `$tf.Item(1).AppendChild($t.CreateTextNode('${safeMsg}')) | Out-Null`,
        `$toast = [Windows.UI.Notifications.ToastNotification]::new($t)`,
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('BrowserPilot').Show($toast)`,
      ].join('\n');

      // PowerShell -EncodedCommand 要求 UTF-16LE Base64
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      execSync(`powershell -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}`, {
        timeout: 6000,
        stdio: 'ignore'
      });
      console.log('[Web UI] ✅ Windows Toast 通知已发出');
    } catch (err) {
      console.warn('[Web UI] Windows Toast 通知发送失败:', err.message?.slice(0, 120));
    }
  }

  async _handleDownloadEvent(eventData) {
    const { downloadId, filename, url, fileSize, mime } = eventData;
    console.log(`[Web UI] 收到文件下载请求: ${filename || '未知'} (ID: ${downloadId}), 正在根据安全规则审查...`);
    
    const store = this.scheduler?.store || new TaskStore(this.config);
    const settings = await store.getSettings();
    const rule = settings.download || 'ask'; // 'always' | 'none' | 'ask'

    if (rule === 'always') {
      console.log(`[Web UI] 安全规则为 [始终允许]，释放下载: ${downloadId}`);
      await this.wsServer.sendCommand('resumeDownload', { downloadId });
    } else if (rule === 'none') {
      console.log(`[Web UI] 安全规则为 [始终禁止]，取消下载: ${downloadId}`);
      await this.wsServer.sendCommand('cancelDownload', { downloadId });
    } else {
      console.log(`[Web UI] 安全规则为 [每次询问]，拦截挂起下载: ${downloadId}`);
      
      const promise = new Promise((resolve, reject) => {
        const id = String(downloadId);
        const timer = setTimeout(() => {
          const pending = this.pendingDownloads.get(id);
          if (!pending) return;
          this.pendingDownloads.delete(id);
          reject(new Error('下载审批超时'));
        }, 30000);
        timer.unref?.();
        this.pendingDownloads.set(id, {
          id,
          filename: filename || '未命名文件',
          url,
          fileSize,
          mime,
          resolve,
          reject,
          timer,
          createdAt: Date.now()
        });
      });

      const notice = buildDownloadApprovalNotice(filename);
      await this._sendSystemNotification(String(downloadId), notice.title, notice.message);

      try {
        await promise;
        console.log(`[Web UI] 用户已批准该下载，恢复文件下载进程: ${downloadId}`);
        await this.wsServer.sendCommand('resumeDownload', { downloadId });
      } catch (err) {
        console.log(`[Web UI] 用户已拒绝该下载，正在取消下载并清理痕迹: ${downloadId}`);
        await this.wsServer.sendCommand('cancelDownload', { downloadId });
      } finally {
        const pending = this.pendingDownloads.get(String(downloadId));
        if (pending) clearTimeout(pending.timer);
        this.pendingDownloads.delete(String(downloadId));
      }
    }
  }

  async _handleUploadEvent(eventData) {
    const { uploadId, accept, tabId } = eventData;
    if (!uploadId) throw new Error('上传审批请求缺少 ID');
    const store = this.scheduler?.store || new TaskStore(this.config);
    const rule = (await store.getSettings()).upload || 'ask';
    const id = String(uploadId);

    if (rule === 'always') {
      await this.wsServer.sendCommand('approveUpload', { uploadId: id }, tabId);
      return;
    }
    if (rule === 'none') {
      await this.wsServer.sendCommand('rejectUpload', { uploadId: id }, tabId);
      return;
    }

    const decision = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingUploads.get(id);
        if (!pending) return;
        this.pendingUploads.delete(id);
        reject(new Error('上传审批超时'));
      }, 30000);
      timer.unref?.();
      this.pendingUploads.set(id, { id, accept, tabId, resolve, reject, timer, createdAt: Date.now() });
    });
    try {
      const notice = buildUploadApprovalNotice(accept);
      await this._sendSystemNotification(id, notice.title, notice.message);
      await decision;
      await this.wsServer.sendCommand('approveUpload', { uploadId: id }, tabId);
    } catch (error) {
      await this.wsServer.sendCommand('rejectUpload', { uploadId: id }, tabId).catch(() => {});
      throw error;
    } finally {
      const pending = this.pendingUploads.get(id);
      if (pending) clearTimeout(pending.timer);
      this.pendingUploads.delete(id);
    }
  }

  // ── 内部 ──────────────────────────────

  _setupMiddleware() {
    this.app.disable('x-powered-by');
    this.app.use((req, res, next) => {
      if (!this._isAllowedHost(req.headers.host, req.socket.remoteAddress)) {
        return res.status(421).json({ code: 1, message: '不受信任的 Host' });
      }
      // 令牌 Cookie 只交给本机浏览器。外网监听时，Host 可被请求方伪造，
      // 因此绝不能仅凭 Host 向远端请求下发认证凭证。
      if (req.path === '/' && req.method === 'GET' && this._isLoopbackAddress(req.socket.remoteAddress)) {
        res.setHeader('Set-Cookie', `browserpilot_api_token=${this.config.apiToken}; HttpOnly; SameSite=Strict; Path=/`);
      }
      next();
    });
    this.app.use(express.json());
    this.app.use(express.static(this.config.webUiDir));
  }

  _setupRoutes() {
    // 监听来自 Chrome 扩展上报的各种事件
    this.wsServer.onEvent = async (eventData) => {
      const { event } = eventData;
      if (event === 'downloadCreated') {
        try {
          await this._handleDownloadEvent(eventData);
        } catch (err) {
          console.error('[Web UI] 处理下载事件失败:', err.message);
        }
      }
      if (event === 'uploadRequested') {
        try {
          await this._handleUploadEvent(eventData);
        } catch (err) {
          console.error('[Web UI] 处理上传请求失败:', err.message);
        }
      }
      if (event === 'approvalDecision') {
        this._resolveApproval(eventData.approvalId, eventData.decision);
      }
      if (event === 'visualCancelRequested') {
        this.scheduler?.cancelByTab(eventData.tabId);
        this.visualLeases.cancel(normalizeTabId(eventData.tabId));
      }
    };

    const api = express.Router();
    api.use((req, res, next) => this._protectApiRequest(req, res, next));
    const store = this.scheduler?.store || new TaskStore(this.config);

    // ── 状态 ──────────────────────────
    api.get('/status', async (_req, res) => {
      const tasks = await store.list();

      res.json({
        chromeConnected: this.wsServer.isConnected(),
        taskCount: tasks.length,
        wsPort: this.config.wsPort,
      });
    });

    // ── 任务列表 ──────────────────────
    api.get('/tasks', async (_req, res) => {
      try {
        const tasks = await store.list();

        // 补充运行状态 + 上次执行信息
        for (const task of tasks) {
          if (this.scheduler) {
            task.nextRun = this.scheduler.getNextRun(task.id);
            task.isRunning = this.scheduler.isRunning(task.id);
          }
          // 从日志文件读取上次触发时间与结果
          try {
            const logLines = await store.getLogs(task.id, 10000);
            if (logLines.length) {
              // 找最近一条 start 记录
              for (let i = logLines.length - 1; i >= 0; i--) {
                try {
                  const entry = logLines[i];
                  if (entry.type === 'start') {
                    task.lastRun = entry.timestamp;
                    break;
                  }
                } catch {}
              }
              // 找最近一条 complete/error 记录作为上次结果
              for (let i = logLines.length - 1; i >= 0; i--) {
                try {
                  const entry = logLines[i];
                  if (entry.type === 'complete') {
                    task.lastRunStatus = 'success';
                    break;
                  } else if (entry.type === 'error') {
                    task.lastRunStatus = 'error';
                    break;
                  }
                } catch {}
              }
            }
          } catch {}
        }

        res.json({ code: 0, data: tasks });
      } catch (err) {
        res.json({ code: 1, message: '加载任务列表失败: ' + err.message });
      }
    });

    // ── 获取单个任务 ──────────────────
    api.get('/tasks/:id', async (req, res) => {
      try {
        const task = await store.get(req.params.id);
        if (!task) {
          return res.status(404).json({ code: 1, message: '任务不存在' });
        }
        const source = await store.getSource(req.params.id);

        const taskResponse = { ...task, source };
        if (this.scheduler) {
          taskResponse.nextRun = this.scheduler.getNextRun(task.id);
          taskResponse.isRunning = this.scheduler.isRunning(task.id);
        }

        res.json({ code: 0, data: taskResponse });
      } catch (err) {
        res.json({ code: 1, message: '加载任务失败: ' + err.message });
      }
    });

    // ── 创建任务 ──────────────────────
    api.post('/tasks', async (req, res) => {
      try {
        const { source } = req.body;
        if (typeof source !== 'string' || !source.trim()) {
          return res.status(400).json({
            code: 1, message: '缺少 JS 任务模块源码: source'
          });
        }
        const taskDef = await store.createSource(source);
        try {
          this._validateCron(taskDef.schedule);
        } catch (error) {
          await store.delete(taskDef.id);
          throw error;
        }

        // 通知调度器加载新任务
        if (this.scheduler) {
          this.scheduler.addTask(taskDef);
        }

        res.json({ code: 0, message: '任务创建成功', data: { id: taskDef.id } });
      } catch (err) {
        res.status(400).json({ code: 1, message: '创建任务失败: ' + err.message });
      }
    });

    // ── 更新任务 ──────────────────────
    api.put('/tasks/:id', async (req, res) => {
      try {
        if (typeof req.body.source !== 'string') {
          return res.status(400).json({ code: 1, message: '更新任务需要完整 JS 模块源码: source' });
        }
        const previousTask = await store.get(req.params.id);
        if (!previousTask) {
          return res.status(404).json({ code: 1, message: '任务不存在' });
        }
        const previousSource = await store.getSource(req.params.id);
        try {
          const task = await store.saveSource(req.params.id, req.body.source);
          this._validateCron(task.schedule);
          this.scheduler?.reloadTask(task);
          return res.json({ code: 0, message: '任务更新成功' });
        } catch (error) {
          if (previousSource !== null && (await store.getSource(req.params.id)) !== previousSource) {
            await store.saveSource(req.params.id, previousSource);
          }
          this.scheduler?.reloadTask(previousTask);
          throw error;
        }
      } catch (err) {
        res.status(400).json({ code: 1, message: '更新任务失败: ' + err.message });
      }
    });

    // ── 删除任务 ──────────────────────
    api.delete('/tasks/:id', async (req, res) => {
      try {
        if (!await store.get(req.params.id)) {
          return res.status(404).json({ code: 1, message: '任务不存在' });
        }
        await store.delete(req.params.id);
        if (this.scheduler) this.scheduler.removeTask(req.params.id);

        res.json({ code: 0, message: '任务已删除' });
      } catch (err) {
        res.json({ code: 1, message: '删除任务失败: ' + err.message });
      }
    });

    // ── 切换任务启用/停用 ──────────────
    api.patch('/tasks/:id/toggle', async (req, res) => {
      try {
        const previousTask = await store.get(req.params.id);
        if (!previousTask) {
          return res.status(404).json({ code: 1, message: '任务不存在' });
        }
        const task = await store.setEnabled(req.params.id, !previousTask.enabled);

        // 通知调度器重新加载
        this.scheduler?.reloadTask(task);

        res.json({ code: 0, message: task.enabled ? '任务已启用' : '任务已停用', data: { enabled: task.enabled } });
      } catch (err) {
        res.json({ code: 1, message: '切换任务状态失败: ' + err.message });
      }
    });

    // ── 手动执行任务 ──────────────────
    api.post('/tasks/:id/run', async (req, res) => {
      try {
        if (!this.scheduler) {
          return res.status(503).json({ code: 1, message: '调度器未启动' });
        }

        await this.scheduler.runNow(req.params.id, 'manual');
        res.json({ code: 0, message: '任务已触发执行' });
      } catch (err) {
        res.json({ code: 1, message: '执行失败: ' + err.message });
      }
    });

    api.post('/tasks/:id/cancel', (req, res) => {
      if (!this.scheduler) return res.status(503).json({ code: 1, message: '调度器未启动' });
      if (!this.scheduler.cancel(req.params.id)) {
        return res.status(404).json({ code: 1, message: '任务未在执行' });
      }
      res.json({ code: 0, message: '已请求取消任务' });
    });

    // ── 获取执行日志 ──────────────────
    api.get('/tasks/:id/logs', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 50;
        res.json({ code: 0, data: await store.getLogs(req.params.id, limit) });
      } catch (err) {
        res.json({ code: 1, message: '读取日志失败: ' + err.message });
      }
    });

    // ── 获取通用设置 ──────────────────
    api.get('/settings', async (req, res) => {
      try {
        const store = this.scheduler?.store || new TaskStore(this.config);
        const settings = await store.getSettings();
        res.json({ code: 0, data: settings });
      } catch (err) {
        res.json({ code: 1, message: '获取设置失败: ' + err.message });
      }
    });

    // ── 保存通用设置 ──────────────────
    api.post('/settings', async (req, res) => {
      try {
        const store = this.scheduler?.store || new TaskStore(this.config);
        await store.saveSettings(req.body);
        res.json({ code: 0, message: '设置保存成功' });
      } catch (err) {
        res.status(400).json({ code: 1, message: '保存设置失败: ' + err.message });
      }
    });

    // ── 调试测试通知 ──────────────────
    api.post('/test-notification', async (req, res) => {
      const approvalId = `test-${Date.now()}`;
      
      this.pendingApprovals.set(approvalId, {
        id: approvalId,
        action: 'test_action',
        params: { note: '这是一个测试系统通知的审批项目' },
        tabId: 0,
        resolve: () => console.log(`[Test] 审批ID: ${approvalId} 已批准`),
        reject: (err) => console.log(`[Test] 审批ID: ${approvalId} 已拒绝: ${err.message}`),
        createdAt: Date.now()
      });

      await this._sendSystemNotification(
        approvalId,
        'BrowserPilot 审批测试',
        '这是一条 BrowserPilot 审批通知测试。'
      );

      res.json({ code: 0, message: '测试通知指令已发出，请观察桌面', approvalId });
    });

    // ── 获取待审批请求 ────────────────
    api.get('/approvals', (req, res) => {
      const actions = Array.from(this.pendingApprovals.values()).map(appr => ({
        id: appr.id,
        type: 'action',
        action: appr.action,
        params: appr.params,
        tabId: appr.tabId,
        createdAt: appr.createdAt
      }));

      const downloads = Array.from(this.pendingDownloads.values()).map(dl => ({
        id: dl.id,
        type: 'download',
        action: 'download',
        filename: dl.filename,
        url: dl.url,
        fileSize: dl.fileSize,
        mime: dl.mime,
        createdAt: dl.createdAt
      }));
      const uploads = Array.from(this.pendingUploads.values()).map(upload => ({
        id: upload.id,
        type: 'upload',
        action: 'upload',
        accept: upload.accept,
        tabId: upload.tabId,
        createdAt: upload.createdAt
      }));

      res.json({ code: 0, data: [...actions, ...downloads, ...uploads] });
    });

    // ── 审批决策 ──────────────────────
    api.post('/approvals/:id/decide', (req, res) => {
      const { id } = req.params;
      const { decision } = req.body; // 'approve' | 'reject'
      
      const pendingAction = this.pendingApprovals.get(id);
      if (pendingAction) {
        if (decision === 'approve') {
          pendingAction.resolve();
          return res.json({ code: 0, message: '操作已批准执行' });
        } else {
          pendingAction.reject(new Error('该敏感操作被用户手动拒绝'));
          return res.json({ code: 0, message: '已拒绝该操作' });
        }
      }

      const pendingDownload = this.pendingDownloads.get(id);
      if (pendingDownload) {
        if (decision === 'approve') {
          pendingDownload.resolve();
          return res.json({ code: 0, message: '文件下载已批准' });
        } else {
          pendingDownload.reject(new Error('该文件下载被用户拒绝'));
          return res.json({ code: 0, message: '已取消该文件下载' });
        }
      }

      const pendingUpload = this.pendingUploads.get(id);
      if (pendingUpload) {
        if (decision === 'approve') {
          pendingUpload.resolve();
          return res.json({ code: 0, message: '已允许打开文件选择器' });
        }
        pendingUpload.reject(new Error('该文件选择请求被用户拒绝'));
        return res.json({ code: 0, message: '已拒绝文件选择请求' });
      }
      
      return res.status(404).json({ code: 1, message: '未找到该审批请求，可能已被处理或超时' });
    });

    // ── Windows 通知中心 Protocol 审批跳转回调 (GET) ──
    api.get('/approvals/:id/decide-via-get', (req, res) => {
      const { id } = req.params;
      const { decision } = req.query; // 'approve' | 'reject'
      
      let success = false;
      let msg = '';
      
      const pendingAction = this.pendingApprovals.get(id);
      if (pendingAction) {
        if (decision === 'approve') {
          pendingAction.resolve();
          success = true;
          msg = '该敏感操作已成功批准执行！';
        } else {
          pendingAction.reject(new Error('该敏感操作被用户手动拒绝'));
          success = true;
          msg = '已成功拒绝并阻断该敏感操作！';
        }
      }

      const pendingDownload = this.pendingDownloads.get(id);
      if (pendingDownload) {
        if (decision === 'approve') {
          pendingDownload.resolve();
          success = true;
          msg = '文件下载已批准，正在后台传输文件...';
        } else {
          pendingDownload.reject(new Error('该文件下载被用户拒绝'));
          success = true;
          msg = '已成功拒绝并取消该文件下载进程！';
        }
      }

      if (!success) {
        msg = '未找到该审批请求，可能已被处理或已超时。';
      }

      // 返回一个精致的响应网页
      const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>BrowserPilot 安全审查</title>
  <style>
    body {
      background-color: #0a0b0d;
      color: #f3f4f6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .card {
      background-color: #121317;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      padding: 32px;
      text-align: center;
      width: 360px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.3);
    }
    h2 { color: ${decision === 'approve' ? '#10b981' : '#ef4444'}; margin-bottom: 12px; font-size: 18px; font-weight: 600; }
    p { color: #9ca3af; font-size: 13.5px; margin-bottom: 24px; line-height: 1.5; }
    .btn {
      background: #3b82f6;
      border: none;
      padding: 8px 20px;
      color: #fff;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.15s;
    }
    .btn:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${decision === 'approve' ? '🟢 审批放行成功' : '🔴 审批拦截成功'}</h2>
    <p>${msg}</p>
    <button class="btn" onclick="window.close()">关闭此页面</button>
  </div>
  <script>
    // 3秒后尝试自动关闭窗口
    setTimeout(() => { window.close(); }, 3000);
  </script>
</body>
</html>
      `;
      res.send(html);
    });

    // ── 浏览器扩展下载 ──────────────────
    api.get('/download-extension', async (req, res) => {
      const extDir = resolveExtensionDir();
      const zipPath = join(this.config.taskDir, '..', 'chrome-extension.zip');
      
      try {
        if (!existsSync(extDir)) {
          return res.status(404).json({ code: 1, message: '未找到浏览器扩展目录' });
        }

        const zip = new AdmZip();
        zip.addLocalFolder(extDir);
        zip.writeZip(zipPath);
        res.download(zipPath, 'chrome-extension.zip');
      } catch (err) {
        res.status(500).json({ code: 1, message: '打包扩展失败: ' + err.message });
      }
    });

    // ── 浏览器操作 ────────────────────
    api.post('/browser/:action', async (req, res) => {
      let requestContext;
      try {
        const { action } = req.params;
        const { tabId: requestedTabId, controllerSessionId, ...params } = req.body;
        const tabId = normalizeTabId(requestedTabId);

        if ((action === 'releaseTab' || action === 'visualStop') && !Number.isInteger(tabId)) {
          return res.status(400).json({ code: 1, message: '请选择要停止控制的目标标签页' });
        }

        if (!this._canControlTab(action, tabId, params, controllerSessionId)) {
          return res.status(403).json({ code: 1, message: '该标签页由其他控制会话持有' });
        }

        const resumesControl = action === 'claimTab' || action === 'visualStart';
        if (!resumesControl && this.visualLeases.isCancelled(tabId, controllerSessionId)) {
          return res.json({ code: 1, message: '用户已取消当前浏览器控制，请重新认领标签页后继续' });
        }

        const abortController = new AbortController();
        requestContext = { tabId, controllerSessionId, abortController };
        this.visualLeases.register(tabId, controllerSessionId, abortController);
        res.once('close', () => abortController.abort());
        await this.policy.authorize(action, { params, tabId, signal: abortController.signal });

        const result = await this.wsServer.sendCommand(action, params, tabId, undefined, abortController.signal);
        this._updateVisualLease(action, tabId, result, params, controllerSessionId);
        res.json({ code: 0, data: result });
      } catch (err) {
        const message = requestContext?.abortController.signal.aborted
          ? '用户已取消当前浏览器控制'
          : err.message;
        if (!res.headersSent) res.json({ code: 1, message });
      } finally {
        if (requestContext) {
          this.visualLeases.unregister(
            requestContext.tabId,
            requestContext.controllerSessionId,
            requestContext.abortController
          );
        }
      }
    });

    // ── 调度器状态 ────────────────────
    api.get('/scheduler/status', (_req, res) => {
      if (!this.scheduler) {
        return res.json({ code: 0, data: { running: false } });
      }
      res.json({
        code: 0,
        data: {
          running: true,
          taskCount: this.scheduler.taskCount,
          activeJobs: this.scheduler.activeJobs,
        }
      });
    });

    this.app.use('/api', api);
  }

  _updateVisualLease(action, tabId, result, params, controllerSessionId) {
    if (!controllerSessionId) return;

    const resolvedTabId = result?.tabId ?? tabId;
    if (action === 'claimTab' && params.visual !== false) {
      this.visualLeases.start(resolvedTabId, controllerSessionId);
      return;
    }
    if (action === 'visualStart') {
      this.visualLeases.start(resolvedTabId, controllerSessionId);
      return;
    }
    if (action === 'releaseTab' || action === 'visualStop') {
      this.visualLeases.release(resolvedTabId, controllerSessionId);
      return;
    }
    if (action === 'finalizeTabs') {
      this.visualLeases.releaseMany(params.releaseTabIds || [], controllerSessionId);
      return;
    }
    this.visualLeases.refresh(resolvedTabId, controllerSessionId);
  }

  _canControlTab(action, tabId, params, controllerSessionId) {
    if (action === 'claimTab') {
      return !Number.isInteger(tabId)
        || !this.visualLeases.has(tabId)
        || this.visualLeases.owns(tabId, controllerSessionId);
    }
    if (action === 'releaseTab' || action === 'visualStop') {
      return Number.isInteger(tabId)
        && (!this.visualLeases.has(tabId) || this.visualLeases.owns(tabId, controllerSessionId));
    }
    if (action === 'finalizeTabs') {
      const releaseTabIds = Array.isArray(params.releaseTabIds) ? params.releaseTabIds : [];
      const closeTabIds = Array.isArray(params.closeTabIds) ? params.closeTabIds : [];
      params.releaseTabIds = releaseTabIds.filter((id) => this.visualLeases.owns(id, controllerSessionId));
      params.closeTabIds = closeTabIds.filter((id) => this.visualLeases.owns(id, controllerSessionId));
      return true;
    }
    if (!Number.isInteger(tabId) || !this.visualLeases.has(tabId)) return true;
    return this.visualLeases.owns(tabId, controllerSessionId);
  }

  _isAllowedHost(hostHeader, remoteAddress) {
    if (!hostHeader) return false;
    const rawHost = String(hostHeader).toLowerCase();
    const host = rawHost.startsWith('[')
      ? rawHost.slice(1, rawHost.indexOf(']'))
      : rawHost.split(':')[0];
    const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
    if (['127.0.0.1', 'localhost', '::1'].includes(this.config.webHost.toLowerCase())) {
      localHosts.add(this.config.webHost.toLowerCase());
      return localHosts.has(host);
    }
    return this._isLoopbackAddress(remoteAddress)
      ? localHosts.has(host)
      : this.config.trustedHosts.includes(host);
  }

  _isLoopbackAddress(address) {
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(address || '').toLowerCase());
  }

  _protectApiRequest(req, res, next) {
    const origin = req.headers.origin;
    const expectedOrigins = new Set([
      `http://${this.config.webHost}:${this.config.webPort}`,
      `http://127.0.0.1:${this.config.webPort}`,
      `http://localhost:${this.config.webPort}`,
      ...this.config.trustedOrigins
    ]);
    if (origin && !expectedOrigins.has(origin)) {
      return res.status(403).json({ code: 1, message: '不受信任的来源' });
    }
    const authorization = String(req.headers.authorization || '');
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const cookie = String(req.headers.cookie || '').split(';').map(item => item.trim())
      .find(item => item.startsWith('browserpilot_api_token='))?.slice('browserpilot_api_token='.length);
    const token = bearer || cookie;
    this.tokenStore.verify(token).then(valid => {
      if (!valid) return res.status(401).json({ code: 1, message: '缺少或无效的 API 认证令牌' });
      next();
    }).catch(error => res.status(500).json({ code: 1, message: error.message }));
  }

  _validateCron(schedule) {
    if (typeof schedule !== 'string' || schedule.length > 200) throw new Error('cron 表达式无效');
    try {
      new Cron(schedule);
    } catch {
      throw new Error('cron 表达式无效');
    }
  }

  _requestApproval({ action, params, tabId, signal }) {
    if (signal?.aborted) return Promise.reject(new Error('请求已取消，审批已撤销'));
    const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        const pending = this.pendingApprovals.get(approvalId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingApprovals.delete(approvalId);
        signal?.removeEventListener('abort', onAbort);
        callback(value);
      };
      const onAbort = () => finish(reject, new Error('请求已取消，审批已撤销'));
      const timer = setTimeout(() => finish(reject, new Error('审批超时，操作已取消')), 30000);
      timer.unref?.();
      this.pendingApprovals.set(approvalId, {
        id: approvalId, action, params, tabId, createdAt: Date.now(), timer,
        resolve: () => finish(resolve),
        reject: error => finish(reject, error)
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      const notice = buildActionApprovalNotice(action);
      this._sendSystemNotification(approvalId, notice.title, notice.message)
        .catch(error => finish(reject, error));
    });
  }

  _rejectPendingApprovals(message) {
    for (const pending of this.pendingApprovals.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pendingApprovals.clear();
    for (const pending of this.pendingDownloads.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pendingDownloads.clear();
    for (const pending of this.pendingUploads.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pendingUploads.clear();
  }

  _resolveApproval(id, decision) {
    const pendingAction = this.pendingApprovals.get(id);
    if (pendingAction) {
      if (decision === 'approve') pendingAction.resolve();
      else pendingAction.reject(new Error('该敏感操作被用户手动拒绝'));
      return true;
    }
    const pendingDownload = this.pendingDownloads.get(id);
    if (pendingDownload) {
      if (decision === 'approve') pendingDownload.resolve();
      else pendingDownload.reject(new Error('该文件下载被用户拒绝'));
      return true;
    }
    const pendingUpload = this.pendingUploads.get(id);
    if (pendingUpload) {
      if (decision === 'approve') pendingUpload.resolve();
      else pendingUpload.reject(new Error('该文件选择请求被用户拒绝'));
      return true;
    }
    return false;
  }
}

function normalizeTabId(tabId) {
  if (Number.isInteger(tabId)) return tabId;
  if (typeof tabId === 'string' && /^\d+$/.test(tabId)) return Number(tabId);
  return undefined;
}
