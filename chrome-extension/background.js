// BrowserPilot - Background Service Worker
// MV3 事件驱动设计：Service Worker 由事件激活，不依赖顶层代码
// 职责：Native Messaging 通信管理 + 指令路由到 content script

importScripts('capture-visible-tab.js', 'control-favicon.js');

const NATIVE_HOST_NAME = 'com.browserpilot.bridge';
const CONTENT_SCRIPT_CAPABILITY = 'page-layout-offset-v1';
const CONTENT_SCRIPT_FILES = Object.freeze(['page-layout-offset.js', 'content.js']);
const CONTENT_SCRIPT_UPGRADE_FILES = Object.freeze([
  'page-layout-offset.js',
  'page-layout-offset-bootstrap.js'
]);
const CONTROL_FAVICON_URL_PREFIX = chrome.runtime.getURL('icons/control-status-');
const EMPTY_FAVICON_URL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E";
// ── 状态 ──────────────────────────────────
let nativePort = null;
let nativeHandshaken = false;        // 收到 host 回包后才置 true，是真实连接判据
let lastConnectedAt = null;          // 上次握手成功时间戳 (Date.now())
let lastErrorMessage = null;         // 最近一次断开/连接失败的错误信息
let reconnectTimer = null;
let keepAliveTimer = null;
const RECONNECT_DELAY = 3000;
const KEEP_ALIVE_INTERVAL = 25000; // 低于 Chrome 30s 休眠阈值
// Chrome 对 tabs.captureVisibleTab 有很低的全局速率限制（通常每秒最多两次）。
// 所有普通/长截图共用这条队列，避免多个 Agent 或滚动拼接彼此打爆额度。
const CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS = 650;
const CAPTURE_VISIBLE_TAB_MAX_ATTEMPTS = 3;

// 待处理请求映射
const pendingRequests = new Map();
let requestIdCounter = 0;
const captureQueue = new BrowserPilotCaptureVisibleTabQueue({
  chromeApi: chrome,
  minIntervalMs: CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS,
  maxAttempts: CAPTURE_VISIBLE_TAB_MAX_ATTEMPTS,
});

// 可视化调试：当前正在自动化控制的标签页状态
// key: tabId, value: { startedAt, label, cancelled }
const activeAutomationTabs = new Map();
// 浏览器控制会话与可视化提示分离：下载/上传策略必须覆盖无提示条的定时任务。
const controlledTabs = new Set();
const pendingUploads = new Map();

// ── 事件监听器（激活 Service Worker） ────

// 安装/更新时触发
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Background] 扩展已安装/更新，正在激活...');
  startConnection();
  void BrowserPilotControlFavicon.clearStale(chrome);
});

// Chrome 启动时触发
chrome.runtime.onStartup.addListener(() => {
  console.log('[Background] Chrome 启动，正在激活...');
  startConnection();
  void BrowserPilotControlFavicon.clearStale(chrome);
});

// ── Native Messaging 连接管理 ─────────────

function startConnection() {
  // 清除已有连接
  if (nativePort) {
    try { nativePort.disconnect(); } catch {}
    nativePort = null;
  }
  nativeHandshaken = false;
  // 重新发起连接时清空旧错误，让 popup 状态反映「正在尝试」而非上一次的失败
  lastErrorMessage = null;
  connectNative();
}

function connectNative() {
  try {
    console.log('[Background] 连接 Native Host:', NATIVE_HOST_NAME);
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener(handleNativeMessage);
    nativePort.onDisconnect.addListener(handleDisconnect);

    // 发送 ready 信号
    sendToNative({ id: 'init', type: 'ready', payload: {} });

    // 启动 keep-alive 定时器
    startKeepAlive();

    // 注意：connectNative() 是异步的——此处仅表示已发起连接，
    // 真正建立需等到收到 host 的回包。真正的失败走 onDisconnect。
    console.log('[Background] 已发起 Native Host 连接（等待握手...）');
  } catch (err) {
    console.error('[Background] connectNative 抛出异常:', err.message);
    lastErrorMessage = err.message;
    scheduleReconnect();
  }
}

// 收到 host 的第一条消息时，确认连接真正可用
function markHandshake() {
  if (!nativeHandshaken) {
    nativeHandshaken = true;
    lastConnectedAt = Date.now();
    lastErrorMessage = null;
    console.log('[Background] ✅ Native Host 连接已建立（握手成功）');
  }
}

function handleDisconnect() {
  const lastError = chrome.runtime.lastError;
  const errMsg = lastError ? lastError.message : '(无 lastError)';
  const hadShake = nativeHandshaken;
  console.warn('[Background] Native Host 断开:', errMsg, hadShake ? '[已握手过]' : '[从未握手——host 未真正启动]');

  nativePort = null;
  nativeHandshaken = false;
  lastErrorMessage = errMsg;
  stopKeepAlive();

  // 拒绝所有待处理请求
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('连接已断开'));
  }
  pendingRequests.clear();

  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log('[Background] 计划重连...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, RECONNECT_DELAY);
}

// ── Keep-alive ────────────────────────────

function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    if (nativePort) {
      sendToNative({ id: 'ka', type: 'ping', payload: {} });
    }
  }, KEEP_ALIVE_INTERVAL);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// ── 消息处理 ───────────────────────────────

function handleNativeMessage(msg) {
  markHandshake(); // 收到任何 host 回包即视为连接真正可用
  const { id, type, payload } = msg;
  console.log('[Background] 收到 Native 消息:', { id, type, action: payload?.action });

  if (type === 'command' && payload) {
    handleCommand(id, payload);
  } else if (type === 'pong') {
    // 心跳响应，忽略
  }
}

