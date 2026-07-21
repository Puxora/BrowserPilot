// Adds layout-offset support to an already-running legacy content script.
(() => {
  'use strict';

  const BOOTSTRAP_KEY = '__browserPilotPageLayoutOffsetBootstrap';
  const BANNER_ID = 'ca-visual-banner';
  const STYLE_ID = 'ca-page-layout-offset-bootstrap-style';
  const existing = globalThis[BOOTSTRAP_KEY];
  if (existing) {
    existing.sync();
    return;
  }

  const api = globalThis.BrowserPilotPageLayoutOffset;
  if (!api?.PageLayoutOffsetController || !globalThis.document?.documentElement) return;

  const controller = new api.PageLayoutOffsetController();
  let banner = null;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
html[${api.ACTIVE_ATTRIBUTE}="${api.ACTIVE_ATTRIBUTE_VALUE}"] {
  padding-top: calc(
    var(${api.BASE_PADDING_PROPERTY}, 0px) +
    var(${api.BANNER_HEIGHT_PROPERTY}, 0px)
  ) !important;
  box-sizing: border-box !important;
  transition: padding-top ${api.TRANSITION_MS}ms ease-out !important;
}
@media (prefers-reduced-motion: reduce) {
  html[${api.ACTIVE_ATTRIBUTE}="${api.ACTIVE_ATTRIBUTE_VALUE}"] {
    transition: none !important;
  }
}`;
    document.documentElement.appendChild(style);
  }

  function sync() {
    ensureStyle();
    const nextBanner = document.getElementById(BANNER_ID);
    if (nextBanner === banner) return;
    banner = nextBanner;
    if (banner) controller.attach(banner);
    else controller.stop();
  }

  const observer = new MutationObserver(sync);
  observer.observe(document, { childList: true, subtree: true });
  globalThis[BOOTSTRAP_KEY] = Object.freeze({ sync });
  sync();
})();
