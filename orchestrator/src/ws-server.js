// Chrome Automation Plugin - WebSocket Server
// 接收 Native Relay 的 WS 连接，双向转发浏览器指令

import { WebSocketServer } from 'ws';
import { createResponse, validateMessage } from './protocol.js';

export class BrowserWsServer {
  constructor(config) {
    this.config = config;
    this.wss = null;
    this.relayConnection = null;    // 当前连接的 Native Relay
    this.pendingRequests = new Map(); // id → {resolve, reject, timer}
    this.onCommand = null;          // 外部注册的命令处理器
    this.onEvent = null;            // 外部注册的事件处理器（如 visualCancelRequested）
  }

  /**
   * 启动 WebSocket 服务器
   */
  start() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        port: this.config.wsPort,
        host: '127.0.0.1',
        verifyClient: (info, done) => {
          const protocols = String(info.req.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
          const origin = info.origin || info.req.headers.origin;
          if (origin || !protocols.includes(this.config.relayToken)) {
            done(false, 401, '未授权的 Native Relay');
            return;
          }
          done(true);
        }
      });

      this.wss.on('listening', () => {
        console.log(`[WS Server] 监听 ws://127.0.0.1:${this.config.wsPort}`);
        resolve();
      });

      this.wss.on('error', (err) => {
        console.error('[WS Server] 启动失败:', err.message);
        reject(err);
      });

      this.wss.on('connection', (ws) => this._handleConnection(ws));
    });
  }

  /**
   * 向浏览器发送命令并等待响应
   * @param {string} action - 操作类型
   * @param {object} params - 操作参数
   * @param {number} [tabId] - 目标标签页
   * @param {number} [timeoutMs] - 超时时间
   * @returns {Promise<object>}
   */
  sendCommand(action, params = {}, tabId, timeoutMs, signal) {
    if (!this.relayConnection || this.relayConnection.readyState !== 1) {
      return Promise.reject(new Error('Chrome 未连接 — 请确认 Chrome 已启动且扩展已安装'));
    }

    const id = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeout = timeoutMs || this.config.defaultTimeoutMs;

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(`操作已取消: ${action}`));
        return;
      }
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        cleanup();
        reject(new Error(`操作超时: ${action} (${timeout}ms)`));
      }, timeout);

      const onAbort = () => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        cleanup();
        reject(new Error(`操作已取消: ${action}`));
      };

      this.pendingRequests.set(id, {
        resolve: value => { cleanup(); resolve(value); },
        reject: error => { cleanup(); reject(error); },
        timer
      });
      signal?.addEventListener('abort', onAbort, { once: true });

      const msg = { id, type: 'command', payload: { action, tabId, params } };
      this.relayConnection.send(JSON.stringify(msg));
    });
  }

  /**
   * 检查是否已连接 Chrome
   */
  isConnected() {
    return this.relayConnection !== null &&
           this.relayConnection.readyState === 1;
  }

  /**
   * 停止服务器
   */
  stop() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.relayConnection = null;

    // 拒绝所有待处理请求
    for (const [id, p] of this.pendingRequests) {
      clearTimeout(p.timer);
      p.reject(new Error('服务器已关闭'));
    }
    this.pendingRequests.clear();
  }

  // ── 内部方法 ────────────────────────────

  _handleConnection(ws) {
    const remoteAddr = ws._socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const sinceLast = this._lastConnectAt ? now - this._lastConnectAt : Infinity;

    // 连接去抖：若距上一个连接建立不足 1500ms，判定为多 relay 互相抢连的抖动。
    const isFlap = sinceLast < 1500;
    console.log(`[WS Server] 新连接: ${remoteAddr}${isFlap ? ` (⚠ 抖动: 距上次连接 ${sinceLast}ms)` : ''}`);
    this._lastConnectAt = now;
    this._connectCount = (this._connectCount || 0) + 1;

    // 僵尸判定式连接管理：
    // 旧连接若近期有消息往来（活的），拒绝新连接，保留旧连接稳定；
    // 旧连接若长期无消息（超过 ZOMBIE_MS，判定为僵尸——扩展侧 nativePort 已断，
    // relay 仍占着 slot 却不再通信），则关闭旧的、由新连接接管。
    // 这既避免"活连接被误杀"又避免"僵尸霸占 slot 卡死新连接"。
    // 配合 native-relay.js 的 stdin 关闭退出，正常情况下扩展断开时 relay 会主动退出，
    // 此处的僵尸判定是兜底，防 relay 没能正常退出的边缘场景。
    const ZOMBIE_MS = 60000; // 扩展 keep-alive 25s，两倍余量
    const oldConn = this.relayConnection;
    if (oldConn && oldConn !== ws && oldConn.readyState === 1) {
      const idleMs = now - (oldConn._lastMessageAt || oldConn._openAt || 0);
      if (idleMs < ZOMBIE_MS) {
        // 旧连接是活的，拒绝新连接（避免互相踢）
        console.log(`[WS Server] 已有活跃 Relay 连接，拒绝新连接（旧连接 ${Math.round(idleMs / 1000)}s 内有消息）`);
        try { ws.close(); } catch {}
        return;
      }
      // 旧连接是僵尸，接管
      console.log(`[WS Server] 旧 Relay 连接已僵尸化（${Math.round(idleMs / 1000)}s 无消息），新连接接管`);
      try { oldConn.close(); } catch {}
    }

    this.relayConnection = ws;
    ws._openAt = now;
    ws._lastMessageAt = now; // welcome 算作一次活跃

    ws.on('message', (data) => {
      ws._lastMessageAt = Date.now();
      this._handleMessage(data);
    });
    ws.on('close', () => {
      console.log('[WS Server] Relay 连接断开');
      if (this.relayConnection === ws) {
        this.relayConnection = null;
        this._rejectPendingRequests(new Error('Native Relay 已断开'));
      }
    });
    ws.on('error', (err) => {
      console.error('[WS Server] Relay 连接错误:', err.message);
    });

    // 发送欢迎消息
    ws.send(JSON.stringify({ type: 'welcome', payload: { version: '1.1.3' } }));
  }

  _handleMessage(data) {
    try {
      const msg = JSON.parse(data.toString());

      // 处理来自 Relay 的响应
      if (msg.type === 'result' || msg.type === 'ready') {
        const id = msg.id;
        if (id && this.pendingRequests.has(id)) {
          const pending = this.pendingRequests.get(id);
          clearTimeout(pending.timer);
          this.pendingRequests.delete(id);

          if (msg.payload?.success) {
            pending.resolve(msg.payload.data || msg.payload);
          } else {
            pending.reject(new Error(msg.payload?.error || '未知错误'));
          }
        }
      }
      // 处理 Relay 主动发来的消息（如 ready）
      else if (msg.type === 'ready') {
        console.log('[WS Server] Chrome 扩展已就绪');
      }
      // 处理来自 Chrome 的 event 消息（如可视化取消请求 visualCancelRequested）
      else if (msg.type === 'event') {
        console.log('[WS Server] 收到事件:', msg.payload?.event);
        if (typeof this.onEvent === 'function') {
          try { this.onEvent(msg.payload || {}, msg); } catch (e) {
            console.error('[WS Server] 事件处理器异常:', e.message);
          }
        }
      }
      // 处理 Relay 转发的心跳：回 pong，让扩展侧 handleNativeMessage 触发握手
      // （扩展 markHandshake 依赖"收到任意 host 回包"，daemon 不回任何包则永远 connecting）
      else if (msg.type === 'ping') {
        if (this.relayConnection && this.relayConnection.readyState === 1) {
          this.relayConnection.send(JSON.stringify({ id: msg.id, type: 'pong', payload: {} }));
        }
      }
    } catch (err) {
      console.error('[WS Server] 消息解析失败:', err.message);
    }
  }

  _rejectPendingRequests(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