async function handleCommand(requestId, command) {
  // 统一转换 tabId 为数字类型，确保 Chrome 扩展 API 不会因 String 类型而报错
  if (command.tabId !== undefined && command.tabId !== null) {
    const numId = parseInt(command.tabId, 10);
    if (!isNaN(numId)) {
      command.tabId = numId;
    }
  }
  if (command.params && command.params.tabId !== undefined && command.params.tabId !== null) {
    const numId = parseInt(command.params.tabId, 10);
    if (!isNaN(numId)) {
      command.params.tabId = numId;
    }
  }

  const { action, tabId, params = {} } = command;

  // 如果是改变页面状态的动作，自动激活并聚焦对应标签页，让用户能看见 AI 的操作
  const ACTIVE_SWITCH_ACTIONS = [
    'claimTab', 'navigate', 'click', 'type', 'scroll', 'execute', 
    'clickNode', 'typeNode', 'clickText', 'clickRole', 'typeByLabel', 
    'visualStart', 'goBack', 'goForward', 'reload'
  ];
  if (ACTIVE_SWITCH_ACTIONS.includes(action)) {
    const targetId = command.tabId || (command.params && command.params.tabId);
    if (targetId) {
      await ensureTabActiveAndFocused(targetId);
    }
  }

  try {
    let result;
    switch (action) {
      case 'resumeDownload':
        if (chrome.downloads) {
          clearDownloadApprovalAlarm(params.downloadId);
          await chrome.downloads.resume(params.downloadId);
          result = { ok: true, status: 'resumed' };
        } else {
          throw new Error('downloads API 不可用');
        }
        break;
      case 'cancelDownload':
        if (chrome.downloads) {
          clearDownloadApprovalAlarm(params.downloadId);
          await chrome.downloads.cancel(params.downloadId);
          try { await chrome.downloads.erase({ id: params.downloadId }); } catch {}
          result = { ok: true, status: 'cancelled' };
        } else {
          throw new Error('downloads API 不可用');
        }
        break;
      case 'approveUpload':
        result = resolveUploadRequest(params.uploadId, true);
        break;
      case 'rejectUpload':
        result = resolveUploadRequest(params.uploadId, false);
        break;
      case 'showNotification':
        if (chrome.notifications) {
          await showSystemNotification(params.approvalId, params.title, params.message);
          result = { ok: true };
        } else {
          throw new Error('notifications API 不可用');
        }
        break;
      case 'navigate':
        result = await handleNavigate(tabId, params);
        break;
      case 'click':
      case 'type':
      case 'scroll':
      case 'getContent':
      case 'execute':
      case 'waitForSelector':
      case 'getVisibleDom':
      case 'getDomSnapshot':
      case 'clickNode':
      case 'typeNode':
      case 'clickText':
      case 'clickRole':
      case 'typeByLabel':
        result = await executeInTab(tabId, { action, params });
        break;
      // ── 可视化调试 action：转发到 content script ──
      case 'visualStart':
        result = await handleVisualStart(tabId, params);
        break;
      case 'visualStop':
        result = await handleVisualStop(tabId, params);
        break;
      case 'visualUpdate':
      case 'visualPointerMove':
      case 'visualPointerPulse':
        result = await executeInTab(tabId, { action, params });
        break;
      case 'screenshot':
        result = await handleScreenshot(tabId);
        break;
      case 'longScreenshot':
        result = await handleLongScreenshot(tabId, params);
        break;
      case 'listTabs':
        result = await handleListTabs();
        break;
      case 'claimTab':
        result = await handleClaimTab(tabId, params);
        break;
      case 'releaseTab':
        result = await handleReleaseTab(tabId, params);
        break;
      case 'finalizeTabs':
        result = await handleFinalizeTabs(params);
        break;
      case 'createTab':
        result = await handleCreateTab(params);
        break;
      case 'closeTab':
        result = await handleCloseTab(tabId || params.tabId);
        break;
      case 'goBack':
        result = await handleGoBack(tabId);
        break;
      case 'goForward':
        result = await handleGoForward(tabId);
        break;
      case 'reload':
        result = await handleReload(tabId);
        break;
      case 'waitForLoad':
        result = await handleWaitForLoad(tabId, params);
        break;
      case 'waitForNavigation':
        result = await handleWaitForNavigation(tabId, params);
        break;
      default:
        throw new Error('未知操作: ' + action);
    }

    sendToNative({
      id: requestId,
      type: 'result',
      payload: { success: true, data: result }
    });
    console.log('[Background] 命令执行成功:', { id: requestId, action });
  } catch (err) {
    sendToNative({
      id: requestId,
      type: 'result',
      payload: { success: false, error: err.message }
    });
    console.warn('[Background] 命令执行失败:', { id: requestId, action, error: err.message });
  }
}

// ── 浏览器操作实现 ─────────────────────────

async function handleNavigate(tabId, params) {
  // 未明确指定目标时必须新建标签页。直接复用活动标签页可能覆盖承载
  // Agent/DSH Web UI 的页面，导致控制端把自己导航走。
  let targetTabId = tabId;
  if (!targetTabId) {
    const created = await tabsCreate({ url: 'about:blank', active: true });
    targetTabId = created.id;
  }
  await tabsUpdate(targetTabId, { url: params.url });
  await waitForTabLoad(targetTabId, params.waitTimeout || 30000);
  const tab = await tabsGet(targetTabId);
  // title 清洗为可打印 ASCII，避免 native msgLen 错位（见 handleListTabs 注释）
  return { tabId: targetTabId, url: stripControlChars(tab.url), title: toAsciiTitle(tab.title) };
}

async function executeInTab(tabId, command) {
  const targetTabId = tabId || await getActiveTabId();
  await ensureContentScriptInjected(targetTabId);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('操作超时: ' + command.action + ' (tab:' + targetTabId + ')'));
    }, 30000);

    chrome.tabs.sendMessage(targetTabId, { ...command, requestId: ++requestIdCounter }, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response?.result || response);
      }
    });
  });
}

