// Chrome Automation Plugin - JS 任务运行时
// 任务模块通过受控 ctx 调用浏览器能力。

export class TaskEngine {
  constructor(wsServer, store, config) {
    this.wsServer = wsServer;
    this.store = store;
    this.config = config;
    this.operationPolicy = null;
    this.tabClaims = new Map();
    this.commandSignals = new Map();
    this.onTabClaimChanged = null;
  }

  setOperationPolicy(policy) {
    this.operationPolicy = policy;
  }

  setTabClaimHandler(handler) {
    this.onTabClaimChanged = handler;
  }

  getTaskForTab(tabId) {
    return this.tabClaims.get(tabId) || null;
  }

  /** 执行一个 JS 任务模块。 */
  async execute(task, { signal } = {}) {
    let targetTabId = null;
    let stepsExecuted = 0;
    const taskOptions = task.options || {};

    this._throwIfAborted(signal);
    const timeout = this._stepTimeout(task);

    // 每个任务必须使用独占标签页。优先接管未被其他任务占用的匹配标签页，
    // 否则创建自己的标签页，避免并发任务互相操作同一页面。
    if (taskOptions.claimUrlContains) {
      try {
        console.log(`[TaskEngine] 正在根据策略查找包含 "${taskOptions.claimUrlContains}" 的标签页...`);
        const tabs = await this.wsServer.sendCommand('listTabs', {}, null, timeout);
        const match = tabs.find(t => t.url && t.url.includes(taskOptions.claimUrlContains) && !this.tabClaims.has(t.id));
        if (match) {
          console.log(`[TaskEngine] 找到匹配的标签页: ${match.url} (ID: ${match.id})，正在接管...`);
          targetTabId = match.id;
          this._reserveTab(targetTabId, task.id);
        } else if (taskOptions.fallbackUrl) {
          console.log(`[TaskEngine] 未找到匹配标签页，创建新标签页: ${taskOptions.fallbackUrl}`);
          const created = await this.wsServer.sendCommand('createTab', { url: taskOptions.fallbackUrl }, null, timeout);
          targetTabId = created.tabId;
        }
      } catch (err) {
        if (targetTabId && this.tabClaims.get(targetTabId) === task.id) this._releaseTab(targetTabId, task.id);
        targetTabId = null;
        console.warn('[TaskEngine] 自动查找并接管标签页失败:', err.message);
      }
    }

    if (!targetTabId) {
      const created = await this.wsServer.sendCommand('createTab', { url: taskOptions.fallbackUrl || 'about:blank' }, null, timeout);
      targetTabId = created.tabId;
    }
    if (this.tabClaims.get(targetTabId) !== task.id) this._reserveTab(targetTabId, task.id);
    try {
      await this.wsServer.sendCommand('claimTab', { tabId: targetTabId }, null, timeout);
    } catch (err) {
      this._releaseTab(targetTabId, task.id);
      throw err;
    }
    this.commandSignals.set(targetTabId, signal);

    // 可视化调试自动包裹：仅当 task.options.visualDebug 开启时启用
    // 默认关闭，避免无人值守的定时任务影响页面
    const visual = this._resolveVisualOptions(taskOptions);
    const visualStarted = await this._visualBegin(visual, targetTabId);
    if (visualStarted) targetTabId = visualStarted.tabId || targetTabId;

    try {
      const ctx = this._createTaskContext({
        task,
        signal,
        timeout,
        visual,
        getTabId: () => targetTabId,
        setTabId: (tabId) => { targetTabId = tabId; },
        onOperation: () => ++stepsExecuted,
      });
      await task.run(ctx);

      await this._visualUpdateSafe(visual, targetTabId, {
        state: 'done',
        message: '任务执行完成',
      });

      return { stepsExecuted, stepsFailed: 0 };
    } catch (error) {
      await this._visualUpdateSafe(visual, targetTabId, {
        state: 'error',
        message: error.message || '任务执行失败',
      });
      throw error;
    } finally {
      // 无论成功失败都关闭可视化（短暂停留让用户看到终态）
      await this._sleep(visual.enabled ? 800 : 0, signal).catch(() => {});
      await this._visualEnd(visual, targetTabId);
      if (targetTabId) this._releaseTab(targetTabId, task.id);
      if (targetTabId) this.commandSignals.delete(targetTabId);
    }
  }

