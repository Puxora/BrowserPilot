// Keeps page content below BrowserPilot's fixed visual-control banner.
(() => {
  'use strict';

  const ACTIVE_ATTRIBUTE = 'data-ca-visual-banner-offset';
  const ACTIVE_ATTRIBUTE_VALUE = 'browserpilot-active';
  const BASE_PADDING_PROPERTY = '--ca-visual-page-padding-top';
  const BANNER_HEIGHT_PROPERTY = '--ca-visual-banner-height';
  const TRANSITION_MS = 220;

  class PageLayoutOffsetController {
    constructor(options = {}) {
      this.document = options.document || globalThis.document;
      this.window = options.window || globalThis.window;
      this.ResizeObserverClass = options.ResizeObserver || globalThis.ResizeObserver;
      this.transitionMs = options.transitionMs ?? TRANSITION_MS;
      this.setTimeoutFn = options.setTimeout || globalThis.setTimeout.bind(globalThis);
      this.clearTimeoutFn = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);

      this.root = null;
      this.banner = null;
      this.resizeObserver = null;
      this.restoreTimer = null;
      this.savedState = null;
      this.listening = false;
      this.lifecycleId = 0;
      this.handleResize = () => this.update();
    }

    attach(banner) {
      const root = this.document?.documentElement;
      if (!root || !banner) return;

      this.lifecycleId += 1;
      if (this.root && this.root !== root) this._finishRestore();
      if (this.restoreTimer != null) {
        this.clearTimeoutFn(this.restoreTimer);
        this.restoreTimer = null;
      }

      if (!this.savedState) this._begin(root);
      this.banner = banner;
      this._observeBanner();
      this._listen();
      this.update();
    }

    update() {
      if (!this.root || !this.banner || !this.savedState) return 0;
      const measuredHeight = Number(this.banner.getBoundingClientRect?.().height) || 0;
      const height = Math.max(0, Math.ceil(measuredHeight));
      this.root.style.setProperty(BANNER_HEIGHT_PROPERTY, `${height}px`);
      return height;
    }

    stop(options = {}) {
      this._disconnectBanner();
      this._unlisten();
      this.banner = null;
      if (this.restoreTimer != null) {
        this.clearTimeoutFn(this.restoreTimer);
        this.restoreTimer = null;
      }
      if (!this.root || !this.savedState) return;

      this.root.style.setProperty(BANNER_HEIGHT_PROPERTY, '0px');
      const reducedMotion = this.window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
      if (options.immediate || reducedMotion || this.transitionMs <= 0) {
        this._finishRestore();
        return;
      }

      const lifecycleId = this.lifecycleId;
      this.restoreTimer = this.setTimeoutFn(() => {
        if (lifecycleId !== this.lifecycleId) return;
        this.restoreTimer = null;
        this._finishRestore();
      }, this.transitionMs + 40);
    }

    destroy() {
      this.stop({ immediate: true });
    }

    _begin(root) {
      this.root = root;
      this.savedState = {
        attributePresent: root.hasAttribute(ACTIVE_ATTRIBUTE),
        attributeValue: root.getAttribute(ACTIVE_ATTRIBUTE),
        basePadding: this._readStyle(BASE_PADDING_PROPERTY),
        bannerHeight: this._readStyle(BANNER_HEIGHT_PROPERTY),
      };

      const computedPadding = this.window?.getComputedStyle?.(root).paddingTop || '0px';
      root.style.setProperty(BASE_PADDING_PROPERTY, computedPadding);
      root.style.setProperty(BANNER_HEIGHT_PROPERTY, '0px');
      root.setAttribute(ACTIVE_ATTRIBUTE, ACTIVE_ATTRIBUTE_VALUE);
    }

    _observeBanner() {
      this._disconnectBanner();
      if (typeof this.ResizeObserverClass !== 'function') return;
      this.resizeObserver = new this.ResizeObserverClass(() => this.update());
      this.resizeObserver.observe(this.banner);
    }

    _disconnectBanner() {
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
    }

    _listen() {
      if (this.listening) return;
      this.window?.addEventListener?.('resize', this.handleResize);
      this.window?.visualViewport?.addEventListener?.('resize', this.handleResize);
      this.listening = true;
    }

    _unlisten() {
      if (!this.listening) return;
      this.window?.removeEventListener?.('resize', this.handleResize);
      this.window?.visualViewport?.removeEventListener?.('resize', this.handleResize);
      this.listening = false;
    }

    _readStyle(property) {
      return {
        value: this.root?.style.getPropertyValue(property) || '',
        priority: this.root?.style.getPropertyPriority(property) || '',
      };
    }

    _restoreStyle(property, state) {
      if (state.value) this.root.style.setProperty(property, state.value, state.priority);
      else this.root.style.removeProperty(property);
    }

    _finishRestore() {
      if (this.restoreTimer != null) {
        this.clearTimeoutFn(this.restoreTimer);
        this.restoreTimer = null;
      }
      this._disconnectBanner();
      this._unlisten();
      if (!this.root || !this.savedState) return;

      this._restoreStyle(BASE_PADDING_PROPERTY, this.savedState.basePadding);
      this._restoreStyle(BANNER_HEIGHT_PROPERTY, this.savedState.bannerHeight);
      if (this.savedState.attributePresent) {
        this.root.setAttribute(ACTIVE_ATTRIBUTE, this.savedState.attributeValue ?? '');
      } else {
        this.root.removeAttribute(ACTIVE_ATTRIBUTE);
      }

      this.root = null;
      this.banner = null;
      this.savedState = null;
    }
  }

  globalThis.BrowserPilotPageLayoutOffset = Object.freeze({
    PageLayoutOffsetController,
    ACTIVE_ATTRIBUTE,
    ACTIVE_ATTRIBUTE_VALUE,
    BASE_PADDING_PROPERTY,
    BANNER_HEIGHT_PROPERTY,
    TRANSITION_MS,
  });
})();
