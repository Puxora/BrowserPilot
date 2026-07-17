// BrowserPilot - Web UI 前端核心逻辑
// 纯原生 JavaScript，提供 Glassmorphism 视图交互及安全审批系统

const API = '/api';
const BROWSER_TEST_SESSION_STORAGE_KEY = 'browserpilot.browserTest.sessionId';
let allTasks = [];
let settings = {
  approval: 'always',
  download: 'ask',
  upload: 'ask',
  cdpEnabled: false,
  sitePermissions: []
};
let activeApproval = null;
let pendingConfirm = null;

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

// ── 初始化 ──────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setupLayout();
  setupNavigation();
  setupTaskForm();
  setupBrowserTest();
  setupLogViewer();
  setupSettings();
  refreshStatus();
  loadTasks();
  startApprovalPolling();
  setupTemplateModal();

  // 每 10 秒刷新状态
  setInterval(refreshStatus, 10000);

  // 每 30 秒静默刷新任务列表（更新上次/下次触发时间与运行状态）
  setInterval(() => {
    const tasksView = document.getElementById('view-tasks');
    if (tasksView && tasksView.classList.contains('active')) {
      loadTasks();
    }
  }, 30000);
});

function setupLayout() {
  const toggle = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  if (!toggle || !sidebar) return;

  toggle.addEventListener('click', () => {
    const isOpen = sidebar.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
}

function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebarToggle');
  if (!sidebar || !toggle) return;
  sidebar.classList.remove('is-open');
  toggle.setAttribute('aria-expanded', 'false');
}

// ── 导航切换 ───────────────────────────────

function setupNavigation() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
      closeSidebar();

      if (btn.dataset.view === 'tasks') loadTasks();
      if (btn.dataset.view === 'browser-test') refreshBrowserTestTabs();
      if (btn.dataset.view === 'logs') populateLogTaskSelect();
      if (btn.dataset.view === 'settings') loadSettings();
    });
  });
}

// 方便外部 JS 调用的全局切换视图函数
window.switchView = function(viewName) {
  const btn = document.querySelector(`.nav-btn[data-view="${viewName}"]`);
  if (btn) btn.click();
};

