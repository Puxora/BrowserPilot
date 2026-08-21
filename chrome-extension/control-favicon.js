// Cleans control favicons left behind when an MV3 service worker is restarted.
(() => {
  'use strict';

  const CONTROL_FAVICON_ID = 'ca-browserpilot-control-favicon';
  const CONTROL_FAVICON_RESET_ID = 'ca-browserpilot-control-favicon-reset';
  const EMPTY_FAVICON_URL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E";
  const ORIGINAL_FAVICON_DATASET_KEY = 'caOriginalFaviconUrl';

  async function clearStale(chromeApi) {
    let tabs = [];
    try {
      tabs = await callChrome(chromeApi, done => chromeApi.tabs.query({}, done));
    } catch (err) {
      console.warn('[Background] 无法枚举标签页以清理控制图标:', err.message);
      return;
    }

    await Promise.all(tabs
      .filter(tab => Number.isInteger(tab.id))
      .map(async tab => {
        try {
          await callChrome(chromeApi, done => chromeApi.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: (faviconId, resetId, emptyFaviconUrl, originalDatasetKey, controlUrlPrefix) => {
              const controlIcons = document.querySelectorAll(`link#${faviconId}`);
              const resetIcons = document.querySelectorAll(`link#${resetId}`);
              if (controlIcons.length === 0 && resetIcons.length === 0) return;
              const persistedOriginal = [...controlIcons, ...resetIcons]
                .map(icon => icon.dataset[originalDatasetKey])
                .find(url => typeof url === 'string'
                  && url !== ''
                  && url !== emptyFaviconUrl
                  && !url.startsWith(controlUrlPrefix));
              controlIcons.forEach(icon => icon.remove());
              resetIcons.forEach(icon => icon.remove());
              const pageIcons = [...document.querySelectorAll('link[rel~="icon"]')]
                .filter(icon => icon.id !== faviconId && icon.id !== resetId);
              // 旧版本留下的 reset 单独存在时只移除它，让 Chrome 重新采用网页图标。
              if (controlIcons.length === 0) {
                pageIcons.forEach(icon => icon.replaceWith(icon.cloneNode(true)));
                return;
              }
              if (pageIcons.length === 0) {
                const resetIcon = document.createElement('link');
                resetIcon.id = resetId;
                resetIcon.rel = 'icon';
                resetIcon.href = persistedOriginal || emptyFaviconUrl;
                if (persistedOriginal) {
                  resetIcon.dataset[originalDatasetKey] = persistedOriginal;
                } else {
                  resetIcon.type = 'image/svg+xml';
                }
                (document.head || document.documentElement).appendChild(resetIcon);
                return;
              }
              pageIcons.forEach(icon => {
                icon.replaceWith(icon.cloneNode(true));
              });
            },
            args: [
              CONTROL_FAVICON_ID,
              CONTROL_FAVICON_RESET_ID,
              EMPTY_FAVICON_URL,
              ORIGINAL_FAVICON_DATASET_KEY,
              chromeApi.runtime.getURL('icons/control-status-'),
            ],
          }, done));
        } catch {
          // Chrome internal pages, extension pages, and closed tabs cannot be injected.
        }
      }));
  }

  function callChrome(chromeApi, invoke) {
    return new Promise((resolve, reject) => {
      invoke(result => {
        const error = chromeApi.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    });
  }

  globalThis.BrowserPilotControlFavicon = Object.freeze({ clearStale });
})();