  _createTaskContext({ task, signal, timeout, visual, getTabId, setTabId, onOperation }) {
    const invoke = async (action, params = {}) => {
      this._throwIfAborted(signal);
      const tabId = getTabId();
      const index = onOperation();
      await this._visualStepBegin(visual, tabId, index, action);
      try {
        await this.operationPolicy?.authorize(action, { params, tabId, signal });
        const result = await this._command(action, params, tabId, timeout);
        if (result?.tabId && result.tabId !== tabId) {
          this._releaseTab(tabId, task.id);
          this._reserveTab(result.tabId, task.id);
          this.commandSignals.delete(tabId);
          this.commandSignals.set(result.tabId, signal);
          setTabId(result.tabId);
        }
        await this.store.appendLog(task.id, {
          type: 'step', index: index - 1, action, status: 'success',
          result: result ? JSON.stringify(result).slice(0, 500) : null,
        });
        return result;
      } catch (error) {
        await this.store.appendLog(task.id, {
          type: 'step', index: index - 1, action, status: 'failed', error: error.message,
        });
        throw error;
      }
    };
    const wait = async (ms) => {
      this._throwIfAborted(signal);
      const index = onOperation();
      await this._visualStepBegin(visual, getTabId(), index, 'wait');
      await this._sleep(Math.min(Number(ms) || 0, timeout), signal);
      await this.store.appendLog(task.id, { type: 'step', index: index - 1, action: 'wait', status: 'success' });
    };

    return Object.freeze({
      signal,
      get tabId() { return getTabId(); },
      navigate: (url, options = {}) => invoke('navigate', typeof url === 'string' ? { url, ...options } : url),
      click: (selector) => invoke('click', { selector }),
      clickText: (text, options = {}) => invoke('clickText', { text, ...options }),
      clickRole: (role, name, options = {}) => invoke('clickRole', { role, name, ...options }),
      type: (selector, text) => invoke('type', { selector, text }),
      typeByLabel: (label, text, options = {}) => invoke('typeByLabel', { label, text, ...options }),
      scroll: (options = {}) => invoke('scroll', typeof options === 'number' ? { direction: 'down', distance: options } : options),
      goBack: () => invoke('goBack'),
      reload: () => invoke('reload'),
      wait,
      waitFor: (selector, timeoutMs) => invoke('waitForSelector', { selector, timeoutMs: timeoutMs || timeout }),
      waitForLoad: (timeoutMs) => invoke('waitForLoad', { timeoutMs: timeoutMs || timeout }),
      waitForNavigation: (options = {}) => invoke('waitForNavigation', { ...options, timeoutMs: options.timeoutMs || timeout }),
      content: (selector) => invoke('getContent', { selector }),
      visibleDom: () => invoke('getVisibleDom'),
      domSnapshot: (limit) => invoke('getDomSnapshot', { limit }),
      screenshot: () => invoke('screenshot'),
      longScreenshot: (options = {}) => invoke('longScreenshot', options),
      execute: (code) => invoke('execute', { code }),
      log: async (message, details = undefined) => {
        await this.store.appendLog(task.id, { type: 'message', message: String(message), details });
      },
    });
  }

  // ── 内部 ──────────────────────────

  /**
   * 解析可视化调试配置。
   * @param {object|undefined} taskOptions
   * @returns {{enabled:boolean, label:string}}
   */
  _resolveVisualOptions(taskOptions) {
    const opts = taskOptions?.visualDebug;
    if (opts === true) {
      return { enabled: true, label: taskOptions.visualLabel || 'Claude' };
    }
    if (opts && typeof opts === 'object' && opts.enabled) {
      return { enabled: true, label: opts.label || taskOptions.visualLabel || 'Claude' };
    }
    return { enabled: false, label: 'Claude' };
  }

  /** 开启可视化调试。失败时静默降级，不阻断任务执行。 */
  async _visualBegin(visual, tabId) {
    if (!visual.enabled) return null;
    try {
      const result = await this.wsServer.sendCommand(
        'visualStart',
        { label: visual.label, showCancel: true, cursor: true },
        tabId,
        this.config.defaultTimeoutMs
      );
      return { tabId: result?.tabId || tabId };
    } catch (err) {
      console.warn('[TaskEngine] visualStart 失败（已降级，任务继续）:', err.message);
      return null;
    }
  }

  /** 关闭可视化调试。失败时静默。 */
  async _visualEnd(visual, tabId) {
    if (!visual.enabled) return;
    try {
      await this.wsServer.sendCommand(
        'visualStop',
        { reason: 'completed' },
        tabId,
        this.config.defaultTimeoutMs
      );
    } catch (err) {
      console.warn('[TaskEngine] visualStop 失败（已忽略）:', err.message);
    }
  }

  /** 步骤开始前更新提示条文案。失败时静默。 */
  async _visualStepBegin(visual, tabId, stepNo, actionName) {
    if (!visual.enabled) return;
    await this._visualUpdateSafe(visual, tabId, {
      state: 'running',
      message: `正在执行第 ${stepNo} 步：${actionName}`,
    });
  }

  /** 安全更新可视化状态：失败不抛出，不阻断主流程。 */
  async _visualUpdateSafe(visual, tabId, payload) {
    if (!visual.enabled) return;
    try {
      await this.wsServer.sendCommand('visualUpdate', payload, tabId, this.config.defaultTimeoutMs);
    } catch (err) {
      // 更新失败属于非关键路径，静默处理
    }
  }

  _stepTimeout(task) {
    const configured = Number(task?.options?.timeoutPerStep);
    if (!Number.isFinite(configured) || configured <= 0) return this.config.defaultTimeoutMs;
    return Math.min(configured, 10 * 60 * 1000);
  }

  _command(action, params, tabId, timeout) {
    return this.wsServer.sendCommand(action, params, tabId, timeout, this.commandSignals.get(tabId));
  }

  _reserveTab(tabId, taskId) {
    if (this.tabClaims.has(tabId)) throw new Error('目标标签页正被其他任务使用');
    this.tabClaims.set(tabId, taskId);
    this.onTabClaimChanged?.(taskId, tabId, true);
  }

  _releaseTab(tabId, taskId) {
    if (this.tabClaims.get(tabId) !== taskId) return;
    this.tabClaims.delete(tabId);
    this.onTabClaimChanged?.(taskId, tabId, false);
  }

  _throwIfAborted(signal) {
    if (signal?.aborted) throw new Error('任务已取消');
  }

  _sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('任务已取消'));
      const timer = setTimeout(done, ms);
      function done() {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
      function onAbort() {
        clearTimeout(timer);
        reject(new Error('任务已取消'));
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