function showToast(message, type = 'info') {
  const region = document.getElementById('toastRegion');
  if (!region) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  region.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function showConfirm(message) {
  const modal = document.getElementById('confirmModal');
  const messageEl = document.getElementById('confirmMessage');
  const acceptBtn = document.getElementById('btnConfirmAccept');
  const cancelBtn = document.getElementById('btnConfirmCancel');

  if (!modal || !messageEl || !acceptBtn || !cancelBtn) return Promise.resolve(false);
  messageEl.textContent = message;
  modal.classList.add('active');
  acceptBtn.focus();

  return new Promise(resolve => {
    pendingConfirm = resolve;
    const close = decision => {
      modal.classList.remove('active');
      pendingConfirm = null;
      resolve(decision);
    };
    acceptBtn.onclick = () => close(true);
    cancelBtn.onclick = () => close(false);
  });
}

// ── 状态刷新 ───────────────────────────────

async function refreshStatus() {
  const daemonStatus = document.getElementById('daemonStatus');
  try {
    const resp = await fetch(`${API}/status`);
    const json = await resp.json();

    const dot = document.getElementById('chromeStatus');
    const txt = document.getElementById('chromeStatusText');
    if (json.chromeConnected) {
      dot.className = 'status-indicator connected';
      txt.textContent = 'Chrome 已连接';
    } else {
      dot.className = 'status-indicator disconnected';
      txt.textContent = 'Chrome 未连接';
    }

    document.getElementById('taskCount').textContent = `${json.taskCount || 0} 个任务`;
    if (daemonStatus) daemonStatus.textContent = '服务正常';
  } catch {
    const dot = document.getElementById('chromeStatus');
    const txt = document.getElementById('chromeStatusText');
    dot.className = 'status-indicator disconnected';
    txt.textContent = '无法连接 Daemon';
    if (daemonStatus) daemonStatus.textContent = '服务不可用';
  }
}

// ── 任务列表 ───────────────────────────────

async function loadTasks() {
  const container = document.getElementById('taskList');
  container.innerHTML = '<div class="empty-state"><p>⏳ 载入任务中...</p></div>';

  try {
    const resp = await fetch(`${API}/tasks`);
    const json = await resp.json();
    allTasks = json.data || [];
    document.getElementById('taskCount').textContent = `${allTasks.length} 个任务`;

    if (!allTasks.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📂</div>
          <p>暂无定时自动化任务</p>
          <button class="btn btn-primary" onclick="switchView('create')">立刻创建任务</button>
        </div>
      `;
      return;
    }

    container.innerHTML = allTasks.map(task => {
      const isEnabled = task.enabled !== false;
      const isRunning = task.isRunning;
      const nextRun = task.nextRun ? formatTime(task.nextRun) : '--';
      const lastRun = task.lastRun ? formatTime(task.lastRun) : '--';
      const lastStatus = task.lastRunStatus;

      let statusBadge = '';
      if (isRunning) {
        statusBadge = '<span class="task-status-badge running">⟳ 执行中</span>';
      } else if (!isEnabled) {
        statusBadge = '<span class="task-status-badge disabled">已停用</span>';
      } else if (lastStatus === 'success') {
        statusBadge = '<span class="task-status-badge success">✓ 就绪</span>';
      } else if (lastStatus === 'error') {
        statusBadge = '<span class="task-status-badge error">✗ 上次失败</span>';
      } else {
        statusBadge = '<span class="task-status-badge idle">待触发</span>';
      }

      return `
        <div class="task-card ${!isEnabled ? 'task-card-disabled' : ''}" data-task-id="${task.id}">
          <div class="task-card-header">
            <div class="task-card-title-row">
              <span class="task-card-name">${esc(task.name)}</span>
              ${statusBadge}
            </div>
            <div class="task-card-header-right">
              <span class="task-card-schedule">${esc(task.schedule)}</span>
              <label class="task-toggle" title="${isEnabled ? '点击停用任务' : '点击启用任务'}">
                <input type="checkbox" aria-label="${isEnabled ? '停用任务' : '启用任务'}" ${isEnabled ? 'checked' : ''} onchange="toggleTask('${task.id}', this)">
                <span class="task-toggle-slider"></span>
              </label>
            </div>
          </div>
          <div class="task-card-desc">${esc(task.description || '暂无描述信息')}</div>
          <div class="task-card-times">
            <div class="task-time-item">
              <span class="task-time-label">上次触发</span>
              <span class="task-time-value ${lastStatus === 'error' ? 'text-danger' : ''}">${lastRun}</span>
            </div>
            <div class="task-time-item">
              <span class="task-time-label">下次触发</span>
              <span class="task-time-value ${!isEnabled ? 'text-muted' : ''}">${isEnabled ? nextRun : '(已停用)'}</span>
            </div>
          </div>
          <div class="task-card-actions">
            <button class="btn ${isRunning ? 'btn-danger' : 'btn-primary'} task-action-btn" onclick="${isRunning ? `cancelTask('${task.id}')` : `runTask('${task.id}')`}" title="${isRunning ? '取消执行' : '立即执行'}">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              ${isRunning ? '取消执行' : '立即执行'}
            </button>
            <button class="btn task-action-btn" onclick="viewTaskLogs('${task.id}')" title="查看日志">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>
              日志
            </button>
            <button class="btn task-action-btn" onclick="viewTaskTemplate('${task.id}')" title="编辑任务配置">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              配置
            </button>
            <button class="btn btn-danger task-action-btn task-delete-btn" onclick="deleteTask('${task.id}')" title="删除任务" aria-label="删除任务 ${esc(task.name)}">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            </button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state">
        <p class="text-danger">加载失败: ${esc(err.message)}</p>
      </div>
    `;
  }
}

async function runTask(taskId) {
  try {
    const resp = await fetch(`${API}/tasks/${taskId}/run`, { method: 'POST' });
    const json = await resp.json();
    if (json.code !== 0) throw new Error(json.message || '任务执行失败');
    showToast(json.message || '任务已触发执行', 'success');
    loadTasks();
  } catch (err) {
    showToast('执行失败：' + err.message, 'error');
  }
}

async function cancelTask(taskId) {
  try {
    const resp = await fetch(`${API}/tasks/${taskId}/cancel`, { method: 'POST' });
    const json = await resp.json();
    if (json.code !== 0) throw new Error(json.message || '取消任务失败');
    showToast(json.message || '已请求取消任务', 'success');
    await loadTasks();
  } catch (err) {
    showToast('取消失败：' + err.message, 'error');
  }
}

async function deleteTask(taskId) {
  if (!await showConfirm('删除后任务定义和执行日志将无法恢复，确定继续吗？')) return;
  try {
    const resp = await fetch(`${API}/tasks/${taskId}`, { method: 'DELETE' });
    const json = await resp.json();
    if (json.code !== 0) throw new Error(json.message || '任务删除失败');
    showToast(json.message || '任务已删除', 'success');
    loadTasks();
  } catch (err) {
    showToast('删除失败：' + err.message, 'error');
  }
}

window.runTask = runTask;
window.cancelTask = cancelTask;
window.deleteTask = deleteTask;

async function toggleTask(taskId, checkboxEl) {
  try {
    const resp = await fetch(`${API}/tasks/${taskId}/toggle`, { method: 'PATCH' });
    const json = await resp.json();
    if (json.code !== 0) {
      showToast('切换失败：' + json.message, 'error');
      // 恢复 checkbox 状态
      checkboxEl.checked = !checkboxEl.checked;
    } else {
      showToast(json.message || '任务状态已更新', 'success');
      // 静默刷新任务列表以更新下次触发时间和状态
      setTimeout(loadTasks, 300);
    }
  } catch (err) {
    showToast('网络错误：' + err.message, 'error');
    checkboxEl.checked = !checkboxEl.checked;
  }
}

window.toggleTask = toggleTask;

window.viewTaskLogs = function(taskId) {
  const btn = document.querySelector('.nav-btn[data-view="logs"]');
  if (btn) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-logs').classList.add('active');
    
    populateLogTaskSelect().then(() => {
      document.getElementById('logTaskSelect').value = taskId;
      loadLogs(taskId);
    });
  }
};

// ── 新建任务表单 ───────────────────────────

function setupTaskForm() {
  document.getElementById('taskForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const source = document.getElementById('taskSource').value.trim();

    if (!source) {
      showFormResult('请填写完整的 JS 任务模块', 'error');
      return;
    }

    try {
      const resp = await fetch(`${API}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source })
      });
      const json = await resp.json();

      if (json.code === 0) {
        showFormResult('✓ 任务创建并应用成功!', 'success');
        showToast('任务已创建并应用', 'success');
        document.getElementById('taskForm').reset();
        setTimeout(() => { switchView('tasks'); }, 1500);
      } else {
        showFormResult(json.message, 'error');
      }
    } catch (err) {
      showFormResult('网络创建失败: ' + err.message, 'error');
    }
  });
}