async function handleScreenshot(tabId) {
  const targetTabId = tabId || await getActiveTabId();
  const dataUrl = await captureTabImage(targetTabId, { format: 'png' });
  return { tabId: targetTabId, screenshot: dataUrl };
}

async function handleLongScreenshot(tabId, params = {}) {
  const targetTabId = tabId || await getActiveTabId();
  // 始终使用滚动拼接。旧客户端即使继续传 strategy=debugger 也会安全降级，
  // 从执行层保证 BrowserPilot 不再触发 Chrome 原生调试提示栏。
  return captureFullPageByStitching(targetTabId, params);
}

async function captureFullPageByStitching(tabId, params = {}) {
  await ensureContentScriptInjected(tabId);
  const maxHeight = clampNumber(params.maxHeight, 1000, 50000, 30000);
  // 额外页面稳定等待不能低于抓图队列的安全间隔，避免单任务本身超额调用。
  const delayMs = clampNumber(params.delayMs, CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS, 3000, CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS);
  const hideFixed = params.hideFixed !== false;
  const capture = await executeInPageWorld(tabId, getScreenshotPageState);
  const viewportWidth = Math.ceil(capture.viewportWidth);
  const viewportHeight = Math.ceil(capture.viewportHeight);
  const pageHeight = Math.min(Math.ceil(capture.pageHeight), maxHeight);
  const originalY = Math.ceil(capture.scrollY || 0);

  if (!viewportWidth || !viewportHeight || !pageHeight) {
    throw new Error('无法读取页面或视口尺寸');
  }

  const segments = [];
  const scrollPositions = buildScrollPositions(pageHeight, viewportHeight);

  try {
    if (hideFixed) {
      await executeInPageWorld(tabId, hideFixedElementsForScreenshot);
    }

    for (const y of scrollPositions) {
      await executeInPageWorld(tabId, scrollToForScreenshot, [y]);
      await sleep(delayMs);
      const dataUrl = await captureTabImage(tabId, { format: 'png' });
      segments.push({
        dataUrl,
        sourceY: y,
        clipY: y === 0 ? 0 : Math.max(0, pageHeight - y < viewportHeight ? viewportHeight - (pageHeight - y) : 0),
        drawY: y,
        height: Math.min(viewportHeight, pageHeight - y)
      });
    }

    const stitched = await stitchScreenshots(segments, viewportWidth, pageHeight);
    return {
      tabId,
      strategy: 'stitch',
      format: 'png',
      width: stitched.width,
      height: stitched.height,
      fullHeight: Math.ceil(capture.pageHeight),
      truncated: Math.ceil(capture.pageHeight) > pageHeight,
      parts: segments.length,
      screenshot: stitched.dataUrl
    };
  } finally {
    if (hideFixed) {
      await executeInPageWorld(tabId, restoreFixedElementsForScreenshot).catch(() => {});
    }
    await executeInPageWorld(tabId, scrollToForScreenshot, [originalY]).catch(() => {});
  }
}

function getScreenshotPageState() {
  const doc = document.documentElement;
  const body = document.body;
  return {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollY: window.scrollY,
    pageHeight: Math.max(
      doc.scrollHeight,
      body?.scrollHeight || 0,
      doc.offsetHeight,
      body?.offsetHeight || 0,
      doc.clientHeight
    )
  };
}

function scrollToForScreenshot(y) {
  window.scrollTo(0, y);
  return { scrollY: window.scrollY };
}

function hideFixedElementsForScreenshot() {
  const hidden = [];
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const style = window.getComputedStyle(el);
    if ((style.position === 'fixed' || style.position === 'sticky') && el.offsetWidth && el.offsetHeight) {
      const rect = el.getBoundingClientRect();
      if (rect.width * rect.height > 1200) {
        hidden.push([el, el.style.visibility]);
        el.style.visibility = 'hidden';
      }
    }
  }
  // BrowserPilot overlay 挂在 document.documentElement 下，不在 body 的扫描范围。
  // 单独隐藏它，并撤销提示条预留的顶部空间，避免每一个拼接片段重复出现控制条。
  const overlayRoot = document.getElementById('ca-visual-overlay-root');
  if (overlayRoot) {
    hidden.push([overlayRoot, overlayRoot.style.visibility]);
    overlayRoot.style.visibility = 'hidden';
  }
  const overlayLayoutStyle = document.createElement('style');
  overlayLayoutStyle.id = 'ca-long-screenshot-overlay-suppression';
  overlayLayoutStyle.textContent = `
html[data-ca-visual-banner-offset="browserpilot-active"] {
  padding-top: var(--ca-visual-page-padding-top, 0px) !important;
}
`;
  document.documentElement.appendChild(overlayLayoutStyle);
  window.__chromeAutomationLongScreenshotHidden = { hidden, overlayLayoutStyle };
  return { hidden: hidden.length };
}

function restoreFixedElementsForScreenshot() {
  const state = window.__chromeAutomationLongScreenshotHidden || {};
  const hidden = state.hidden || [];
  for (const [el, visibility] of hidden) {
    if (el && el.style) el.style.visibility = visibility;
  }
  state.overlayLayoutStyle?.remove();
  delete window.__chromeAutomationLongScreenshotHidden;
  return { restored: hidden.length };
}

function buildScrollPositions(pageHeight, viewportHeight) {
  const positions = [];
  for (let y = 0; y < pageHeight; y += viewportHeight) {
    positions.push(Math.min(y, Math.max(0, pageHeight - viewportHeight)));
    if (positions[positions.length - 1] + viewportHeight >= pageHeight) break;
  }
  return Array.from(new Set(positions));
}

async function stitchScreenshots(segments, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);

  for (const segment of segments) {
    const bitmap = await createImageBitmap(await dataUrlToBlob(segment.dataUrl));
    try {
      const sourceWidth = Math.min(bitmap.width, width);
      const targetHeight = Math.min(segment.height, height - segment.drawY);
      ctx.drawImage(
        bitmap,
        0,
        segment.clipY,
        sourceWidth,
        targetHeight,
        0,
        segment.drawY,
        sourceWidth,
        targetHeight
      );
    } finally {
      bitmap.close();
    }
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return {
    width,
    height,
    dataUrl: 'data:image/png;base64,' + await blobToBase64(blob)
  };
}

