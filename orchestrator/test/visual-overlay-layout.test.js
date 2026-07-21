import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

await import('../../chrome-extension/page-layout-offset.js');

const {
  PageLayoutOffsetController,
  ACTIVE_ATTRIBUTE,
  ACTIVE_ATTRIBUTE_VALUE,
  BASE_PADDING_PROPERTY,
  BANNER_HEIGHT_PROPERTY,
} = globalThis.BrowserPilotPageLayoutOffset;

class FakeStyle {
  constructor() {
    this.values = new Map();
  }

  setProperty(name, value, priority = '') {
    this.values.set(name, { value, priority });
  }

  getPropertyValue(name) {
    return this.values.get(name)?.value || '';
  }

  getPropertyPriority(name) {
    return this.values.get(name)?.priority || '';
  }

  removeProperty(name) {
    this.values.delete(name);
  }
}

class FakeRoot {
  constructor() {
    this.style = new FakeStyle();
    this.attributes = new Map();
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }
}

class FakeResizeObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.observed = null;
    this.disconnected = false;
    FakeResizeObserver.instances.push(this);
  }

  observe(element) {
    this.observed = element;
  }

  disconnect() {
    this.disconnected = true;
  }
}

function createHarness({ reducedMotion = false } = {}) {
  const root = new FakeRoot();
  const listeners = new Map();
  const viewportListeners = new Map();
  const timers = new Map();
  let nextTimerId = 1;
  const windowRef = {
    getComputedStyle: () => ({ paddingTop: '12px' }),
    matchMedia: () => ({ matches: reducedMotion }),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
    visualViewport: {
      addEventListener: (name, callback) => viewportListeners.set(name, callback),
      removeEventListener: (name) => viewportListeners.delete(name),
    },
  };
  const setTimeoutFn = (callback) => {
    const id = nextTimerId++;
    timers.set(id, callback);
    return id;
  };
  const clearTimeoutFn = id => timers.delete(id);
  const runTimers = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach(callback => callback());
  };
  const controller = new PageLayoutOffsetController({
    document: { documentElement: root },
    window: windowRef,
    ResizeObserver: FakeResizeObserver,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
  });

  return { controller, root, listeners, viewportListeners, runTimers };
}

test('visual banner reserves its measured height and tracks resizing', () => {
  FakeResizeObserver.instances = [];
  const harness = createHarness();
  let bannerHeight = 48.2;
  const banner = { getBoundingClientRect: () => ({ height: bannerHeight }) };

  harness.controller.attach(banner);

  assert.equal(harness.root.hasAttribute(ACTIVE_ATTRIBUTE), true);
  assert.equal(harness.root.getAttribute(ACTIVE_ATTRIBUTE), ACTIVE_ATTRIBUTE_VALUE);
  assert.equal(harness.root.style.getPropertyValue(BASE_PADDING_PROPERTY), '12px');
  assert.equal(harness.root.style.getPropertyValue(BANNER_HEIGHT_PROPERTY), '49px');
  assert.equal(harness.listeners.has('resize'), true);
  assert.equal(harness.viewportListeners.has('resize'), true);
  assert.equal(FakeResizeObserver.instances.length, 1);
  assert.equal(FakeResizeObserver.instances[0].observed, banner);

  bannerHeight = 72;
  FakeResizeObserver.instances[0].callback();
  assert.equal(harness.root.style.getPropertyValue(BANNER_HEIGHT_PROPERTY), '72px');
});

test('visual banner restores previous page state after its exit transition', () => {
  const harness = createHarness();
  harness.root.setAttribute(ACTIVE_ATTRIBUTE, 'site-value');
  harness.root.style.setProperty(BASE_PADDING_PROPERTY, '4px', 'important');
  harness.root.style.setProperty(BANNER_HEIGHT_PROPERTY, '7px');
  const banner = { getBoundingClientRect: () => ({ height: 48 }) };

  harness.controller.attach(banner);
  harness.controller.stop();

  assert.equal(harness.root.style.getPropertyValue(BANNER_HEIGHT_PROPERTY), '0px');
  assert.equal(harness.root.hasAttribute(ACTIVE_ATTRIBUTE), true);
  harness.runTimers();

  assert.equal(harness.root.getAttribute(ACTIVE_ATTRIBUTE), 'site-value');
  assert.equal(harness.root.style.getPropertyValue(BASE_PADDING_PROPERTY), '4px');
  assert.equal(harness.root.style.getPropertyPriority(BASE_PADDING_PROPERTY), 'important');
  assert.equal(harness.root.style.getPropertyValue(BANNER_HEIGHT_PROPERTY), '7px');
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.viewportListeners.size, 0);
});

test('reduced motion restores page state immediately', () => {
  const harness = createHarness({ reducedMotion: true });
  const banner = { getBoundingClientRect: () => ({ height: 48 }) };

  harness.controller.attach(banner);
  harness.controller.stop();

  assert.equal(harness.root.hasAttribute(ACTIVE_ATTRIBUTE), false);
  assert.equal(harness.root.style.getPropertyValue(BASE_PADDING_PROPERTY), '');
  assert.equal(harness.root.style.getPropertyValue(BANNER_HEIGHT_PROPERTY), '');
});

test('repeated stop cannot let an old restore timer clear a restarted layout', () => {
  const harness = createHarness();
  const firstBanner = { getBoundingClientRect: () => ({ height: 48 }) };
  const nextBanner = { getBoundingClientRect: () => ({ height: 60 }) };

  harness.controller.attach(firstBanner);
  harness.controller.stop();
  harness.controller.stop();
  harness.controller.attach(nextBanner);
  harness.runTimers();

  assert.equal(harness.root.getAttribute(ACTIVE_ATTRIBUTE), ACTIVE_ATTRIBUTE_VALUE);
  assert.equal(harness.root.style.getPropertyValue(BANNER_HEIGHT_PROPERTY), '60px');
});

test('fallback injection loads the layout helper before the content script', async () => {
  const backgroundSource = await readFile(
    new URL('../../chrome-extension/background.js', import.meta.url),
    'utf8'
  );

  assert.match(
    backgroundSource,
    /CONTENT_SCRIPT_FILES\s*=\s*Object\.freeze\(\['page-layout-offset\.js', 'content\.js'\]\)/
  );
  assert.match(
    backgroundSource,
    /CONTENT_SCRIPT_UPGRADE_FILES\s*=\s*Object\.freeze\(\[\s*'page-layout-offset\.js',\s*'page-layout-offset-bootstrap\.js'\s*\]\)/
  );
  assert.match(
    backgroundSource,
    /if \(!response\?\.result\?\.capabilities\?\.includes\(CONTENT_SCRIPT_CAPABILITY\)\) \{[\s\S]*?files: CONTENT_SCRIPT_UPGRADE_FILES/
  );
  assert.doesNotMatch(
    backgroundSource,
    /capabilities\?\.includes\(CONTENT_SCRIPT_CAPABILITY\)[\s\S]*?files: CONTENT_SCRIPT_FILES/
  );
});
