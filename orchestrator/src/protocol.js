// Chrome Automation Plugin - 消息协议定义
// 统一的消息类型定义与校验，用于 Native Relay ↔ Daemon ↔ Extension

/**
 * 支持的浏览器操作类型
 */
export const BROWSER_ACTIONS = [
  'ping', 'pong', 'ready',
  'navigate', 'click', 'type', 'scroll',
  'screenshot', 'longScreenshot', 'getContent', 'execute',
  'listTabs', 'createTab', 'closeTab',
  'claimTab', 'releaseTab', 'finalizeTabs',
  'goBack', 'goForward', 'reload',
  'waitForSelector', 'waitForLoad', 'waitForNavigation',
  'getVisibleDom', 'getDomSnapshot',
  'clickNode', 'typeNode', 'clickText', 'clickRole', 'typeByLabel',
  // 可视化调试
  'visualStart', 'visualStop', 'visualUpdate',
  'visualPointerMove', 'visualPointerPulse',
];

/**
 * 创建命令消息
 * @param {string} action - 操作类型
 * @param {object} params - 操作参数
 * @param {number} [tabId] - 目标标签页 ID
 * @returns {object} 命令消息
 */
export function createCommand(action, params = {}, tabId) {
  return {
    id: generateId(),
    type: 'command',
    payload: { action, tabId, params }
  };
}

/**
 * 创建响应消息
 * @param {string} id - 对应的请求 ID
 * @param {boolean} success - 是否成功
 * @param {*} [data] - 响应数据
 * @param {string} [error] - 错误消息
 */
export function createResponse(id, success, data, error) {
  return {
    id,
    type: 'result',
    payload: { success, data, error: error || null }
  };
}

/**
 * 校验消息格式
 * @param {object} msg - 待校验的消息
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return { valid: false, error: '消息必须是 JSON 对象' };
  }
  if (!msg.type) {
    return { valid: false, error: '消息缺少 type 字段' };
  }
  if (msg.type === 'command' && !msg.payload?.action) {
    return { valid: false, error: 'command 消息缺少 action' };
  }
  return { valid: true };
}

/**
 * 校验操作类型
 */
export function validateAction(action) {
  return BROWSER_ACTIONS.includes(action);
}

// ── 内部工具 ──────────────────────────────

let _counter = 0;

function generateId() {
  return `ca-${Date.now()}-${++_counter}`;
}

// ── Native Messaging 编解码 ───────────────

/**
 * Native Messaging 单条消息长度上限。
 * Chrome Native Messaging 协议本身上限为 1MB；此处取 8MB 留足余量。
 * 超过此值的长度头视为"脏字节 / 帧边界错位"，触发逐字节重同步，
 * 避免 buffer 因错误的 msgLen 永久中毒。
 */
export const MAX_NATIVE_MSG_LEN = 8 * 1024 * 1024;

/**
 * 编码 Native Messaging 消息（4字节LE长度前缀 + UTF-8 JSON）
 * @param {object} msg
 * @returns {Buffer}
 */
export function encodeNativeMessage(msg) {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * 从 buffer 中解码 Native Messaging 消息。
 * @param {Buffer} buffer - 输入 buffer（会被修改）
 * @returns {{ message: object|null, remaining: Buffer, poisoned?: boolean }}
 *   - message: 解析出的消息；为 null 时表示帧不完整或解析失败
 *   - remaining: 剩余 buffer
 *   - poisoned: true 表示检测到脏长度头（msgLen 超阈值），
 *     调用方应逐字节丢弃直到对齐到真实帧边界，而非用错误 msgLen 跳过。
 */
export function decodeNativeMessage(buffer) {
  if (buffer.length < 4) {
    return { message: null, remaining: buffer };
  }

  const msgLen = buffer.readUInt32LE(0);

  // 脏长度头：msgLen 超过合理上限 → 帧边界错位，不能按此长度跳过
  if (msgLen > MAX_NATIVE_MSG_LEN) {
    return { message: null, remaining: buffer, poisoned: true };
  }

  if (buffer.length < 4 + msgLen) {
    return { message: null, remaining: buffer };
  }

  try {
    const jsonStr = buffer.slice(4, 4 + msgLen).toString('utf8');
    const message = JSON.parse(jsonStr);
    const remaining = buffer.slice(4 + msgLen);
    return { message, remaining };
  } catch {
    // JSON 解析失败：长度头可能对齐但 payload 损坏。
    // 仍按 msgLen 跳过本帧（msgLen 已经过阈值校验，是合理值），
    // 让调用方继续处理后续字节。
    const remaining = buffer.slice(4 + msgLen);
    return { message: null, remaining };
  }
}