async function handleListTabs() {
  const tabs = await tabsQuery({});
  // 保留原始 title 方便 agent 按中文标题识别标签页；同时提供 titleAscii 作为
  // 老客户端或日志系统的降级字段。Native relay 已按二进制帧处理 UTF-8。
  return tabs.map(t => ({
    id: t.id,
    windowId: t.windowId,
    url: stripControlChars(t.url),
    title: stripControlChars(t.title),
    titleAscii: toAsciiTitle(t.title),
    active: t.active
  }));
}

/** 去除控制字符（0x00-0x1F、0x7F），保留其余字符。 */
function stripControlChars(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/[\x00-\x1f\x7f]/g, '');
}

/** 将 title 转成纯可打印 ASCII：非 ASCII / 控制字符一律丢弃。 */
function toAsciiTitle(s) {
  if (typeof s !== 'string') return s;
  // 仅保留 0x20-0x7E 可打印 ASCII，其余丢弃；折叠连续空格
  return s.replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function handleCreateTab(params) {
  const tab = await tabsCreate({ url: params.url || 'about:blank', active: true });
  return { tabId: tab.id, url: tab.url };
}

async function handleClaimTab(tabId, params = {}) {
  const targetTabId = tabId || params.tabId || await getActiveTabId();
  const tab = await tabsGet(targetTabId);
  if (tab.windowId != null) {
    await windowsUpdate(tab.windowId, { focused: true }).catch(() => {});
  }
  await tabsUpdate(targetTabId, { active: true });
  controlledTabs.add(targetTabId);

  const visual = params.visual !== false;
  let visualResult = null;
  if (visual) {
    const label = resolveAutomationLabel(params);
    const activeVisual = activeAutomationTabs.get(targetTabId);
    const visualOptions = {
      label,
      showCancel: params.showCancel !== false,
      theme: params.theme || 'light',
      cursor: params.cursor !== false,
      originalFaviconUrl: activeVisual?.originalFaviconUrl || normalizeOriginalFaviconUrl(tab.favIconUrl),
    };
    let unchanged = activeVisual
      && !activeVisual.cancelled
      && activeVisual.label === visualOptions.label
      && activeVisual.showCancel === visualOptions.showCancel
      && activeVisual.theme === visualOptions.theme
      && activeVisual.cursor === visualOptions.cursor;
    if (unchanged) {
      // content overlay 可能因 done 状态自行停止，而后台状态尚未来得及同步。
      // 先做一次无副作用探测；DOM 被 SPA 清理时 visualUpdate 也会自动重建容器。
      const visualState = await executeInTab(targetTabId, {
        action: 'visualUpdate',
        params: {},
      }).catch(() => null);
      unchanged = visualState?.ok === true;
    }
    visualResult = unchanged
      ? { ok: true, started: false, active: true, tabId: targetTabId }
      : await handleVisualStart(targetTabId, visualOptions);
  }

  const current = await tabsGet(targetTabId);
  return {
    tabId: targetTabId,
    windowId: current.windowId,
    url: stripControlChars(current.url),
    title: stripControlChars(current.title),
    titleAscii: toAsciiTitle(current.title),
    visual: visualResult
  };
}

async function handleReleaseTab(tabId, params = {}) {
  const targetTabId = tabId || params.tabId || await getActiveTabId();
  await handleVisualStop(targetTabId, { reason: params.reason || 'released' });
  controlledTabs.delete(targetTabId);
  return { tabId: targetTabId, released: true };
}

async function handleFinalizeTabs(params = {}) {
  const released = [];
  const closed = [];

  const releaseTabIds = Array.isArray(params.releaseTabIds) ? params.releaseTabIds : [];
  for (const id of releaseTabIds) {
    try {
      await handleVisualStop(id, { reason: 'finalized' });
      controlledTabs.delete(id);
      released.push(id);
    } catch (err) {
      console.warn('[Background] finalize release failed:', id, err.message);
    }
  }

  const closeTabIds = Array.isArray(params.closeTabIds) ? params.closeTabIds : [];
  for (const id of closeTabIds) {
    try {
      await tabsRemove(id);
      activeAutomationTabs.delete(id);
      controlledTabs.delete(id);
      closed.push(id);
    } catch (err) {
      console.warn('[Background] finalize close failed:', id, err.message);
    }
  }

  return { released, closed };
}

async function handleCloseTab(tabId) {
  const targetTabId = normalizeRequiredTabId(tabId, 'browser_close_tab 需要明确指定 tabId，避免误关用户页面');
  if (activeAutomationTabs.has(targetTabId)) {
    await handleVisualStop(targetTabId, { reason: 'closed' }).catch(() => {});
  }
  await tabsRemove(targetTabId);
  controlledTabs.delete(targetTabId);
  return { success: true };
}

async function handleGoBack(tabId) {
  const targetTabId = tabId || await getActiveTabId();
  await navigateHistory(targetTabId, 'back');
  const tab = await tabsGet(targetTabId);
  return { url: stripControlChars(tab.url), title: toAsciiTitle(tab.title) };
}

async function handleGoForward(tabId) {
  const targetTabId = tabId || await getActiveTabId();
  await navigateHistory(targetTabId, 'forward');
  const tab = await tabsGet(targetTabId);
  return { url: stripControlChars(tab.url), title: toAsciiTitle(tab.title) };
}

async function navigateHistory(tabId, direction) {
  const before = await tabsGet(tabId);
  const beforeUrl = before.url || '';
  const timeoutMs = 8000;
  const friendlyError = direction === 'back'
    ? '该标签页无后退历史，无法后退一步'
    : '该标签页无前进历史，无法前进一步';

  try {
    if (direction === 'back') {
      await tabsGoBack(tabId);
    } else {
      await tabsGoForward(tabId);
    }
  } catch (err) {
    // 某些 Chrome/扩展环境会在可导航时仍对 tabs.goBack/goForward 抛出
    // "Cannot find a next page in history."。用页面 History API 做一次兜底。
    await runHistoryFallback(tabId, direction).catch(() => {});
  }

  const changed = await waitForTabUrlChange(tabId, beforeUrl, timeoutMs);
  if (!changed) {
    throw new Error(friendlyError);
  }
  await waitForTabReadyAfterHistory(tabId, 10000);
}

async function runHistoryFallback(tabId, direction) {
  const func = direction === 'back'
    ? () => { window.history.back(); }
    : () => { window.history.forward(); };
  await scriptingExecuteScript({ target: { tabId }, func });
}

async function handleReload(tabId) {
  const targetTabId = tabId || await getActiveTabId();
  await tabsReload(targetTabId);
  await waitForTabLoad(targetTabId, 30000);
  return { success: true };
}

async function handleWaitForLoad(tabId, params = {}) {
  const targetTabId = tabId || params.tabId || await getActiveTabId();
  await waitForTabLoad(targetTabId, params.timeoutMs || 30000);
  const tab = await tabsGet(targetTabId);
  return {
    tabId: targetTabId,
    url: stripControlChars(tab.url),
    title: stripControlChars(tab.title),
    status: tab.status
  };
}

async function handleWaitForNavigation(tabId, params = {}) {
  const targetTabId = tabId || params.tabId || await getActiveTabId();
  const startTab = await tabsGet(targetTabId);
  const fromUrl = params.fromUrl || startTab.url || '';
  const timeoutMs = params.timeoutMs || 15000;
  const urlContains = params.urlContains;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('等待导航超时'));
    }, timeoutMs);

    const finish = async () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      const tab = await tabsGet(targetTabId);
      resolve({
        tabId: targetTabId,
        url: stripControlChars(tab.url),
        title: stripControlChars(tab.title),
        status: tab.status
      });
    };

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== targetTabId) return;
      const nextUrl = tab.url || changeInfo.url || '';
      const changed = nextUrl && nextUrl !== fromUrl;
      const matched = urlContains ? nextUrl.includes(urlContains) : changed;
      if (matched && (changeInfo.status === 'complete' || changeInfo.url)) {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    tabsGet(targetTabId).then(tab => {
      const currentUrl = tab.url || '';
      if (urlContains ? currentUrl.includes(urlContains) : currentUrl !== fromUrl) {
        finish();
      }
    }).catch(() => {});
  });
}