function showFormResult(msg, type) {
  const el = document.getElementById('formResult');
  el.innerHTML = `<div class="result-msg ${type}">${msg}</div>`;
  if (type === 'success') {
    setTimeout(() => { el.innerHTML = ''; }, 5000);
  }
}

// ── 浏览器即时测试 ───────────────────────────

const TARGETED_BROWSER_TEST_ACTIONS = new Set([
  'navigate', 'getContent', 'screenshot', 'longScreenshot', 'click', 'scroll',
  'visualStart', 'visualPointerMove', 'visualStop',
]);

const VISUAL_BROWSER_TEST_ACTIONS = new Set([
  'click', 'scroll', 'visualPointerMove',
]);

function getBrowserTestControllerSessionId() {
  let sessionId = sessionStorage.getItem(BROWSER_TEST_SESSION_STORAGE_KEY);
  if (sessionId) return sessionId;

  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  sessionId = `web-ui-${suffix}`;
  sessionStorage.setItem(BROWSER_TEST_SESSION_STORAGE_KEY, sessionId);
  return sessionId;
}

async function postBrowserAction(action, body = {}) {
  const resp = await fetch(`${API}/browser/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (json.code !== 0) throw new Error(json.message || `操作失败: ${action}`);
  return json.data;
}

/**
 * 格式化标签页选项文本，避免标题和 URL 太长导致下拉框变形
 */
function formatTabOptionText(tab) {
  const prefix = tab.active ? '当前页 · ' : '';
  let title = tab.title || '未命名标签页';
  let urlStr = tab.url || '';

  if (title.length > 30) {
    title = title.slice(0, 28) + '...';
  }

  if (urlStr) {
    try {
      const url = new URL(urlStr);
      if (url.protocol === 'chrome:') {
        urlStr = url.href;
      } else {
        let clean = url.origin;
        if (url.pathname && url.pathname !== '/') {
          clean += url.pathname;
        }
        if (url.hash) {
          if (url.hash.includes('/') || url.hash.length < 24) {
            clean += url.hash;
          } else {
            clean += '#...';
          }
        }
        if (url.search) {
          clean += '?...';
        }
        urlStr = clean;
      }
    } catch (e) {
      // Ignore URL parsing error
    }

    if (urlStr.length > 60) {
      urlStr = urlStr.slice(0, 57) + '...';
    }
  }

  return `${prefix}${title} — ${urlStr}`;
}

async function refreshBrowserTestTabs() {
  const select = document.getElementById('testTabId');
  if (!select) return;

  const previousTabId = Number(select.value);
  select.disabled = true;
  select.innerHTML = '<option value="">正在加载标签页…</option>';

  try {
    const tabs = await postBrowserAction('listTabs');
    const availableTabs = Array.isArray(tabs) ? tabs : [];
    select.innerHTML = '';

    if (availableTabs.length === 0) {
      select.innerHTML = '<option value="">未发现可用标签页</option>';
      return;
    }

    availableTabs
      .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)))
      .forEach((tab) => {
        const option = document.createElement('option');
        option.value = String(tab.id);
        option.textContent = formatTabOptionText(tab);
        option.selected = tab.id === previousTabId
          || (!previousTabId && Boolean(tab.active));
        select.appendChild(option);
      });
  } catch (err) {
    select.innerHTML = '<option value="">标签页加载失败</option>';
    showToast(`无法获取标签页：${err.message}`, 'error');
  } finally {
    select.disabled = false;
  }
}

function getSelectedBrowserTestTabId() {
  const value = Number(document.getElementById('testTabId')?.value);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function getBrowserTestVisualLabel() {
  return document.getElementById('testVisualLabel')?.value.trim() || 'BrowserPilot';
}

async function ensureBrowserTestVisualControl(tabId) {
  return postBrowserAction('claimTab', {
    tabId,
    controllerSessionId: getBrowserTestControllerSessionId(),
    label: getBrowserTestVisualLabel(),
    visual: true,
    cursor: true,
    showCancel: true,
  });
}

function getPointerTestPosition() {
  const margin = 96;
  const maxX = Math.max(margin, window.innerWidth - margin);
  const maxY = Math.max(margin, window.innerHeight - margin);
  return {
    x: Math.floor(margin + Math.random() * (maxX - margin)),
    y: Math.floor(margin + Math.random() * (maxY - margin)),
  };
}

async function runBrowserTestAction(action, { tabId, url, selector }) {
  if (action === 'listTabs') return postBrowserAction(action);

  const controllerSessionId = getBrowserTestControllerSessionId();
  if (action === 'visualStart') {
    return { control: await ensureBrowserTestVisualControl(tabId) };
  }

  if (action === 'visualStop') {
    return postBrowserAction(action, {
      tabId,
      controllerSessionId,
      reason: 'web_ui_stopped',
    });
  }

  let control = null;
  if (VISUAL_BROWSER_TEST_ACTIONS.has(action)) {
    control = await ensureBrowserTestVisualControl(tabId);
  }

  let body = { tabId, controllerSessionId };
  if (action === 'navigate') body = { ...body, url };
  if (action === 'click' || action === 'getContent') body = { ...body, selector };
  if (action === 'scroll') body = { ...body, direction: 'down', distance: 500 };
  if (action === 'visualPointerMove') {
    body = { ...body, ...getPointerTestPosition(), duration: 500 };
  }

  const result = await postBrowserAction(action, body);
  return control ? { control, result } : result;
}

function updateBrowserTestFields() {
  const action = document.getElementById('testAction').value;
  document.getElementById('testUrlGroup').classList.toggle('is-hidden', action !== 'navigate');
  document.getElementById('testSelectorGroup').classList.toggle('is-hidden', action !== 'click' && action !== 'getContent');
  document.getElementById('testVisualLabelGroup').classList.toggle('is-hidden', !TARGETED_BROWSER_TEST_ACTIONS.has(action));
}

function setupBrowserTest() {
  const actionSelect = document.getElementById('testAction');
  const urlInput = document.getElementById('testUrl');

  // 将默认测试 URL 自动填为当前页面控制台地址自身
  if (urlInput && (!urlInput.value || urlInput.value === 'https://httpbin.org/get')) {
    urlInput.value = window.location.href;
  }

  actionSelect.addEventListener('change', updateBrowserTestFields);
  document.getElementById('btnRefreshTestTabs').addEventListener('click', refreshBrowserTestTabs);
  updateBrowserTestFields();
  refreshBrowserTestTabs();

  document.getElementById('btnTest').addEventListener('click', async () => {
    const action = document.getElementById('testAction').value;
    const url = urlInput ? urlInput.value.trim() : '';
    const selectorInput = document.getElementById('testSelector');
    const selector = selectorInput ? selectorInput.value.trim() : '';
    const resultDiv = document.getElementById('testResult');

    if (action === 'click' || action === 'getContent') {
      if (!selector) {
        resultDiv.innerHTML = '<span class="text-danger">提示: CSS 选择器不能为空，请输入有效的选择器或使用默认值。</span>';
        return;
      }
    }

    resultDiv.innerHTML = '<span class="output-placeholder">⏳ 执行中...</span>';

    try {
      const tabId = getSelectedBrowserTestTabId();
      if (TARGETED_BROWSER_TEST_ACTIONS.has(action) && !tabId) {
        resultDiv.innerHTML = '<span class="text-danger">请选择一个可用的目标标签页。</span>';
        return;
      }

      const result = await runBrowserTestAction(action, { tabId, url, selector });

      // 检查返回结果中是否包含 base64 截图数据
      let screenshotUrl = null;
      if (result && typeof result === 'object') {
        if (result.screenshot && typeof result.screenshot === 'string' && result.screenshot.startsWith('data:image/')) {
          screenshotUrl = result.screenshot;
        } else if (result.result && result.result.screenshot && typeof result.result.screenshot === 'string' && result.result.screenshot.startsWith('data:image/')) {
          screenshotUrl = result.result.screenshot;
        }
      }

      if (screenshotUrl) {
        // 深拷贝结果数据，以便在 JSON 展示中精简 base64 字符串，避免 DOM 渲染长文本导致卡死
        const resultCopy = JSON.parse(JSON.stringify(result));
        if (resultCopy.screenshot) {
          resultCopy.screenshot = `[Base64 Image Data: ${resultCopy.screenshot.length} chars]`;
        } else if (resultCopy.result && resultCopy.result.screenshot) {
          resultCopy.result.screenshot = `[Base64 Image Data: ${resultCopy.result.screenshot.length} chars]`;
        }

        resultDiv.innerHTML = `
          <div class="screenshot-preview-wrapper" style="white-space: normal; margin-bottom: 16px; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
            <div style="font-weight: 700; font-size: 13px; color: var(--text-strong); margin-bottom: 8px;">
              📸 截图预览 (点击可在新标签页查看原图)
            </div>
            <div class="screenshot-scroll-container" style="max-height: 400px; overflow-y: auto; overflow-x: hidden; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: #121212;">
              <a href="#" class="screenshot-link" title="点击查看大图" style="display: block;">
                <img src="${screenshotUrl}" alt="Screenshot Preview" style="width: 100%; height: auto; display: block; object-fit: contain; cursor: zoom-in;" />
              </a>
            </div>
          </div>
          <pre style="margin: 0; padding: 0; background: transparent; border: none; font-family: inherit;">${esc(JSON.stringify(resultCopy, null, 2))}</pre>
        `;

        const link = resultDiv.querySelector('.screenshot-link');
        if (link) {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            const newTab = window.open();
            if (newTab) {
              newTab.document.write(`
                <!DOCTYPE html>
                <html>
                  <head>
                    <title>截图原图查看</title>
                    <style>
                      body {
                        margin: 0;
                        background-color: #0e0e0e;
                        display: flex;
                        justify-content: center;
                        align-items: flex-start;
                        min-height: 100vh;
                        padding: 20px;
                        box-sizing: border-box;
                      }
                      img {
                        max-width: 100%;
                        height: auto;
                        box-shadow: 0 4px 20px rgba(0,0,0,0.8);
                        border-radius: 4px;
                      }
                    </style>
                  </head>
                  <body>
                    <img src="${screenshotUrl}" alt="Screenshot" />
                  </body>
                </html>
              `);
              newTab.document.close();
            }
          });
        }
      } else {
        resultDiv.innerHTML = esc(JSON.stringify(result, null, 2));
      }
    } catch (err) {
      resultDiv.innerHTML = `<span class="text-danger">请求失败: ${esc(err.message)}</span>`;
    }
  });
}

// ── 日志查看器 ──────────────────────────────

async function populateLogTaskSelect() {
  const select = document.getElementById('logTaskSelect');
  select.innerHTML = '<option value="">-- 选择定时任务 --</option>';

  try {
    const resp = await fetch(`${API}/tasks`);
    const json = await resp.json();
    const tasks = json.data || [];

    tasks.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      select.appendChild(opt);
    });
  } catch { /* ignore */ }
}

function setupLogViewer() {
  const select = document.getElementById('logTaskSelect');
  select.addEventListener('change', () => {
    if (select.value) {
      loadLogs(select.value);
    } else {
      document.getElementById('logEntries').innerHTML = '<div class="empty-state"><p>请在上方选择一项任务以查看详细日志</p></div>';
    }
  });
}

async function loadLogs(taskId) {
  const container = document.getElementById('logEntries');
  try {
    const resp = await fetch(`${API}/tasks/${taskId}/logs?limit=50`);
    const json = await resp.json();
    const logs = json.data || [];

    if (!logs.length) {
      container.innerHTML = '<div class="empty-state"><p>该任务尚无执行日志记录</p></div>';
      return;
    }

    container.innerHTML = logs.map(entry => `
      <div class="log-entry ${entry.type || 'step'}">
        <span class="log-time">${formatTime(entry.timestamp)}</span>
        <strong>[${esc(entry.type?.toUpperCase() || 'STEP')}]</strong>
        ${entry.taskName ? ` — ${esc(entry.taskName)}` : ''}
        ${entry.action ? ` — 动作: <code>${esc(entry.action)}</code>` : ''}
        ${entry.status === 'failed' ? ` — <span class="log-status log-status-error">执行失败</span>` : ''}
        ${entry.status === 'success' ? ` — <span class="log-status log-status-success">执行成功</span>` : ''}
        ${entry.error ? ` — <span class="text-danger">异常信息: ${esc(entry.error)}</span>` : ''}
        ${entry.durationMs ? ` (${entry.durationMs}ms)` : ''}
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p class="text-danger">加载失败: ${esc(err.message)}</p></div>`;
  }
}

// ── 安全与权限控制逻辑 ───────────────────────

async function loadSettings() {
  try {
    const resp = await fetch(`${API}/settings`);
    const json = await resp.json();
    if (json.code === 0 && json.data) {
      settings = json.data;

      // 应用配置到表单
      document.getElementById('settingApproval').value = settings.approval || 'always';
      document.getElementById('settingCdp').checked = !!settings.cdpEnabled;
      document.getElementById('settingDownload').value = settings.download || 'ask';
      document.getElementById('settingUpload').value = settings.upload || 'ask';

      renderSiteRules();
    }
  } catch (err) {
    console.error('加载设置失败:', err);
  }
}

async function saveSettings() {
  try {
    settings.approval = document.getElementById('settingApproval').value;
    settings.cdpEnabled = document.getElementById('settingCdp').checked;
    settings.download = document.getElementById('settingDownload').value;
    settings.upload = document.getElementById('settingUpload').value;

    const resp = await fetch(`${API}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    const json = await resp.json();
    if (json.code !== 0) throw new Error(json.message || '安全策略保存失败');
    showToast(json.message || '安全策略配置已更新', 'success');
  } catch (err) {
    showToast('保存失败：' + err.message, 'error');
  }
}

