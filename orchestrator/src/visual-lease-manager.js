/**
 * Tracks BrowserPilot's visual-control overlays for MCP sessions.
 * A lease prevents an overlay from surviving when a client crashes before
 * it can send browser_release_tab.
 */
export class VisualLeaseManager {
  constructor(wsServer, leaseMs) {
    this.wsServer = wsServer;
    this.leaseMs = leaseMs;
    this.leases = new Map();
    this.cancelled = new Map();
    this.inFlight = new Map();
    this.nextGeneration = 0;
  }

  start(tabId, sessionId) {
    if (!Number.isInteger(tabId) || !sessionId) return;
    this.cancelled.delete(tabId);
    this._replace(tabId, sessionId);
  }

  refresh(tabId, sessionId) {
    const lease = this.leases.get(tabId);
    if (!lease || lease.sessionId !== sessionId) return;
    this._replace(tabId, sessionId);
  }

  owns(tabId, sessionId) {
    return this.leases.get(tabId)?.sessionId === sessionId;
  }

  has(tabId) {
    return this.leases.has(tabId);
  }

  isCancelled(tabId, sessionId) {
    if (!Number.isInteger(tabId) || !sessionId) return false;
    return this.cancelled.get(tabId) === sessionId;
  }

  register(tabId, sessionId, controller) {
    if (!Number.isInteger(tabId) || !sessionId || !controller) return;
    const key = `${tabId}:${sessionId}`;
    let controllers = this.inFlight.get(key);
    if (!controllers) {
      controllers = new Set();
      this.inFlight.set(key, controllers);
    }
    controllers.add(controller);
    // 从请求开始而不是完成后续租，避免接近租约边界的长操作被旧计时器中断。
    this.refresh(tabId, sessionId);
  }

  unregister(tabId, sessionId, controller) {
    const key = `${tabId}:${sessionId}`;
    const controllers = this.inFlight.get(key);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) this.inFlight.delete(key);
  }

  cancel(tabId) {
    const lease = this.leases.get(tabId);
    if (!lease) return false;
    this.cancelled.set(tabId, lease.sessionId);
    const key = `${tabId}:${lease.sessionId}`;
    for (const controller of this.inFlight.get(key) || []) controller.abort();
    this.inFlight.delete(key);
    this.release(tabId, lease.sessionId);
    return true;
  }

  release(tabId, sessionId) {
    const lease = this.leases.get(tabId);
    if (!lease || (sessionId && lease.sessionId !== sessionId)) return;
    clearTimeout(lease.timer);
    this.leases.delete(tabId);
  }

  releaseMany(tabIds, sessionId) {
    for (const tabId of tabIds) this.release(tabId, sessionId);
  }

  async stop() {
    const tabIds = [...this.leases.keys()];
    for (const lease of this.leases.values()) clearTimeout(lease.timer);
    for (const controllers of this.inFlight.values()) {
      for (const controller of controllers) controller.abort();
    }
    this.leases.clear();
    this.cancelled.clear();
    this.inFlight.clear();

    await Promise.allSettled(tabIds.map((tabId) => this._stopOverlay(tabId, 'daemon_stopped')));
  }

  _replace(tabId, sessionId) {
    const existing = this.leases.get(tabId);
    if (existing) clearTimeout(existing.timer);

    const generation = ++this.nextGeneration;
    const timer = setTimeout(() => {
      void this._expire(tabId, sessionId, generation);
    }, this.leaseMs);
    timer.unref?.();

    this.leases.set(tabId, { sessionId, generation, timer });
  }

  async _expire(tabId, sessionId, generation) {
    const lease = this.leases.get(tabId);
    if (!lease || lease.sessionId !== sessionId || lease.generation !== generation) return;

    // 正在执行的浏览器命令拥有优先权。重新计时，待命令完成并进入空闲期后再回收。
    const key = `${tabId}:${sessionId}`;
    if ((this.inFlight.get(key)?.size || 0) > 0) {
      this._replace(tabId, sessionId);
      return;
    }

    this.leases.delete(tabId);
    console.log(`[Web UI] 控制租约到期，关闭提示条: tab ${tabId}`);
    await this._stopOverlay(tabId, 'lease_expired');
  }

  async _stopOverlay(tabId, reason) {
    try {
      await this.wsServer.sendCommand('visualStop', { reason }, tabId);
    } catch (err) {
      console.warn(`[Web UI] 自动关闭提示条失败 (tab ${tabId}):`, err.message);
    }
  }
}