// ── 可视化调试 ─────────────────────────────

/**
 * 开启可视化调试。
 * 维护 activeAutomationTabs 状态；在不可注入页面返回友好错误而非崩溃。
 */
async function handleVisualStart(tabId, params) {
  const targetTabId = tabId || await getActiveTabId();
  const tab = await tabsGet(targetTabId).catch(() => null);
  const existing = activeAutomationTabs.get(targetTabId);

  const normalizedParams = {
    ...params,
    label: resolveAutomationLabel(params),
    originalFaviconUrl: normalizeOriginalFaviconUrl(params.originalFaviconUrl)
      || existing?.originalFaviconUrl
      || normalizeOriginalFaviconUrl(tab?.favIconUrl),
  };
  delete normalizedParams.message;
  activeAutomationTabs.set(targetTabId, {
    startedAt: existing?.startedAt || Date.now(),
    label: normalizedParams.label,
    cancelled: false,
    showCancel: normalizedParams.showCancel !== false,
    theme: normalizedParams.theme || 'light',
    cursor: normalizedParams.cursor !== false,
    originalFaviconUrl: normalizedParams.originalFaviconUrl || null,
  });

  // 检查目标页面是否可注入 content script
  const injectable = await isTabInjectable(targetTabId);
  if (!injectable.ok) {
    return { ok: false, error: injectable.error, tabId: targetTabId };
  }

  let result;
  try {
    result = await executeInTab(targetTabId, { action: 'visualStart', params: normalizedParams });
  } catch (err) {
    console.warn('[Background] 可视化控制将在页面就绪后恢复:', err.message);
    return { ok: false, pending: true, error: err.message, tabId: targetTabId };
  }
  console.log('[Background] 可视化调试已开启 tab:', targetTabId);
  return { ...result, tabId: targetTabId };
}

/** 关闭可视化调试，清理状态。 */
async function handleVisualStop(tabId, params) {
  const targetTabId = tabId || await getActiveTabId();
  let result = { ok: true, stopped: true };
  try {
    result = await executeInTab(targetTabId, { action: 'visualStop', params });
  } catch (err) {
    // 页面已关闭/跳转时 stop 不应报错，仍清理状态
    console.warn('[Background] visualStop 转发失败（已忽略）:', err.message);
  }
  activeAutomationTabs.delete(targetTabId);
  console.log('[Background] 可视化调试已关闭 tab:', targetTabId);
  return result;
}

/**
 * 判断目标 tab 是否可注入 content script。
 * chrome://、扩展页面、PDF 等无法注入，需返回友好中文错误。
 */