function renderSiteRules() {
  const tbody = document.getElementById('siteRulesBody');
  if (!settings.sitePermissions || settings.sitePermissions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="no-rules">暂未配置特定域名例外规则</td></tr>';
    return;
  }

  tbody.innerHTML = settings.sitePermissions.map((rule, idx) => `
    <tr>
      <td><code>${esc(rule.site)}</code></td>
      <td>
        <span class="rule-badge ${rule.approval === 'always' ? 'ask' : 'allow'}">
          ${rule.approval === 'always' ? '强制询问审批' : '免审批运行'}
        </span>
      </td>
      <td>
        <button class="btn btn-danger rule-delete-btn" onclick="deleteSiteRule(${idx})">删除</button>
      </td>
    </tr>
  `).join('');
}

async function saveSettingsSilent() {
  // 先从页面控件同步最新值，避免使用内存中的旧配置覆盖用户未提交的修改
  const approvalEl = document.getElementById('settingApproval');
  const cdpEl = document.getElementById('settingCdp');
  const downloadEl = document.getElementById('settingDownload');
  const uploadEl = document.getElementById('settingUpload');
  if (approvalEl) settings.approval = approvalEl.value;
  if (cdpEl) settings.cdpEnabled = cdpEl.checked;
  if (downloadEl) settings.download = downloadEl.value;
  if (uploadEl) settings.upload = uploadEl.value;

  await fetch(`${API}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  });
}

async function deleteSiteRule(idx) {
  if (await showConfirm('移除后，该域名将恢复使用全局安全策略。确定继续吗？')) {
    settings.sitePermissions.splice(idx, 1);
    await saveSettingsSilent();
    renderSiteRules();
    showToast('域名例外规则已移除', 'success');
  }
}

window.deleteSiteRule = deleteSiteRule;

function setupSettings() {
  document.getElementById('btnSaveSettings').addEventListener('click', saveSettings);

  document.getElementById('sitePermissionForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const site = document.getElementById('siteName').value.trim();
    const approval = document.getElementById('siteApproval').value;

    if (!site) return;
    if (!settings.sitePermissions) settings.sitePermissions = [];

    const existingIdx = settings.sitePermissions.findIndex(p => p.site === site);
    if (existingIdx !== -1) {
      settings.sitePermissions[existingIdx].approval = approval;
    } else {
      settings.sitePermissions.push({ site, approval });
    }

    document.getElementById('siteName').value = '';
    await saveSettingsSilent();
    renderSiteRules();
  });
}

// ── 实时审批轮询逻辑 ────────────────────────

function startApprovalPolling() {
  // 每 1.5 秒轮询是否有待决定的自动化审批请求
  setInterval(pollApprovals, 1500);
  pollApprovals();

  document.getElementById('btnApprApprove').addEventListener('click', () => decideApproval('approve'));
  document.getElementById('btnApprReject').addEventListener('click', () => decideApproval('reject'));
}

async function pollApprovals() {
  try {
    const resp = await fetch(`${API}/approvals`);
    const json = await resp.json();
    const approvals = json.data || [];

    const modal = document.getElementById('approvalModal');
    if (approvals.length > 0) {
      const first = approvals[0];
      // 只有在新审批发起时才更新 DOM
      if (!activeApproval || activeApproval.id !== first.id) {
        activeApproval = first;
        
        if (first.type === 'download') {
          // 文件下载审批展示
          document.querySelector('.modal-header h3').textContent = 'BrowserPilot 下载审批';
          document.getElementById('apprAction').textContent = `下载文件：${first.filename}`;
          document.getElementById('apprTab').textContent = `来源：${first.url ? new URL(first.url).hostname : '未知'}`;
          
          const details = {
            "文件名": first.filename,
            "下载地址": first.url,
            "文件大小": (first.fileSize ? (first.fileSize / 1024).toFixed(2) + " KB" : "未知"),
            "文件类型": first.mime || '未知'
          };
          document.getElementById('apprParams').textContent = JSON.stringify(details, null, 2);
        } else if (first.type === 'upload') {
          document.querySelector('.modal-header h3').textContent = 'BrowserPilot 上传审批';
          document.getElementById('apprAction').textContent = '允许打开文件选择器';
          document.getElementById('apprTab').textContent = first.tabId || '未知标签页';
          document.getElementById('apprParams').textContent = JSON.stringify({
            '允许文件类型': first.accept || '页面未限制',
            '允许多选': first.multiple ? '是' : '否'
          }, null, 2);
        } else {
          // 正常敏感操作审批展示
          document.querySelector('.modal-header h3').textContent = 'BrowserPilot 审批请求';
          document.getElementById('apprAction').textContent = formatActionLabel(first.action);
          document.getElementById('apprTab').textContent = first.tabId || '全局 / 无';
          document.getElementById('apprParams').textContent = JSON.stringify(first.params, null, 2);
        }
        
        modal.classList.add('active');
      }
    } else {
      if (activeApproval) {
        activeApproval = null;
        modal.classList.remove('active');
      }
    }
  } catch (err) {
    console.error('审批轮询错误:', err);
  }
}

async function decideApproval(decision) {
  if (!activeApproval) return;
  const id = activeApproval.id;
  try {
    await fetch(`${API}/approvals/${id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision })
    });
    activeApproval = null;
    document.getElementById('approvalModal').classList.remove('active');
  } catch (err) {
    showToast('提交审批决策失败：' + err.message, 'error');
  }
}

