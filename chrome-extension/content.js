// BrowserPilot - Content Script
// 职责：在页面中执行 DOM 操作，带反检测机制 + 可视化调试 overlay
// 运行在扩展隔离世界，确保 chrome.runtime 消息 API 可用。
//
// 结构分节：
//   1. 反检测 / 通用工具
//   2. 动作坐标工具（点击位置、视口裁剪、统一事件派发）
//   3. 视觉层 VisualOverlayController（顶部提示条 + 光晕指针）
//   4. DOM 操作（humanClick/humanType/humanScroll，已接入视觉指针）
//   5. 消息监听与 action 分发

(() => {
  'use strict';

  const CONTENT_SCRIPT_CAPABILITY = 'page-layout-offset-v1';

  // ==================== 1. 反检测 / 通用工具 ====================

  /** 随机整数 [min, max] */
  function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /** 随机浮点 [min, max) */
  function randFloat(min, max) {
    return Math.random() * (max - min) + min;
  }

  /** 异步等待 ms */
  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /** 解析 random 表达式 */
  function resolveRandom(val) {
    if (typeof val === 'string') {
      const match = val.match(/^random\((\d+),\s*(\d+)\)$/);
      if (match) {
        return rand(parseInt(match[1]), parseInt(match[2]));
      }
      const floatMatch = val.match(/^random\(([\d.]+),\s*([\d.]+)\)$/);
      if (floatMatch) {
        return randFloat(parseFloat(floatMatch[1]), parseFloat(floatMatch[2]));
      }
    }
    return val;
  }

  /** 查找元素（支持多种选择器策略） */
  function findElement(selector) {
    if (!selector || typeof selector !== 'string' || !selector.trim()) {
      return null;
    }
    // 尝试 CSS 选择器
    try {
      let el = document.querySelector(selector);
      if (el) return el;
    } catch {}

    // 尝试 XPath
    try {
      const result = document.evaluate(
        selector, document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      if (result.singleNodeValue) return result.singleNodeValue;
    } catch {}

    // 尝试文本匹配
    try {
      const xpath = `//*[contains(text(), '${selector.replace(/'/g, "\\'")}')]`;
      const result = document.evaluate(
        xpath, document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      if (result.singleNodeValue) return result.singleNodeValue;
    } catch {}

    // 主 frame 未命中 → 遍历同源 iframe 的 contentDocument 查找
    // 解决百度首页等把搜索框放在 iframe 内的场景。
    // 跨域 iframe 访问 contentDocument 会抛 SecurityError，直接跳过。
    const frameEl = findElementInFrames(selector);
    if (frameEl) return frameEl;

    return null;
  }

  /**
   * 在同源 iframe 的 contentDocument 中查找元素（仅支持一层嵌套）。
   * 仅使用 CSS 选择器——iframe 内文档可能很大（广告/统计脚本），
   * 跑 XPath 文本匹配会卡死 content script，且 iframe 内查找场景几乎都是 CSS。
   * 跨域 iframe 访问 contentDocument 会抛 SecurityError，直接跳过。
   * @param {string} selector - CSS 选择器
   * @returns {Element|null} 命中元素（属于 iframe 文档），跨域或未命中返回 null
   */
  function findElementInFrames(selector) {
    let iframes;
    try {
      iframes = Array.from(document.querySelectorAll('iframe'));
    } catch {
      return null;
    }
    for (const iframe of iframes) {
      // 只处理已加载的同源 iframe
      if (!iframe.contentDocument) continue;
      let doc;
      try {
        doc = iframe.contentDocument;
      } catch {
        continue; // 跨域 iframe：SecurityError
      }
      try {
        const el = doc.querySelector(selector);
        if (el) return el;
      } catch {} // 选择器语法错误等
    }
    return null;
  }

  /** 滚动元素到可视区域 */
  function scrollIntoViewSmooth(el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return sleep(500);
  }

  // 可见 DOM 快照使用短生命周期 node id。每次 getVisibleDom 会重建映射，
  // 后续 clickNode/typeNode 只能操作最近一次快照中的节点，避免误点陈旧页面。
  let visibleNodeMap = new Map();
  let visibleNodeCounter = 0;

  function isVisibleElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) {
      return false;
    }
    return true;
  }

  function isRenderableElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isInterestingElement(el) {
    const tag = el.tagName?.toLowerCase();
    if (['a', 'button', 'input', 'textarea', 'select', 'summary'].includes(tag)) return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute('role');
    if (['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'textbox', 'combobox'].includes(role)) {
      return true;
    }
    if (el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0') return true;
    return false;
  }

  function compactText(value, limit = 120) {
    if (!value) return '';
    return String(value).replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function textMatches(value, query, exact = false) {
    const a = compactText(value, 500).toLowerCase();
    const b = compactText(query, 500).toLowerCase();
    if (!b) return false;
    return exact ? a === b : a.includes(b);
  }

  function getAccessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return compactText(aria, 200);

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.innerText || '')
        .join(' ');
      if (compactText(text)) return compactText(text, 200);
    }

    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return compactText(label.innerText || label.textContent, 200);
    }

    return compactText(
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.innerText ||
      el.textContent ||
      el.value,
      200
    );
  }

  function inferRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName?.toLowerCase();
    if (tag === 'a' && el.href) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'summary') return 'button';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    return '';
  }

  function findByText(text, exact = false) {
    const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,summary,[role],[tabindex],[onclick],[contenteditable="true"],label'));
    return candidates.find(el => isRenderableElement(el) && textMatches(getAccessibleName(el), text, exact)) ||
      candidates.find(el => isRenderableElement(el) && textMatches(el.innerText || el.textContent, text, exact));
  }

  function findByRole(role, name, exact = false) {
    const wanted = String(role || '').toLowerCase();
    const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,summary,[role],[tabindex],[onclick],[contenteditable="true"]'));
    return candidates.find(el => {
      if (!isRenderableElement(el)) return false;
      if (inferRole(el) !== wanted) return false;
      return name ? textMatches(getAccessibleName(el), name, exact) : true;
    });
  }

  function findInputByLabel(label, exact = false) {
    const labels = Array.from(document.querySelectorAll('label'));
    for (const labelEl of labels) {
      if (!textMatches(labelEl.innerText || labelEl.textContent, label, exact)) continue;
      if (labelEl.htmlFor) {
        const target = document.getElementById(labelEl.htmlFor);
        if (target && isRenderableElement(target)) return target;
      }
      const nested = labelEl.querySelector('input,textarea,select,[contenteditable="true"]');
      if (nested && isRenderableElement(nested)) return nested;
    }

    const controls = Array.from(document.querySelectorAll('input,textarea,select,[contenteditable="true"]'));
    return controls.find(el => isRenderableElement(el) && textMatches(getAccessibleName(el), label, exact));
  }

  function escapeAttr(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function describeVisibleElement(el) {
    const tag = el.tagName.toLowerCase();
    const attrs = [`node_id=${++visibleNodeCounter}`];
    visibleNodeMap.set(String(visibleNodeCounter), el);

    const attrNames = ['href', 'name', 'type', 'placeholder', 'aria-label', 'role', 'title', 'value'];
    for (const name of attrNames) {
      const value = name === 'value' ? el.value : el.getAttribute(name);
      const text = compactText(value, 160);
      if (text) attrs.push(`${name}="${escapeAttr(text)}"`);
    }

    const label = compactText(
      el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.value,
      180
    );
    if (['input', 'textarea', 'select'].includes(tag)) {
      return `<${tag} ${attrs.join(' ')}${label ? `>${escapeAttr(label)}</${tag}>` : ' />'}`;
    }
    return `<${tag} ${attrs.join(' ')}>${escapeAttr(label)}</${tag}>`;
  }

  function getVisibleDom() {
    visibleNodeMap = new Map();
    visibleNodeCounter = 0;

    const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,summary,[role],[tabindex],[onclick],[contenteditable="true"]'));
    const lines = [];
    for (const el of candidates) {
      if (!isInterestingElement(el) || !isVisibleElement(el)) continue;
      lines.push(describeVisibleElement(el));
      if (lines.length >= 120) break;
    }

    return {
      title: document.title,
      url: window.location.href,
      count: lines.length,
      visibleDom: lines.join('\n')
    };
  }

  function getDomSnapshot(limit = 200) {
    const nodes = [];
    const selector = 'main,section,article,nav,header,footer,h1,h2,h3,p,li,a,button,input,textarea,select,summary,[role],[tabindex],[onclick],[contenteditable="true"]';
    const elements = Array.from(document.querySelectorAll(selector));

    for (const el of elements) {
      if (!isRenderableElement(el)) continue;
      const tag = el.tagName.toLowerCase();
      const role = inferRole(el);
      const name = getAccessibleName(el);
      const text = compactText(el.innerText || el.textContent, 220);
      const rect = el.getBoundingClientRect();
      nodes.push({
        tag,
        role: role || undefined,
        name: name || undefined,
        text: text || undefined,
        href: el.getAttribute('href') || undefined,
        type: el.getAttribute('type') || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        visible: isVisibleElement(el),
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
      if (nodes.length >= limit) break;
    }

    return {
      title: document.title,
      url: window.location.href,
      readyState: document.readyState,
      nodeCount: nodes.length,
      nodes
    };
  }

  function getNodeById(nodeId) {
    const el = visibleNodeMap.get(String(nodeId));
    if (!el) {
      throw new Error(`节点不存在或快照已过期: ${nodeId}。请先重新调用 browser_get_visible_dom`);
    }
    if (!document.documentElement.contains(el)) {
      visibleNodeMap.delete(String(nodeId));
      throw new Error(`节点已从页面移除: ${nodeId}。请重新观察页面`);
    }
    return el;
  }

  // ==================== 2. 动作坐标工具 ====================

  /**
   * 计算元素的点击目标坐标。
   * 默认取元素中心，并叠加 1-3px 随机偏移，模拟人类不确定的落点。
   * @returns {{x:number,y:number,rect:DOMRect}}
   */
  function getElementTargetPoint(el, options = {}) {
    const rect = el.getBoundingClientRect();
    const jitter = options.jitter ?? 3;
    const x = rect.left + rect.width / 2 + rand(-jitter, jitter);
    const y = rect.top + rect.height / 2 + rand(-jitter, jitter);
    return { x, y, rect };
  }

  /**
   * 将坐标裁剪到当前视口安全范围内，避免指针跑到屏幕外。
   * 保留 8px 边距，防止贴边消失。
   */
  function getViewportSafePoint(x, y) {
    const margin = 8;
    const w = window.innerWidth;
    const h = window.innerHeight;
    return {
      x: Math.min(Math.max(x, margin), Math.max(margin, w - margin)),
      y: Math.min(Math.max(y, margin), Math.max(margin, h - margin)),
    };
  }

  /**
   * 统一派发完整鼠标事件序列：pointerdown → mousedown → pointerup → mouseup → click。
   * 视觉指针与事件坐标在此处绑定——所有事件使用同一个 (x, y)。
   * 对链接/按钮/role=button 元素额外触发原生 click()，保证框架监听生效。
   */
  function dispatchPointerSequence(el, point) {
    const { x, y } = point;
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y,
      screenX: x + window.screenX, screenY: y + window.screenY,
      button: 0, buttons: 1,
    };

    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', opts));

    // 上方已派发一次完整点击序列。再调用 HTMLElement.click() 会导致业务处理器执行两次。
  }

  // ==================== 3. 视觉层 VisualOverlayController ====================

  // 固定前缀 id/class，避免污染业务页面
  const OVERLAY_ROOT_ID = 'ca-visual-overlay-root';
  const OVERLAY_STYLE_ID = 'ca-visual-overlay-style';
  const POINTER_ID = 'ca-visual-pointer';
  const BANNER_ID = 'ca-visual-banner';
  const HALO_CLASS = 'ca-visual-pointer-halo';
  const PULSE_CLASS = 'ca-visual-pointer-pulse';
  const HINT_CLASS = 'ca-visual-action-hint';
  const CANCEL_BTN_ID = 'ca-visual-cancel-btn';
  const CONTROL_FAVICON_ID = 'ca-browserpilot-control-favicon';
  const Z_INDEX = 2147483646; // 仅低于 2147483647，确保盖在页面之上
  const pageLayoutApi = globalThis.BrowserPilotPageLayoutOffset;
  const PAGE_LAYOUT_ACTIVE_ATTRIBUTE = pageLayoutApi?.ACTIVE_ATTRIBUTE || 'data-ca-visual-banner-offset';
  const PAGE_LAYOUT_ACTIVE_ATTRIBUTE_VALUE = pageLayoutApi?.ACTIVE_ATTRIBUTE_VALUE || 'browserpilot-active';
  const PAGE_LAYOUT_BASE_PADDING_PROPERTY = pageLayoutApi?.BASE_PADDING_PROPERTY || '--ca-visual-page-padding-top';
  const PAGE_LAYOUT_BANNER_HEIGHT_PROPERTY = pageLayoutApi?.BANNER_HEIGHT_PROPERTY || '--ca-visual-banner-height';
  const PAGE_LAYOUT_TRANSITION_MS = pageLayoutApi?.TRANSITION_MS || 220;
  const PageLayoutOffsetController = pageLayoutApi?.PageLayoutOffsetController || class {
    attach() {}
    stop() {}
  };

  /**
   * 通过临时 favicon 呈现标签页级控制状态。Chrome 不开放原生标签栏绘制 API，
   * 因此在控制期间追加一个最后声明的 icon；移除后浏览器会自动回退到页面原图标。
   */
  class TabControlStatusController {
    constructor() {
      this.icon = null;
      this.timerId = null;
      this.visible = false;
    }

    start() {
      this.stop();
      this.icon = document.createElement('link');
      this.icon.id = CONTROL_FAVICON_ID;
      this.icon.rel = 'icon';
      this.icon.type = 'image/svg+xml';
      document.head.appendChild(this.icon);
      this._render(true);
      this.timerId = window.setInterval(() => this._render(!this.visible), 700);
    }

    stop() {
      if (this.timerId != null) window.clearInterval(this.timerId);
      this.timerId = null;
      this.icon?.remove();
      this.icon = null;
      this.visible = false;
    }

    _render(visible) {
      if (!this.icon || !document.documentElement.contains(this.icon)) return;
      this.visible = visible;
      const iconName = visible ? 'control-status-active.svg' : 'control-status-dim.svg';
      this.icon.href = chrome.runtime.getURL(`icons/${iconName}`);
    }
  }

  /**
   * 可视化调试 overlay 控制器。
   * 单例：每个 content script 实例（每个页面）持有一个。
   * 负责注入顶层 root + 样式、渲染顶部提示条与光晕指针、驱动指针动画与点击脉冲。
   */
  class VisualOverlayController {
    constructor() {
      this.root = null;          // overlay 顶层容器
      this.pointer = null;       // 光晕指针 DOM
      this.banner = null;        // 顶部提示条 DOM
      this.hint = null;          // 动作提示文案 DOM
      this._active = false;      // overlay 是否已 start
      this._cursorVisible = true;
      this._current = { x: 0, y: 0 };   // 指针当前坐标
      this._hasCurrent = false;          // 是否已有起点（避免从 0,0 飞入）
      this._rafId = null;                // 当前进行中的移动动画 interval id
      this._rafTimeoutId = null;         // 动画超时兜底 timer id
      this._cancelCb = null;             // 取消按钮回调
      this.tabStatus = new TabControlStatusController();
      this.pageLayout = new PageLayoutOffsetController();
    }

    // ── 样式注入 ───────────────────────────

    /** 注入 overlay 专用样式。幂等。 */
    ensureStyle() {
      if (document.getElementById(OVERLAY_STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = OVERLAY_STYLE_ID;
      style.textContent = this._buildCss();
      document.documentElement.appendChild(style);
    }

    _buildCss() {
      return `
#${OVERLAY_ROOT_ID} {
  all: initial;
  position: fixed;
  inset: 0;
  width: 0; height: 0;
  z-index: ${Z_INDEX};
  pointer-events: none;
}
#${OVERLAY_ROOT_ID} * {
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

html[${PAGE_LAYOUT_ACTIVE_ATTRIBUTE}="${PAGE_LAYOUT_ACTIVE_ATTRIBUTE_VALUE}"] {
  padding-top: calc(
    var(${PAGE_LAYOUT_BASE_PADDING_PROPERTY}, 0px) +
    var(${PAGE_LAYOUT_BANNER_HEIGHT_PROPERTY}, 0px)
  ) !important;
  box-sizing: border-box !important;
  transition: padding-top ${PAGE_LAYOUT_TRANSITION_MS}ms ease-out !important;
}

/* ── 顶部提示条 ── */
#${BANNER_ID} {
  position: fixed;
  top: 0; left: 0;
  width: 100%;
  min-height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 5px 10px;
  background: #ffffff;
  color: #1f2328;
  font-size: 12px;
  font-weight: 500;
  border-bottom: 1px solid rgba(88,166,255,0.35);
  box-shadow: none;
  pointer-events: none;
  transform: translateY(-100%);
  animation: ca-banner-in 260ms ease-out forwards;
}
#${BANNER_ID}.ca-theme-dark {
  background: #161b22;
  color: #e6edf3;
  border-bottom-color: rgba(88,166,255,0.5);
}
#${BANNER_ID}.ca-state-running { border-bottom-color: rgba(88,166,255,0.5); }
#${BANNER_ID}.ca-state-error   { border-bottom-color: rgba(248,81,73,0.6); }
#${BANNER_ID}.ca-state-done    { border-bottom-color: rgba(63,185,80,0.6); }
#${BANNER_ID} .ca-banner-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: #58a6ff; flex: 0 0 auto;
  box-shadow: 0 0 0 3px rgba(88,166,255,0.16);
  animation: ca-dot-pulse 1.4s ease-in-out infinite;
}
#${BANNER_ID} .ca-banner-msg { flex: 0 1 auto; max-width: min(70vw, 520px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${BANNER_ID} .ca-banner-state { color: #8b949e; font-size: 12px; font-weight: 400; }
#${CANCEL_BTN_ID} {
  pointer-events: auto;
  flex: 0 0 auto;
  padding: 3px 10px;
  border: 1px solid #30363d;
  border-radius: 5px;
  background: #24292f;
  color: #ffffff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}
#${CANCEL_BTN_ID}:hover { background: #343b43; }

@keyframes ca-banner-in { to { transform: translateY(0); } }
@keyframes ca-dot-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

/* ── 光晕指针 ── */
#${POINTER_ID} {
  position: fixed;
  top: 0; left: 0;
  width: 22px; height: 22px;
  margin: 0;
  pointer-events: none;
  will-change: transform;
  transform: translate3d(-100px, -100px, 0) scale(0);
  transition: transform 0ms;
  z-index: ${Z_INDEX};
}
#${POINTER_ID}.ca-pointer-visible { transform: translate3d(-100px, -100px, 0) scale(1); }
/* 指针按下时轻微下沉 */
#${POINTER_ID}.ca-pointer-down {
  transform: translate3d(var(--ca-px, 0px), var(--ca-py, 0px), 0) scale(0.86);
}
#${POINTER_ID} .ca-pointer-arrow {
  position: absolute;
  top: 0; left: 0;
  width: 22px; height: 22px;
  /* 精致科技蓝与白描边指针 */
  background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><path d="M2 2 L18 9 L11 11 L9 18 Z" fill="%233b82f6" stroke="%23ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>') no-repeat center / contain;
  filter: drop-shadow(0 2px 3px rgba(0,0,0,0.4));
}
/* 光晕：混合模式叠加，中心亮蓝外圈淡出 */
.${HALO_CLASS} {
  position: absolute;
  top: 50%; left: 50%;
  width: 50px; height: 50px;
  margin: -25px 0 0 -25px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(59,130,246,0.35) 0%, rgba(59,130,246,0.12) 40%, rgba(59,130,246,0) 80%);
  animation: ca-halo-breathe 2.4s ease-in-out infinite;
  pointer-events: none;
  mix-blend-mode: screen;
}
@keyframes ca-halo-breathe { 0%,100% { opacity: 0.8; transform: scale(0.95); } 50% { opacity: 1; transform: scale(1.15); } }

/* 点击脉冲：扩散发光的涟漪圈，动画后自动移除 */
.${PULSE_CLASS} {
  position: fixed;
  top: 0; left: 0;
  width: 14px; height: 14px;
  margin: -7px 0 0 -7px;
  border-radius: 50%;
  border: 1.5px solid #3b82f6;
  box-shadow: 0 0 6px rgba(59,130,246,0.5);
  pointer-events: none;
  z-index: ${Z_INDEX};
  animation: ca-pulse 420ms cubic-bezier(0.1, 0.8, 0.3, 1) forwards;
}
@keyframes ca-pulse {
  0%   { transform: translate3d(var(--ca-px,0), var(--ca-py,0), 0) scale(0.5); opacity: 0.9; }
  100% { transform: translate3d(var(--ca-px,0), var(--ca-py,0), 0) scale(3.5); opacity: 0; }
}

/* 动作提示文案（如"向下滚动"），跟随指针显示 */
.${HINT_CLASS} {
  position: fixed;
  top: 0; left: 0;
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(13,17,23,0.88);
  color: #e6edf3;
  font-size: 12px;
  font-weight: 500;
  pointer-events: none;
  z-index: ${Z_INDEX};
  transform: translate3d(var(--ca-px,0), var(--ca-py,0), 0);
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.18s ease;
}
.${HINT_CLASS}.ca-hint-show { opacity: 1; }

@media (prefers-reduced-motion: reduce) {
  html[${PAGE_LAYOUT_ACTIVE_ATTRIBUTE}="${PAGE_LAYOUT_ACTIVE_ATTRIBUTE_VALUE}"] { transition: none !important; }
  #${BANNER_ID} { animation: none; transform: translateY(0); }
  .${HALO_CLASS} { animation: none; }
  .${PULSE_CLASS} { animation-duration: 180ms; }
}
`;
    }

    // ── root 容器 ──────────────────────────

    /**
     * 确保 overlay root 存在。SPA 跳转或页面重绘后 root 可能被冲掉，
     * 因此每个 action 前都应调用。幂等。
     */
    ensureOverlay() {
      this.ensureStyle();
      if (this.root && document.documentElement.contains(this.root)) return;

      this.root = document.createElement('div');
      this.root.id = OVERLAY_ROOT_ID;
      document.documentElement.appendChild(this.root);

      // 重建指针（若之前已 start）
      if (this._active) {
        this._buildPointer();
        this._buildBanner();
      }
    }

    // ── 生命周期 ───────────────────────────

    /**
     * 开启可视化调试。
     * @param {{label?:string, message?:string, showCancel?:boolean, theme?:string, cursor?:boolean}} options
     */
    start(options = {}) {
      this.ensureOverlay();
      clearTimeout(this._autoStopTimer);
      this._active = true;
      this._cursorVisible = options.cursor !== false;
      this.tabStatus.start();

      this._buildBanner(options);
      if (this._cursorVisible) {
        this._buildPointer();
        // 首次显示从视口中心淡入，后续重建也必须重新标记为可见。
        if (!this._hasCurrent) {
          this._current = getViewportSafePoint(window.innerWidth / 2, window.innerHeight / 2);
          this._hasCurrent = true;
        }
        this._applyPointerTransform();
        requestAnimationFrame(() => this.pointer?.classList.add('ca-pointer-visible'));
      }
      return { ok: true, started: true };
    }

    /**
     * 关闭可视化调试，移除所有 overlay DOM。
     * @param {{reason?:string}} options
     */
    stop(options = {}) {
      this._cancelRaf();
      clearTimeout(this._autoStopTimer);
      this.pageLayout.stop();
      if (this.banner) { this.banner.remove(); this.banner = null; }
      if (this.pointer) { this.pointer.remove(); this.pointer = null; }
      if (this.hint) { this.hint.remove(); this.hint = null; }
      this.tabStatus.stop();
      this._active = false;
      this._hasCurrent = false;
      return { ok: true, stopped: true, reason: options.reason || 'completed' };
    }

    /**
     * 更新提示条文案与状态。
     * @param {{message?:string, state?:string}} options  state: running|error|done
     */
    update(options = {}) {
      this.ensureOverlay();
      if (!this.banner) return { ok: false, reason: 'banner not started' };

      if (options.state) {
        this.banner.classList.remove('ca-state-running', 'ca-state-error', 'ca-state-done');
        this.banner.classList.add('ca-state-' + options.state);
        const dot = this.banner.querySelector('.ca-banner-dot');
        if (dot) {
          const colorMap = { running: '#58a6ff', error: '#f85149', done: '#3fb950' };
          dot.style.background = colorMap[options.state] || '#58a6ff';
        }
      }
      if (options.state === 'done') {
        clearTimeout(this._autoStopTimer);
        this._autoStopTimer = setTimeout(() => this.stop({ reason: 'done' }), 800);
      }
      return { ok: true, updated: true };
    }

    // ── 指针移动 ───────────────────────────

    /**
     * 将指针移动到 (x,y)。线性/曲线动画由 movePointerHumanLike 实现，
     * 此处为带 duration 的 ease-out 过渡（用于显式 visualPointerMove 调用）。
     * 坐标先经视口裁剪。
     */
    movePointer(x, y, options = {}) {
      this.ensureOverlay();
      if (!this._cursorVisible || !this.pointer) return { ok: true, skipped: 'cursor disabled' };

      const safe = getViewportSafePoint(x, y);
      const duration = options.duration ?? 280;
      return this.movePointerHumanLike(safe.x, safe.y, { duration });
    }

    /**
     * 人类轨迹移动：从当前位置出发，沿二次贝塞尔曲线移动到目标，
     * 距离越远耗时越长（180–900ms），尊重 prefers-reduced-motion。
     * 终点精确落在事件坐标附近。返回 Promise，resolve 时指针已就位。
     */
    movePointerHumanLike(x, y, options = {}) {
      this.ensureOverlay();
      if (!this._cursorVisible || !this.pointer) {
        // 即使指针不可见，也要更新内部坐标，保证后续事件坐标连贯
        this._current = { x, y };
        this._hasCurrent = true;
        return Promise.resolve({ ok: true, skipped: 'cursor disabled' });
      }

      const safe = getViewportSafePoint(x, y);
      const start = this._hasCurrent
        ? { ...this._current }
        : getViewportSafePoint(window.innerWidth / 2, window.innerHeight / 2);

      // 距离自适应耗时
      const dist = Math.hypot(safe.x - start.x, safe.y - start.y);
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      let duration = options.duration;
      if (duration === undefined) {
        duration = reduced ? 60 : Math.min(900, Math.max(180, dist * 0.6 + 120));
      }

      // 二次贝塞尔控制点：在起点-终点连线侧向偏移一点，制造轻微弧度
      const midX = (start.x + safe.x) / 2;
      const midY = (start.y + safe.y) / 2;
      const offset = reduced ? 0 : randFloat(-Math.min(80, dist * 0.15), Math.min(80, dist * 0.15));
      const ctrlX = midX + offset;
      const ctrlY = midY - Math.abs(offset) * 0.5;

      return this._animateBezier(start, { x: ctrlX, y: ctrlY }, safe, duration)
        .then(() => {
          this._current = safe;
          this._hasCurrent = true;
          return { ok: true, x: safe.x, y: safe.y };
        });
    }

    /**
     * 沿二次贝塞尔曲线移动指针。
     * 用 setInterval 驱动而非 requestAnimationFrame——rAF 在后台/非焦点窗口会被
     * 严重节流（实测 300ms 动画拖到 15s），导致命令长时间阻塞。setInterval 在后台
     * 虽也节流但有超时兜底，最多 duration*2 + 200ms 即强制完成。
     */
    _animateBezier(p0, p1, p2, duration) {
      this._cancelRaf();
      return new Promise(resolve => {
        const el = this.pointer;
        if (!el) { resolve(); return; }

        const start = Date.now();
        const FRAME = 16; // ~60fps 步进
        let done = false;

        const finish = () => {
          if (done) return;
          done = true;
          clearInterval(this._rafId);
          clearTimeout(this._rafTimeoutId);
          this._rafId = null;
          this._rafTimeoutId = null;
          // 终点精确归位
          this._current = { x: p2.x, y: p2.y };
          this._applyPointerTransform();
          resolve();
        };

        const step = () => {
          const elapsed = Date.now() - start;
          const t = Math.min(1, elapsed / duration);
          const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
          const x = (1 - e) * (1 - e) * p0.x + 2 * (1 - e) * e * p1.x + e * e * p2.x;
          const y = (1 - e) * (1 - e) * p0.y + 2 * (1 - e) * e * p1.y + e * e * p2.y;
          this._current = { x, y };
          this._applyPointerTransform();
          if (t >= 1) finish();
        };

        this._rafId = setInterval(step, FRAME);
        // 超时兜底：无论节流与否，最多 duration*2 + 300ms 强制完成，避免命令阻塞
        this._rafTimeoutId = setTimeout(finish, duration * 2 + 300);
      });
    }

    _cancelRaf() {
      if (this._rafId) { clearInterval(this._rafId); this._rafId = null; }
      if (this._rafTimeoutId) { clearTimeout(this._rafTimeoutId); this._rafTimeoutId = null; }
    }

    /** 将指针 transform 同步到当前 _current 坐标。 */
    _applyPointerTransform() {
      if (!this.pointer) return;
      this.pointer.style.setProperty('--ca-px', this._current.x + 'px');
      this.pointer.style.setProperty('--ca-py', this._current.y + 'px');
      this.pointer.style.transform =
        `translate3d(${this._current.x}px, ${this._current.y}px, 0)`;
    }

    /** 当前指针坐标（供 humanClick 等读取事件坐标基准）。 */
    get current() {
      return { ...this._current };
    }

    get isActive() { return this._active; }

    // ── 按下 / 抬起 / 脉冲 ─────────────────

    /** 指针按下反馈：轻微缩放下沉。 */
    pointerDown() {
      if (!this.pointer) return;
      this.pointer.classList.add('ca-pointer-down');
    }

    /** 指针抬起反馈：恢复缩放。 */
    pointerUp() {
      if (!this.pointer) return;
      this.pointer.classList.remove('ca-pointer-down');
    }

    /**
     * 点击脉冲：在指针中心生成扩散圆环，动画结束后自动移除。
     * @param {{x?:number,y?:number}} options 不传则用当前指针坐标
     */
    pulsePointer(options = {}) {
      this.ensureOverlay();
      if (!this.root) return { ok: true, skipped: 'no root' };
      const x = options.x ?? this._current.x;
      const y = options.y ?? this._current.y;
      const pulse = document.createElement('div');
      pulse.className = PULSE_CLASS;
      pulse.style.setProperty('--ca-px', x + 'px');
      pulse.style.setProperty('--ca-py', y + 'px');
      this.root.appendChild(pulse);
      pulse.addEventListener('animationend', () => pulse.remove(), { once: true });
      // 兜底：动画事件未触发时 600ms 后清理
      setTimeout(() => pulse.remove(), 600);
      return { ok: true, x, y };
    }

    /**
     * 在指针旁显示动作提示文案（如"向下滚动"），duration 后淡出。
     * @param {{text:string, duration?:number, offset?:number}} options
     */
    showActionHint(options = {}) {
      this.ensureOverlay();
      const text = options.text;
      if (!text) return { ok: true, skipped: 'no text' };
      const duration = options.duration ?? 600;
      const offset = options.offset ?? 26;

      if (!this.hint) {
        this.hint = document.createElement('div');
        this.hint.className = HINT_CLASS;
        this.root.appendChild(this.hint);
      }
      this.hint.textContent = text;
      const px = this._current.x + offset;
      const py = this._current.y + offset;
      this.hint.style.setProperty('--ca-px', px + 'px');
      this.hint.style.setProperty('--ca-py', py + 'px');
      this.hint.style.transform = `translate3d(${px}px, ${py}px, 0)`;
      requestAnimationFrame(() => this.hint.classList.add('ca-hint-show'));

      clearTimeout(this._hintTimer);
      this._hintTimer = setTimeout(() => {
        this.hint?.classList.remove('ca-hint-show');
      }, duration);
      return { ok: true };
    }

    // ── DOM 构建 ───────────────────────────

    _buildBanner(options = {}) {
      this.ensureOverlay();
      if (this.banner) {
        try { this.banner.remove(); } catch {}
      }
      const existing = document.getElementById(BANNER_ID);
      if (existing) {
        try { existing.remove(); } catch {}
      }
      const banner = document.createElement('div');
      banner.id = BANNER_ID;
      if (options.theme === 'dark') banner.classList.add('ca-theme-dark');
      banner.classList.add('ca-state-running');

      const dot = document.createElement('span');
      dot.className = 'ca-banner-dot';
      const msg = document.createElement('span');
      msg.className = 'ca-banner-msg';
      msg.textContent = `“${normalizeOverlayLabel(options.label)}”已开始调试此浏览器`;

      banner.appendChild(dot);
      banner.appendChild(msg);

      if (options.showCancel !== false) {
        const btn = document.createElement('button');
        btn.id = CANCEL_BTN_ID;
        btn.type = 'button';
        btn.textContent = '取消';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._onCancel();
        });
        banner.appendChild(btn);
      }

      this.root.appendChild(banner);
      this.banner = banner;
      this.pageLayout.attach(banner);
    }

    _buildPointer() {
      this.ensureOverlay();
      if (this.pointer) {
        try { this.pointer.remove(); } catch {}
      }
      const existing = document.getElementById(POINTER_ID);
      if (existing) {
        try { existing.remove(); } catch {}
      }
      const p = document.createElement('div');
      p.id = POINTER_ID;

      const halo = document.createElement('div');
      halo.className = HALO_CLASS;
      const arrow = document.createElement('div');
      arrow.className = 'ca-pointer-arrow';

      p.appendChild(halo);
      p.appendChild(arrow);
      this.root.appendChild(p);
      this.pointer = p;
    }

    _onCancel() {
      // 立即隐藏，给用户即时反馈
      this.stop({ reason: 'cancelled' });
      // 上报到 background（background 再转发给 orchestrator）
      try {
        chrome.runtime.sendMessage({
          source: 'visualOverlay',
          type: 'cancelRequested',
          url: window.location.href,
        }, () => { /* 忽略响应 */ });
      } catch { /* 通道可能已断，忽略 */ }
    }

    /** 外部可注入取消回调（预留扩展）。 */
    onCancel(cb) { this._cancelCb = cb; }
  }

  // content script 单例 overlay 控制器
  const overlay = new VisualOverlayController();

  // ==================== 4. DOM 操作（模拟人类行为 + 视觉指针） ====================

  /**
   * 模拟人类点击（已接入视觉指针）。
   * 流程：查找元素 → 滚动可见 → 计算目标点 → 指针人类轨迹移动到目标中心
   *      → 指针按下反馈 → 派发完整鼠标事件序列 → 指针抬起 → 点击脉冲。
   * 视觉坐标与事件坐标一致：二者共用 getElementTargetPoint 计算出的同一坐标。
   */
  async function humanClick(selector) {
    if (!selector || !selector.trim()) throw new Error('CSS 选择器不能为空');
    const el = findElement(selector);
    if (!el) throw new Error(`元素未找到: ${selector}`);
    return humanClickElement(el, { selector });
  }

  async function humanClickNode(nodeId) {
    const el = getNodeById(nodeId);
    return humanClickElement(el, { nodeId });
  }

  async function humanClickText(text, exact = false) {
    const el = findByText(text, exact);
    if (!el) throw new Error(`文本元素未找到: ${text}`);
    return humanClickElement(el, { text, exact });
  }

  async function humanClickRole(role, name, exact = false) {
    const el = findByRole(role, name, exact);
    if (!el) throw new Error(`角色元素未找到: ${role}${name ? ` / ${name}` : ''}`);
    return humanClickElement(el, { role, name, exact });
  }

  async function humanClickElement(el, source) {
    if (el.disabled || el.style.display === 'none' || !isRenderableElement(el)) {
      throw new Error(`元素不可交互: ${source.selector || source.nodeId}`);
    }

    await scrollIntoViewSmooth(el);
    await sleep(rand(200, 500));

    if (el.matches?.('input[type="file"]')) {
      const approval = await requestUploadApproval(el);
      if (!approval?.allowed) {
        throw new Error(approval?.reason || '文件选择请求被安全策略阻止');
      }
    }

    // 计算目标点击坐标（事件坐标基准）
    const { x, y, rect } = getElementTargetPoint(el);
    const safe = getViewportSafePoint(x, y);

    // 1) 视觉指针先移动到目标（人类轨迹）
    if (overlay.isActive) {
      await overlay.movePointerHumanLike(safe.x, safe.y);
      await sleep(rand(60, 140));
      overlay.pointerDown();
      await sleep(rand(30, 80));
    }

    // 2) 派发真实鼠标事件序列（事件坐标 = 视觉坐标）
    dispatchPointerSequence(el, safe);

    // 3) 抬起 + 点击脉冲
    if (overlay.isActive) {
      overlay.pointerUp();
      overlay.pulsePointer({ x: safe.x, y: safe.y });
    }

    return { success: true, ...source, boundingBox: rect, point: safe };
  }

  function requestUploadApproval(el) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        source: 'uploadGuard',
        type: 'request',
        accept: el.getAttribute('accept') || '',
        multiple: el.multiple === true
      }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ allowed: false, reason: '无法连接 BrowserPilot 上传审批服务' });
          return;
        }
        resolve(response || { allowed: false, reason: '上传审批没有返回结果' });
      });
    });
  }

  /**
   * 模拟人类输入（已接入视觉指针）。
   * 流程：查找元素 → 滚动可见 → 指针移动到输入框中心 → 聚焦 → 逐字符输入。
   */
  async function humanType(selector, text) {
    if (!selector || !selector.trim()) throw new Error('CSS 选择器不能为空');
    const el = findElement(selector);
    if (!el) throw new Error(`元素未找到: ${selector}`);
    return humanTypeElement(el, text, { selector });
  }

  async function humanTypeNode(nodeId, text) {
    const el = getNodeById(nodeId);
    return humanTypeElement(el, text, { nodeId });
  }

  async function humanTypeByLabel(label, text, exact = false) {
    const el = findInputByLabel(label, exact);
    if (!el) throw new Error(`输入元素未找到: ${label}`);
    return humanTypeElement(el, text, { label, exact });
  }

  async function humanTypeElement(el, text, source) {
    await scrollIntoViewSmooth(el);
    await sleep(rand(100, 300));

    // 指针先移动到输入框中心，视觉上"选中"输入框
    if (overlay.isActive) {
      const { x, y } = getElementTargetPoint(el, { jitter: 6 });
      const safe = getViewportSafePoint(x, y);
      await overlay.movePointerHumanLike(safe.x, safe.y);
      await sleep(rand(80, 160));
    }

    // 聚焦元素
    el.focus();
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));

    if (el.isContentEditable) {
      document.execCommand('selectAll', false, null);
      for (const char of text) {
        document.execCommand('insertText', false, char);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char }));
        await sleep(rand(50, 150));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, ...source, text, length: text.length };
    }

    if (!('value' in el)) {
      throw new Error(`节点不支持输入: ${source.selector || source.nodeId}`);
    }

    const valueSetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(el), 'value'
    )?.set;
    const setValue = value => valueSetter ? valueSetter.call(el, value) : (el.value = value);
    setValue('');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: text
    });
    if (el.dispatchEvent(beforeInput)) {
      setValue(text);
      el.selectionStart = el.selectionEnd = text.length;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    await sleep(Math.min(800, Math.max(80, text.length * rand(35, 65))));

    // 触发 change 事件
    el.dispatchEvent(new Event('change', { bubbles: true }));

    return { success: true, ...source, text, length: text.length };
  }

  /** 智能寻找当前页面真正可滚动的最适容器（如果全局 window 滚不动） */
  function getScrollContainer() {
    const docEl = document.documentElement;
    const body = document.body;
    
    const bodyStyle = window.getComputedStyle(body);
    const htmlStyle = window.getComputedStyle(docEl);
    
    const isWindowScrollable = (docEl.scrollHeight > window.innerHeight || body.scrollHeight > window.innerHeight) &&
      bodyStyle.overflowY !== 'hidden' && htmlStyle.overflowY !== 'hidden';
      
    if (isWindowScrollable) {
      return window;
    }
    
    let bestContainer = null;
    let maxArea = 0;
    
    const elements = document.querySelectorAll('*');
    for (const el of elements) {
      if (el === docEl || el === body) continue;
      
      const style = window.getComputedStyle(el);
      const isScrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight;
        
      if (isScrollable) {
        const area = el.clientWidth * el.clientHeight;
        if (area > maxArea) {
          maxArea = area;
          bestContainer = el;
        }
      }
    }
    
    return bestContainer || window;
  }

  /**
   * 模拟平滑滚动（已接入视觉指针）。
   * 流程：指针移动到页面/滚动容器中部 → 显示滚动方向提示 → 逐帧滚动。
   */
  async function humanScroll(direction, distance) {
    const d = distance || 500;
    const dir = direction || 'down';
    const scrollAmount = dir === 'down' ? d : dir === 'up' ? -d :
                         dir === 'right' ? d : -d;

    const container = getScrollContainer();

    // 指针移动到页面/容器中部，并显示滚动提示
    if (overlay.isActive) {
      const rect = container === window ? 
        { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight } : 
        container.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const midY = rect.top + rect.height / 2;
      await overlay.movePointerHumanLike(midX, midY);
      const hintMap = { down: '向下滚动', up: '向上滚动', left: '向左滚动', right: '向右滚动' };
      overlay.showActionHint({ text: hintMap[dir] || '滚动中', duration: 700 });
      await sleep(rand(120, 200));
    }

    // 使用 requestAnimationFrame 逐帧滚动
    const steps = rand(5, 10);
    const perStep = Math.round(scrollAmount / steps);

    for (let i = 0; i < steps; i++) {
      if (container === window) {
        window.scrollBy({
          top: dir === 'down' || dir === 'up' ? perStep : 0,
          left: dir === 'left' || dir === 'right' ? perStep : 0,
          behavior: 'auto'
        });
      } else {
        container.scrollBy({
          top: dir === 'down' || dir === 'up' ? perStep : 0,
          left: dir === 'left' || dir === 'right' ? perStep : 0,
          behavior: 'auto'
        });
      }
      await sleep(rand(30, 60));
    }

    if (container === window) {
      return { scrollY: window.scrollY, scrollX: window.scrollX };
    } else {
      return { scrollY: container.scrollTop, scrollX: container.scrollLeft };
    }
  }

  /** 获取页面内容 */
  function getContent(selector) {
    if (selector) {
      const el = findElement(selector);
      if (!el) throw new Error(`元素未找到: ${selector}`);
      return {
        text: el.textContent?.trim().slice(0, 5000),
        html: el.outerHTML?.slice(0, 10000),
        tagName: el.tagName,
        boundingBox: el.getBoundingClientRect()
      };
    }

    return {
      title: document.title,
      url: window.location.href,
      text: document.body?.innerText?.trim().slice(0, 10000),
      readyState: document.readyState
    };
  }

  /** 执行自定义 JS */
  function executeCode(code) {
    try {
      const result = eval(code);
      return { result: result !== undefined ? JSON.parse(JSON.stringify(result)) : undefined };
    } catch (err) {
      return { error: err.message };
    }
  }

  /** 等待选择器出现 */
  async function waitForSelector(selector, timeoutMs = 10000) {
    if (!selector || !selector.trim()) return { found: false, error: 'CSS 选择器不能为空' };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = findElement(selector);
      if (el && isVisibleElement(el)) {
        return { found: true, boundingBox: el.getBoundingClientRect() };
      }
      await sleep(200);
    }
    return { found: false };
  }

  // ==================== 5. 消息监听与 action 分发 ====================

  if (!globalThis.chrome?.runtime?.onMessage) {
    console.warn('[ContentScript] chrome.runtime.onMessage 不可用，已跳过消息监听');
    return;
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // ping 检测
    if (request.action === 'ping') {
      sendResponse({
        result: {
          status: 'ok',
          url: window.location.href,
          capabilities: [CONTENT_SCRIPT_CAPABILITY]
        }
      });
      return true;
    }

    // 异步处理所有操作
    handleAction(request).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });

    return true; // 保持消息通道开放
  });

  async function handleAction(request) {
    const { action, params = {} } = request;
    const startTime = Date.now();

    // 每次 action 前确保 overlay 容器存在（SPA 跳转防护）
    if (overlay.isActive) overlay.ensureOverlay();

    let result;
    switch (action) {
      // ── 原有 DOM 操作 ──
      case 'click':
        result = await humanClick(params.selector);
        break;
      case 'type':
        result = await humanType(params.selector, params.text);
        break;
      case 'scroll':
        result = await humanScroll(params.direction, resolveRandom(params.distance));
        break;
      case 'getContent':
        result = getContent(params.selector);
        break;
      case 'getVisibleDom':
        result = getVisibleDom();
        break;
      case 'getDomSnapshot':
        result = getDomSnapshot(params.limit);
        break;
      case 'clickNode':
        result = await humanClickNode(params.nodeId || params.node_id);
        break;
      case 'typeNode':
        result = await humanTypeNode(params.nodeId || params.node_id, params.text);
        break;
      case 'clickText':
        result = await humanClickText(params.text, params.exact);
        break;
      case 'clickRole':
        result = await humanClickRole(params.role, params.name, params.exact);
        break;
      case 'typeByLabel':
        result = await humanTypeByLabel(params.label, params.text, params.exact);
        break;
      case 'execute':
        result = executeCode(params.code);
        break;
      case 'waitForSelector':
        result = await waitForSelector(params.selector, params.timeoutMs);
        break;

      // ── 可视化调试 action ──
      case 'visualStart':
        result = overlay.start(params);
        break;
      case 'visualStop':
        result = overlay.stop(params);
        break;
      case 'visualUpdate':
        result = overlay.update(params);
        break;
      case 'visualPointerMove':
        let moveX = params.x;
        let moveY = params.y;
        if (params.nodeId || params.node_id) {
          const el = getNodeById(params.nodeId || params.node_id);
          const { x, y } = getElementTargetPoint(el);
          moveX = x;
          moveY = y;
        }
        result = await overlay.movePointer(moveX, moveY, params);
        break;
      case 'visualPointerPulse':
        result = overlay.pulsePointer(params);
        break;

      default:
        throw new Error(`未知操作: ${action}`);
    }

    return {
      result: {
        ...result,
        timing: {
          startedAt: startTime,
          finishedAt: Date.now(),
          durationMs: Date.now() - startTime
        }
      }
    };
  }

  function normalizeOverlayLabel(label) {
    const text = String(label || 'BrowserPilot').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return text || 'BrowserPilot';
  }

  console.log('[ContentScript] BrowserPilot 已注入:', window.location.href);
})();