async function isTabInjectable(tabId) {
  try {
    const tab = await tabsGet(tabId);
    const url = tab.url || '';
    const blocked = ['chrome://', 'chrome-extension://', 'edge://', 'about:',
                     'https://chrome.google.com/webstore', 'https://chromewebstore.google.com'];
    for (const prefix of blocked) {
      if (url.startsWith(prefix)) {
        return { ok: false, error: `当前页面不支持可视化调试: ${url}` };
      }
    }
    // PDF viewer 也无法注入
    if (tab.status === 'complete' && /\.(pdf)$/i.test(url)) {
      return { ok: false, error: 'PDF 页面不支持可视化调试' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: '无法读取标签页信息: ' + err.message };
  }
}

/** 返回所有正在可视化调试的 tab 状态（供 popup/查询用）。 */
function getActiveAutomationTabs() {
  return Array.from(activeAutomationTabs.entries()).map(([tabId, info]) => ({
    tabId, ...info,
  }));
}

function resolveAutomationLabel(params = {}) {
  const label = params.label || params.clientName || 'BrowserPilot';
  return stripControlChars(String(label)).trim() || 'BrowserPilot';
}

// ── 工具函数 ───────────────────────────────

async function ensureTabActiveAndFocused(tabId) {
  if (tabId == null) return;
  const numericTabId = parseInt(tabId, 10);
  if (isNaN(numericTabId)) return;
  try {
    const tab = await tabsGet(numericTabId);
    if (tab) {
      if (!tab.active) {
        await tabsUpdate(numericTabId, { active: true });
        console.log(`[Background] 已将标签页切为活动状态: ${numericTabId}`);
      }
      if (tab.windowId != null) {
        await windowsUpdate(tab.windowId, { focused: true }).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[Background] 自动激活/聚焦标签页失败:', err.message);
  }
}

async function getActiveTabId() {
  const tabs = await tabsQuery({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error('未找到活动标签页');
  return tabs[0].id;
}

function normalizeRequiredTabId(tabId, errorMessage) {
  const numericTabId = parseInt(tabId, 10);
  if (!Number.isFinite(numericTabId)) {
    throw new Error(errorMessage);
  }
  return numericTabId;
}

function waitForTabUrlChange(tabId, fromUrl, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (changed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(changed);
    };

    const timer = setTimeout(async () => {
      try {
        const tab = await tabsGet(tabId);
        finish(Boolean(tab.url && tab.url !== fromUrl));
      } catch {
        finish(false);
      }
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      const nextUrl = changeInfo.url || tab?.url || '';
      if (nextUrl && nextUrl !== fromUrl) finish(true);
    };

    chrome.tabs.onUpdated.addListener(listener);

    tabsGet(tabId)
      .then(tab => finish(Boolean(tab.url && tab.url !== fromUrl)))
      .catch(() => {});
  });
}

function waitForTabReadyAfterHistory(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };

    chrome.tabs.onUpdated.addListener(listener);
    tabsGet(tabId)
      .then(tab => { if (tab.status === 'complete') finish(); })
      .catch(finish);
  });
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error('页面加载超时 (tab:' + tabId + ')'));
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    // 监听注册后立即读取一次，覆盖监听前后状态变化的竞态。
    tabsGet(tabId).then(tab => {
      if (tab.status === 'complete') finish();
    }).catch(error => finish(error));
  });
}

function chromeCallback(call) {
  return new Promise((resolve, reject) => {
    try {
      call((result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(result);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function tabsQuery(queryInfo) {
  return chromeCallback(done => chrome.tabs.query(queryInfo, done));
}

function tabsGet(tabId) {
  return chromeCallback(done => chrome.tabs.get(tabId, done));
}

function tabsUpdate(tabId, updateProperties) {
  return chromeCallback(done => chrome.tabs.update(tabId, updateProperties, done));
}

function tabsCreate(createProperties) {
  return chromeCallback(done => chrome.tabs.create(createProperties, done));
}

function tabsRemove(tabId) {
  return chromeCallback(done => chrome.tabs.remove(tabId, done));
}

function tabsReload(tabId) {
  return chromeCallback(done => chrome.tabs.reload(tabId, done));
}

function tabsGoBack(tabId) {
  return chromeCallback(done => chrome.tabs.goBack(tabId, done));
}

function tabsGoForward(tabId) {
  return chromeCallback(done => chrome.tabs.goForward(tabId, done));
}

function windowsUpdate(windowId, updateInfo) {
  return chromeCallback(done => chrome.windows.update(windowId, updateInfo, done));
}

async function captureTabImage(tabId, options) {
  return captureQueue.captureTab(tabId, options);
}

function scriptingExecuteScript(details) {
  return chromeCallback(done => chrome.scripting.executeScript(details, done));
}

async function executeInPageWorld(tabId, func, args = []) {
  const [injection] = await scriptingExecuteScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args
  });
  return injection?.result;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function dataUrlToBlob(dataUrl) {
  return fetch(dataUrl).then(res => res.blob());
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function ensureContentScriptInjected(tabId) {
  let response;
  try {
    response = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(response);
      });
    });
  } catch {
    await scriptingExecuteScript({
      target: { tabId },
      world: 'ISOLATED',
      files: CONTENT_SCRIPT_FILES
    });
    await new Promise(r => setTimeout(r, 200));
    return;
  }

  if (!response?.result?.capabilities?.includes(CONTENT_SCRIPT_CAPABILITY)) {
    await scriptingExecuteScript({
      target: { tabId },
      world: 'ISOLATED',
      files: CONTENT_SCRIPT_UPGRADE_FILES
    });
    await new Promise(r => setTimeout(r, 200));
  }
}

function sendToNative(msg) {
  if (nativePort) {
    try {
      console.log('[Background] 发送 Native 消息:', { id: msg.id, type: msg.type, success: msg.payload?.success });
      // Windows + Chrome Native Messaging 在部分环境下会对非 ASCII 字符产生
      // 长度头与实际 UTF-8 字节数不一致的问题。这里将非 ASCII 转成 ASCII
      // 字面量，native-relay 再还原，避免帧边界错位。
      nativePort.postMessage(escapeNonAsciiStrings(msg));
    } catch (err) {
      console.error('[Background] 发送消息失败:', err.message);
    }
  }
}

function escapeNonAsciiStrings(value) {
  if (typeof value === 'string') {
    return value.replace(/[^\x20-\x7e]/g, ch => {
      const code = ch.codePointAt(0);
      if (code <= 0xffff) return '\\u' + code.toString(16).padStart(4, '0');
      const high = Math.floor((code - 0x10000) / 0x400) + 0xd800;
      const low = ((code - 0x10000) % 0x400) + 0xdc00;
      return '\\u' + high.toString(16).padStart(4, '0') +
             '\\u' + low.toString(16).padStart(4, '0');
    });
  }
  if (Array.isArray(value)) return value.map(escapeNonAsciiStrings);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = escapeNonAsciiStrings(child);
    }
    return out;
  }
  return value;
}