// ── 通用辅助函数 ────────────────────────────

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

// ── 任务配置编辑与复制 ──────────────────────

let activeTemplateText = '';
let activeTaskId = null;

function setupTemplateModal() {
  const modal = document.getElementById('templateModal');
  const copyBtn = document.getElementById('btnCopyTemplate');
  const closeBtn = document.getElementById('btnCloseTemplate');
  const saveBtn = document.getElementById('btnSaveTemplate');
  const codeEl = document.getElementById('templateCode');
  if (!modal || !copyBtn || !closeBtn || !saveBtn || !codeEl) return;

  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(codeEl.value);
      showToast('配置内容已成功复制到剪贴板！', 'success');
    } catch (err) {
      showToast('复制失败：' + err.message, 'error');
    }
  };

  saveBtn.onclick = async () => {
    if (!activeTaskId) return;
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    try {
      const source = codeEl.value;
      const resp = await fetch(`${API}/tasks/${activeTaskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source })
      });
      const json = await resp.json();
      if (json.code !== 0) throw new Error(json.message || '更新配置失败');

      showToast('✓ 配置已更新并应用成功！', 'success');
      modal.classList.remove('active');
      loadTasks();
    } catch (err) {
      showToast('无法保存配置：' + err.message, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存配置';
    }
  };

  closeBtn.onclick = () => {
    modal.classList.remove('active');
  };

  modal.onclick = (e) => {
    if (e.target === modal) {
      modal.classList.remove('active');
    }
  };
}

window.viewTaskTemplate = async function(taskId) {
  try {
    const resp = await fetch(`${API}/tasks/${taskId}`);
    const json = await resp.json();
    if (json.code !== 0) throw new Error(json.message || '获取任务失败');

    const task = json.data;
    activeTemplateText = task.source || '';
    activeTaskId = taskId;

    const modal = document.getElementById('templateModal');
    const codeEl = document.getElementById('templateCode');
    if (modal && codeEl) {
      codeEl.value = activeTemplateText;
      modal.classList.add('active');
    }
  } catch (err) {
    showToast('无法加载配置：' + err.message, 'error');
  }
};
