// Serializes visible-tab captures so Chrome's global rate limit is respected.
(() => {
  'use strict';

  class BrowserPilotCaptureVisibleTabQueue {
    constructor({ chromeApi, minIntervalMs, maxAttempts }) {
      this.chrome = chromeApi;
      this.minIntervalMs = minIntervalMs;
      this.maxAttempts = maxAttempts;
      this.queue = Promise.resolve();
      this.lastStartedAt = 0;
    }

    async captureTab(tabId, options) {
      let tab = await this._call(done => this.chrome.tabs.get(tabId, done));
      if (tab.windowId != null) {
        await this._call(done => this.chrome.windows.update(tab.windowId, { focused: true }, done))
          .catch(() => {});
      }
      if (!tab.active) {
        tab = await this._call(done => this.chrome.tabs.update(tabId, { active: true }, done));
      }
      await this._sleep(120);
      return this._enqueue(tab.windowId, options);
    }

    _enqueue(windowId, options) {
      const capture = this.queue
        .catch(() => {})
        .then(() => this._captureWithRetry(windowId, options));
      this.queue = capture.catch(() => {});
      return capture;
    }

    async _captureWithRetry(windowId, options) {
      let lastError;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        await this._waitForSlot();
        try {
          return await this._call(done => this.chrome.tabs.captureVisibleTab(windowId, options, done));
        } catch (error) {
          lastError = error;
          if (!this._isRetryable(error) || attempt === this.maxAttempts) break;
          console.warn(`[Background] Chrome 截图暂时失败，第 ${attempt} 次重试:`, error.message);
          await this._sleep(attempt * 300);
        }
      }
      throw new Error(`Chrome 截图读取失败，已重试 ${this.maxAttempts} 次：${lastError?.message || '未知错误'}`);
    }

    async _waitForSlot() {
      const delayMs = Math.max(0, this.lastStartedAt + this.minIntervalMs - Date.now());
      if (delayMs > 0) await this._sleep(delayMs);
      this.lastStartedAt = Date.now();
    }

    _isRetryable(error) {
      const message = String(error?.message || error).toLowerCase();
      return message.includes('image readback failed')
        || message.includes('max_capture_visible_tab_calls_per_second')
        || message.includes('failed to capture tab');
    }

    _call(invoke) {
      return new Promise((resolve, reject) => {
        invoke(result => {
          const error = this.chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(result);
        });
      });
    }

    _sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
  }

  globalThis.BrowserPilotCaptureVisibleTabQueue = BrowserPilotCaptureVisibleTabQueue;
})();