// ── Popup 状态查询与操作 ──────────────────

// 返回当前连接状态快照供 popup 渲染。
// 真实连接判据优先用 nativeHandshaken；仅有端口未握手视为 connecting。
function getConnectionStatus() {
  return {
    connected: nativeHandshaken,
    connecting: !!nativePort && !nativeHandshaken,
    hostName: NATIVE_HOST_NAME,
    version: chrome.runtime.getManifest().version,
    lastConnectedAt,
    lastErrorMessage
  };
}

// Popup 与 content script overlay 通过 chrome.runtime.sendMessage 发起请求。
// - source==='popup': popup 状态查询/操作
// - source==='visualOverlay': content script 取消按钮事件
// 注：onMessage 同步返回 true 以保持 sendResponse 通道在异步操作后仍可用。
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request) return;

  // ── 取消按钮事件：来自 content script 的 visualOverlay ──
  if (request.source === 'visualOverlay' && request.type === 'cancelRequested') {
    const tabId = sender.tab?.id;
    handleVisualCancel(tabId, request);
    sendResponse({ ok: true });
    return true;
  }

  if (request.source === 'uploadGuard' && request.type === 'request') {
    requestUploadApproval(sender.tab?.id, request)
      .then(sendResponse)
      .catch(error => sendResponse({ allowed: false, reason: error.message }));
    return true;
  }

  if (request.source !== 'popup') return;

  if (request.type === 'getStatus') {
    sendResponse(getConnectionStatus());
    return true;
  }

  if (request.type === 'reconnect') {
    startConnection();
    sendResponse(getConnectionStatus());
    return true;
  }

  if (request.type === 'openDashboard') {
    chrome.tabs.create({ url: 'http://127.0.0.1:9876/' });
    sendResponse({ ok: true });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  activeAutomationTabs.delete(tabId);
  controlledTabs.delete(tabId);
});

// 页面导航会卸载 content script 与 overlay。加载开始时立即恢复；加载完成时
// 再探测一次并兜底，避免页面脚本重写根节点后清掉提示栏。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const control = activeAutomationTabs.get(tabId);
  if (!control || control.cancelled) return;

  if (typeof changeInfo.url === 'string') control.originalFaviconUrl = null;
  const faviconUrl = normalizeOriginalFaviconUrl(changeInfo.favIconUrl);
  if (faviconUrl) {
    control.originalFaviconUrl = faviconUrl;
    void executeInTab(tabId, {
      action: 'visualUpdate',
      params: { originalFaviconUrl: faviconUrl },
    }).catch(() => {});
  }

  if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;

  void restoreVisualControlAfterNavigation(tabId, control, changeInfo.status);
});

async function restoreVisualControlAfterNavigation(tabId, control, phase) {
  if (phase === 'complete') {
    const visualState = await executeInTab(tabId, {
      action: 'visualUpdate',
      params: {},
    }).catch(() => null);
    if (visualState?.ok === true) return;
  }

  await handleVisualStart(tabId, {
    label: control.label,
    showCancel: control.showCancel,
    theme: control.theme,
    cursor: control.cursor,
    originalFaviconUrl: control.originalFaviconUrl,
  });
}

function normalizeOriginalFaviconUrl(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url || url === EMPTY_FAVICON_URL || url.startsWith(CONTROL_FAVICON_URL_PREFIX)) return null;
  return url;
}

/**
 * 处理取消按钮事件（第一版）。
 * - 标记该 tab 的 cancelled 状态
 * - 向 Native/orchestrator 上报一个 event 消息
 * - 真正的任务级中断留给第二版（abort signal）
 */
function handleVisualCancel(tabId, request) {
  console.log('[Background] 收到取消请求 tab:', tabId, request.url);
  if (tabId != null && activeAutomationTabs.has(tabId)) {
    const info = activeAutomationTabs.get(tabId);
    info.cancelled = true;
  }
  // 向 Native 上报事件（不期待 result 回包）
  sendToNative({
    id: `event-${Date.now()}`,
    type: 'event',
    payload: {
      event: 'visualCancelRequested',
      tabId,
      url: request.url,
      timestamp: Date.now(),
    },
  });
}

async function requestUploadApproval(tabId, request) {
  if (!Number.isInteger(tabId) || !controlledTabs.has(tabId)) {
    return { allowed: true };
  }
  if (!nativeHandshaken) {
    return { allowed: false, reason: 'BrowserPilot 连接未就绪，已阻止打开文件选择器' };
  }

  const uploadId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const decision = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingUploads.delete(uploadId);
      reject(new Error('上传审批超时'));
    }, 30000);
    pendingUploads.set(uploadId, { resolve, reject, timer });
  });

  sendToNative({
    id: `upload-evt-${uploadId}`,
    type: 'event',
    payload: {
      event: 'uploadRequested',
      uploadId,
      tabId,
      accept: String(request.accept || '').slice(0, 500),
      multiple: request.multiple === true,
      timestamp: Date.now()
    }
  });

  try {
    await decision;
    return { allowed: true };
  } catch (error) {
    return { allowed: false, reason: error.message || '文件选择请求被拒绝' };
  } finally {
    const pending = pendingUploads.get(uploadId);
    if (pending) clearTimeout(pending.timer);
    pendingUploads.delete(uploadId);
  }
}

