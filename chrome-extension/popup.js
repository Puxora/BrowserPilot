// BrowserPilot — Popup 脚本
// 职责：向 background 查询连接状态、渲染 UI、触发重连/打开管理面板。
// 通信协议：所有消息带 { source: 'popup', type }, background 通过 source 过滤。

(() => {
  'use strict';

  // ── DOM 引用 ─────────────────────────────
  const statusBadge = document.getElementById('statusBadge');
  const refreshBtn = document.getElementById('refreshBtn');
  const dashboardBtn = document.getElementById('dashboardBtn');
  const hostNameEl = document.getElementById('hostName');
  const versionEl = document.getElementById('version');
  const lastConnectedRow = document.getElementById('lastConnectedRow');
  const lastConnectedEl = document.getElementById('lastConnected');

  // ── i18n：在静态占位之外动态注入文案 ────
  function applyI18n() {
    const nodes = document.querySelectorAll('[data-i18n]');
    nodes.forEach((node) => {
      const key = node.getAttribute('data-i18n');
      const msg = chrome.i18n.getMessage(key);
      if (msg) node.textContent = msg;
    });
    const titled = document.querySelectorAll('[data-i18n-title]');
    titled.forEach((node) => {
      const key = node.getAttribute('data-i18n-title');
      const msg = chrome.i18n.getMessage(key);
      if (msg) node.setAttribute('title', msg);
    });
  }

  // ── 与 background 通信 ──────────────────
  function send(type) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ source: 'popup', type }, (response) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(response);
      });
    });
  }

  // ── 状态渲染 ─────────────────────────────
  function setState(state) {
    statusBadge.setAttribute('data-state', state);
    const keyMap = {
      connected: 'status_connected',
      connecting: 'status_connecting',
      disconnected: 'status_disconnected',
      checking: 'status_checking',
    };
    statusBadge.textContent = chrome.i18n.getMessage(keyMap[state] || 'status_checking');
  }

  function formatTimestamp(ts) {
    if (!ts) return chrome.i18n.getMessage('never_connected');
    try {
      return new Date(ts).toLocaleTimeString();
    } catch {
      return chrome.i18n.getMessage('never_connected');
    }
  }

  function renderStatus(status) {
    if (!status) {
      setState('checking');
      return;
    }

    if (status.connected) {
      setState('connected');
    } else if (status.connecting) {
      setState('connecting');
    } else {
      setState('disconnected');
    }

    hostNameEl.textContent = status.hostName || '--';
    versionEl.textContent = status.version || '--';

    // 上次连接时间（仅在有值时显示该行）
    if (status.lastConnectedAt) {
      lastConnectedRow.hidden = false;
      lastConnectedEl.textContent = formatTimestamp(status.lastConnectedAt);
    } else {
      lastConnectedRow.hidden = true;
    }

  }

  // ── 操作 ─────────────────────────────────
  async function refreshStatus(isSilent = false) {
    if (!isSilent) {
      setState('checking');
    }
    try {
      const status = await send('getStatus');
      renderStatus(status);
    } catch (err) {
      // background 未就绪或 SW 异常
      renderStatus({
        connected: false,
        connecting: false,
      });
    }
  }

  async function reconnect() {
    try {
      const current = await send('getStatus');
      if (current && current.connected) {
        // 已经是连接状态时，只做状态刷新
        await refreshStatus(false);
        return;
      }
    } catch (err) {}

    // 未连接或重连状态下，发起重连
    setState('connecting');
    refreshBtn.classList.add('spinning');
    refreshBtn.disabled = true;
    refreshBtn.setAttribute('aria-busy', 'true');
    try {
      await send('reconnect');
      await refreshStatus(false);
    } catch (err) {
      renderStatus({ connected: false, connecting: false });
    } finally {
      refreshBtn.classList.remove('spinning');
      refreshBtn.disabled = false;
      refreshBtn.removeAttribute('aria-busy');
    }
  }

  async function openDashboard() {
    try {
      await send('openDashboard');
      window.close();
    } catch (err) {
      // 打开失败保留 popup 供用户查看
    }
  }

  // ── 初始化 ───────────────────────────────
  function bindEvents() {
    refreshBtn.addEventListener('click', reconnect);
    dashboardBtn.addEventListener('click', openDashboard);
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyI18n();
    bindEvents();
    refreshStatus(false);

    // 只要 Popup 是打开的，每秒自动进行一次静默刷新，确保异步握手成功时 UI 自动跳到“已连接”
    setInterval(() => {
      refreshStatus(true);
    }, 1000);
  });
})();
