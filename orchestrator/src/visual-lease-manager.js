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
  }

  start(tabId, sessionId) {
    if (!Number.isInteger(tabId) || !sessionId) return;
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
    this.leases.clear();

    await Promise.allSettled(tabIds.map((tabId) => this._stopOverlay(tabId, 'daemon_stopped')));
  }

  _replace(tabId, sessionId) {
    const existing = this.leases.get(tabId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      void this._expire(tabId, sessionId);
    }, this.leaseMs);
    timer.unref?.();

    this.leases.set(tabId, { sessionId, timer });
  }

  async _expire(tabId, sessionId) {
    const lease = this.leases.get(tabId);
    if (!lease || lease.sessionId !== sessionId) return;

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