function resolveUploadRequest(uploadId, approved) {
  const pending = pendingUploads.get(String(uploadId));
  if (!pending) return { ok: false, message: '上传请求不存在或已超时' };
  clearTimeout(pending.timer);
  if (approved) pending.resolve();
  else pending.reject(new Error('该文件选择请求被用户拒绝'));
  return { ok: true, approved };
}

// ── 主动激活 ───────────────────────────────

// Service Worker 启动时立刻尝试连接
// 但不要阻塞，允许事件循环继续
setTimeout(startConnection, 100);

// ── 下载拦截管理 ───────────────────────────
//
// 设计原则：
// 1. 后台未连接（未握手）时绝不暂停用户下载 —— 避免未连接时下载被永久卡死。
// 2. 已连接时才走“暂停 → 上报 daemon → 等审批决策”流程。
// 3. 审批超时（DOWNLOAD_APPROVAL_TIMEOUT_MS）默认取消，避免安全策略被静默绕过。
//    超时用 chrome.alarms 而非 setTimeout，
//    因为 MV3 Service Worker 会被 Chrome 回收，setTimeout 会随之丢失。
const DOWNLOAD_APPROVAL_TIMEOUT_MS = 30000;
const DOWNLOAD_ALARM_PREFIX = 'dl-timeout-';

function isDownloadFromControlledTab(downloadItem) {
  const tabId = Number(downloadItem?.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) {
    return false;
  }
  return controlledTabs.has(tabId);
}

if (chrome.downloads) {
  chrome.downloads.onCreated.addListener(async (downloadItem) => {
    console.log('[Background] 捕获到下载项:', downloadItem.id, downloadItem.url, downloadItem.filename);

    // 未连接时直接放行：不暂停、不上报，避免下载被永久卡死。
    if (!nativeHandshaken) {
      console.log('[Background] Native Host 未连接，跳过下载审查，放行下载:', downloadItem.id);
      return;
    }

    // 只审查 BrowserPilot 正在控制的标签页触发的下载。
    // 普通用户手动下载、无法关联到 tab 的下载，一律放行，避免扩展干扰日常浏览。
    if (!isDownloadFromControlledTab(downloadItem)) {
      console.log('[Background] 下载不属于 BrowserPilot 控制中的标签页，直接放行:', {
        downloadId: downloadItem.id,
        tabId: downloadItem.tabId
      });
      return;
    }

    try {
      await chrome.downloads.pause(downloadItem.id);
      console.log('[Background] 下载已暂停，正在上报安全审查...', downloadItem.id);

      // 注册超时兜底 alarm：到期未收到 daemon 决策则取消下载。
      const alarmName = DOWNLOAD_ALARM_PREFIX + downloadItem.id;
      chrome.alarms.create(alarmName, {
        delayInMinutes: DOWNLOAD_APPROVAL_TIMEOUT_MS / 60000
      });

      // 上报下载事件给 Native Host
      sendToNative({
        id: `download-evt-${downloadItem.id}-${Date.now()}`,
        type: 'event',
        payload: {
          event: 'downloadCreated',
          downloadId: downloadItem.id,
          url: downloadItem.url,
          filename: downloadItem.filename || '',
          fileSize: downloadItem.fileSize || 0,
          mime: downloadItem.mime || '',
          tabId: downloadItem.tabId,
          timestamp: Date.now()
        }
      });
    } catch (err) {
      console.error('[Background] 暂停下载或上报失败:', err.message);
    }
  });
}

// 审批超时兜底：安全默认拒绝，避免 daemon 异常时绕过策略。
if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (!alarm.name || !alarm.name.startsWith(DOWNLOAD_ALARM_PREFIX)) return;
    const downloadId = parseInt(alarm.name.slice(DOWNLOAD_ALARM_PREFIX.length), 10);
    if (isNaN(downloadId)) return;

    console.warn('[Background] 下载审批超时，取消下载:', downloadId);
    try {
      await chrome.downloads.cancel(downloadId);
    } catch (err) {
      // 下载可能已被用户手动取消/删除，resume 失败属正常，静默处理。
      console.log('[Background] 超时 resume 失败（可能已取消）:', downloadId, err.message);
    }
  });
}

// daemon 回传决策后清除对应下载的超时 alarm，避免 resume 后又触发超时兜底。
function clearDownloadApprovalAlarm(downloadId) {
  if (chrome.alarms && downloadId != null) {
    chrome.alarms.clear(DOWNLOAD_ALARM_PREFIX + downloadId).catch(() => {});
  }
}

// ── 系统通知管理 ───────────────────────────
const notificationMap = new Map();

async function showSystemNotification(approvalId, title, message) {
  const notificationId = `bp-notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  notificationMap.set(notificationId, approvalId);

  return new Promise((resolve) => {
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: title,
      message: message,
      buttons: [
        { title: '批准' },
        { title: '拒绝' }
      ],
      requireInteraction: true  // Windows 通知中心需要用户明确关闭
    }, (createdId) => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.error('[Background] 创建系统通知失败:', err.message, '| approvalId:', approvalId);
        notificationMap.delete(notificationId);
        resolve(null);
      } else {
        console.log('[Background] ✅ 系统通知已发出:', createdId, '| approvalId:', approvalId);
        resolve(createdId);
      }
    });
  });
}

if (chrome.notifications) {
  chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    const approvalId = notificationMap.get(notificationId);
    if (!approvalId) return;

    const decision = buttonIndex === 0 ? 'approve' : 'reject';
    
    // 审批决策沿已经建立的 Native Relay 回传，避免扩展绕过 API 认证。
    sendToNative({
      type: 'event',
      payload: { event: 'approvalDecision', approvalId, decision }
    });

    chrome.notifications.clear(notificationId);
    notificationMap.delete(notificationId);
  });

  chrome.notifications.onClosed.addListener((notificationId) => {
    notificationMap.delete(notificationId);
  });
}

console.log('[Background] Service Worker 已加载');
