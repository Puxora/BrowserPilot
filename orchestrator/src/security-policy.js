// BrowserPilot - 统一浏览器操作安全策略

const SENSITIVE_ACTIONS = new Set([
  'click', 'type', 'execute', 'clickNode', 'typeNode', 'clickText',
  'clickRole', 'typeByLabel', 'visualStart', 'closeTab', 'finalizeTabs'
]);

export function normalizeHostname(value) {
  const host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || /[^a-z0-9.-]/.test(host)) return null;
  if (host.includes('..') || host.startsWith('.') || host.endsWith('.')) return null;
  return host;
}

export function hostMatches(host, allowedHost) {
  const normalizedHost = normalizeHostname(host);
  const normalizedAllowed = normalizeHostname(allowedHost);
  return Boolean(normalizedHost && normalizedAllowed &&
    (normalizedHost === normalizedAllowed || normalizedHost.endsWith(`.${normalizedAllowed}`)));
}

export class BrowserOperationPolicy {
  constructor({ getStore, wsServer, requestApproval }) {
    this.getStore = getStore;
    this.wsServer = wsServer;
    this.requestApproval = requestApproval;
  }

  async authorize(action, { params = {}, tabId, signal } = {}) {
    if (!SENSITIVE_ACTIONS.has(action)) return;

    const settings = await this.getStore().getSettings();
    if (action === 'execute' && !settings.cdpEnabled) {
      throw new Error('执行页面 JavaScript 已被安全策略禁用，请在设置中开启开发者模式');
    }

    let needsApproval = settings.approval === 'always';
    const host = await this._getTabHostname(tabId);
    if (host) {
      const sitePermission = settings.sitePermissions.find(permission => hostMatches(host, permission.site));
      if (sitePermission) needsApproval = sitePermission.approval === 'always';
    }

    if (needsApproval) {
      await this.requestApproval({ action, params, tabId, signal });
    }
  }

  async _getTabHostname(tabId) {
    if (!Number.isInteger(tabId)) return null;
    try {
      const tabs = await this.wsServer.sendCommand('listTabs', {}, undefined);
      const tab = tabs.find(item => item.id === tabId);
      return tab?.url ? new URL(tab.url).hostname : null;
    } catch {
      // 获取域名失败时保留全局策略，不放宽权限。
      return null;
    }
  }
}
