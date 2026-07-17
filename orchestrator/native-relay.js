#!/usr/bin/env node
// Chrome Automation Plugin - Native Relay
// 由 Chrome spawn，通过 stdin/stdout 接收 Native Messaging 消息，
// 通过 WebSocket 转发到 Daemon

import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeNativeMessage, decodeNativeMessage, MAX_NATIVE_MSG_LEN } from './src/protocol.js';

const DAEMON_WS_URL = process.env.CA_DAEMON_WS || 'ws://127.0.0.1:9877';
const RECONNECT_DELAY_BASE = 1000;   // 指数退避基数
const RECONNECT_DELAY_MAX = 15000;   // 退避封顶
const PING_INTERVAL = 15000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_LOG = path.join(__dirname, 'logs', 'native-relay-debug.log');
const RELAY_TOKEN_PATH = process.env.CA_RELAY_TOKEN_PATH || path.join(process.env.USERPROFILE || process.env.HOME || '', '.browserpilot', 'relay-token');

function loadRelayToken() {
  const token = process.env.CA_RELAY_TOKEN || fs.readFileSync(RELAY_TOKEN_PATH, 'utf8').trim();
  if (!token) throw new Error('未找到 Native Relay 凭证');
  return token;
}

function debugLog(message, detail) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    const suffix = detail === undefined ? '' : ' ' + JSON.stringify(detail);
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${message}${suffix}\n`);
  } catch {
    // Native Messaging stdout must stay protocol-only; ignore logging failures.
  }
}

// ── 状态 ──────────────────────────────────

let ws = null;
let stdinBuffer = Buffer.alloc(0);
let connected = false;
let pingTimer = null;
let reconnectAttempt = 0;   // 指数退避计数：连接成功后归零

// ── WebSocket 连接 ────────────────────────

function connectWs() {
  ws = new WebSocket(DAEMON_WS_URL, loadRelayToken());

  ws.on('open', () => {
    connected = true;
    // 不在此处重置 reconnectAttempt：daemon 拒连时 open 后会立即 close，
    // 若每次 open 都归零，close 时退避永远按 2^0=1s 计算，多 relay 并存时秒级风暴。
    // 仅在收到 welcome（连接被 daemon 真正接受）后才归零，见 ws.on('message')。
    console.error('[Relay] 已连接到 Daemon');
    debugLog('ws.open', { url: DAEMON_WS_URL });

    // 重连后清理断开期间累积的 stdin 残骸——这些是旧会话的半包，
    // 强行处理会导致帧边界错位中毒。直接丢弃，让 Chrome 重新发起握手。
    if (stdinBuffer.length > 0) {
      debugLog('ws.open.discard_stale_stdin', { bytes: stdinBuffer.length });
      stdinBuffer = Buffer.alloc(0);
    }

    // 发送 ready
    ws.send(JSON.stringify({ type: 'ready', payload: {} }));

    // 处理缓冲的 stdin 消息
    processStdinBuffer();

    // 启动心跳
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'ping', payload: {} }));
      }
    }, PING_INTERVAL);
  });

  ws.on('message', (data) => {
    // 从 Daemon 收到消息 → 转发到 Chrome（stdout）
    try {
      const msg = JSON.parse(data.toString());
      debugLog('ws.message', { type: msg.type, id: msg.id, action: msg.payload?.action });

      // 收到 welcome 说明 daemon 真正接受了连接（未被拒连），此时才重置退避。
      // open 时不重置，避免被瞬拒的连接永远停在 1s 重连。
      if (msg.type === 'welcome') reconnectAttempt = 0;

      if (msg.type === 'pong') return; // 忽略心跳响应

      const encoded = encodeNativeMessage(msg);
      process.stdout.write(encoded);
      debugLog('chrome.stdout.write', { bytes: encoded.length, type: msg.type, id: msg.id, action: msg.payload?.action });
    } catch (err) {
      console.error('[Relay] WS 消息处理失败:', err.message);
      debugLog('ws.message.error', { error: err.message });
    }
  });

  ws.on('close', () => {
    connected = false;
    clearInterval(pingTimer);
    // 指数退避：1s → 2s → 4s → 8s → 封顶 15s
    // 避免多 relay 并存时秒级疯狂重连互相踢。
    const delay = Math.min(RECONNECT_DELAY_MAX, RECONNECT_DELAY_BASE * Math.pow(2, reconnectAttempt));
    reconnectAttempt++;
    console.error(`[Relay] Daemon 连接断开，将在 ${delay}ms 后重连（第 ${reconnectAttempt} 次）...`);
    debugLog('ws.close', { reconnectAttempt, delay });
    setTimeout(connectWs, delay);
  });

  ws.on('error', (err) => {
    console.error('[Relay] WS 错误:', err.message);
    debugLog('ws.error', { error: err.message });
    // 重连由 close 事件处理
  });
}

// ── stdin 处理 ────────────────────────────

process.stdin.on('data', (chunk) => {
  // 关键修复：确保 chunk 始终是 Buffer，避免 setEncoding 问题
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'binary');
  debugLog('chrome.stdin.data', { bytes: buf.length });
  stdinBuffer = Buffer.concat([stdinBuffer, buf]);
  processStdinBuffer();
});

function processStdinBuffer() {
  while (stdinBuffer.length >= 4) {
    const msgLen = stdinBuffer.readUInt32LE(0);
    debugLog('chrome.stdin.frame.peek', {
      bufferBytes: stdinBuffer.length,
      msgLen,
      first16Hex: stdinBuffer.slice(0, 16).toString('hex')
    });

    // 优先检测脏帧：
    //   1) msgLen 超阈值 → 长度头错位
    //   2) payload 首字节不是 '{' (0x7B) → 帧边界错位
    //      Native Messaging payload 必然是 JSON 对象，首字节恒为 '{'。
    //      任何非 '{' 开头都说明 4 字节长度头读到了残骸中间，必须逐字节重同步。
    // 这两项必须在 incomplete 判定之前，否则"半合理 msgLen + 损坏 payload"
    // 会被当成"等更多数据"永久卡死（如现场 msgLen=9853、首字节 \0 的情况）。
    // 注意：buffer 恰好 4 字节时还看不到 payload 首字节，需等至少 5 字节才能判定，
    // 否则正常的不完整帧会被误判中毒。
    if (stdinBuffer.length >= 5 &&
        (msgLen > MAX_NATIVE_MSG_LEN || stdinBuffer[4] !== 0x7B)) {
      stdinBuffer = resyncFrameBoundary(stdinBuffer);
      continue;
    }

    if (stdinBuffer.length < 4 + msgLen) {
      // 帧不完整：msgLen 合理、首字节是 '{'，但 buffer 未收齐，等下一批 stdin。
      try {
        fs.writeFileSync(path.join(path.dirname(DEBUG_LOG), 'native-relay-last-frame.bin'), stdinBuffer);
      } catch {}
      const recovered = tryRecoverCompleteJsonFrame(stdinBuffer, msgLen);
      if (recovered) {
        handleChromeMessage(recovered);
        stdinBuffer = Buffer.alloc(0);
        continue;
      }
      debugLog('chrome.stdin.frame.incomplete', {
        bufferBytes: stdinBuffer.length,
        expectedBytes: 4 + msgLen,
        missingBytes: 4 + msgLen - stdinBuffer.length
      });
      break;
    }

    const decoded = decodeNativeMessage(stdinBuffer);

    // decodeNativeMessage 内部已做阈值 + 首字节校验；poisoned 理论上不会在此处再次出现，
    // 但保留兜底以防极端情况。
    if (decoded.poisoned) {
      stdinBuffer = resyncFrameBoundary(stdinBuffer);
      continue;
    }

    stdinBuffer = decoded.remaining;

    if (!decoded.message) {
      debugLog('chrome.stdin.frame.no_message', {
        remainingBytes: stdinBuffer.length,
        msgLen
      });
      break; // 消息不完整或解析失败
    }
    handleChromeMessage(decoded.message);
  }
}

/**
 * 帧边界重同步：当检测到脏长度头时，逐字节扫描丢弃，
 * 直到找到下一个"合理的 4 字节长度头 + 合法 JSON 起始"位置。
 *
 * 判定对齐的启发式（兼顾稳健与简单）：
 *   candidate = buffer[i..i+3] 作为 LE uint32
 *   合理 = msgLen <= MAX_NATIVE_MSG_LEN 且 buffer[i+4] === 0x7B ('{')
 * Native Messaging payload 必然是 JSON 对象，首字节恒为 '{' (0x7B)，
 * 以此为锚点可快速跳过任何残骸。
 *
 * @param {Buffer} buffer 中毒 buffer
 * @returns {Buffer} 重同步后的 buffer（可能仍不完整，交给主循环继续）
 */
function resyncFrameBoundary(buffer) {
  const lostBytes0 = buffer.length;
  for (let i = 1; i <= buffer.length - 5; i++) {
    const candidateLen = buffer.readUInt32LE(i);
    if (candidateLen > MAX_NATIVE_MSG_LEN) continue;
    if (buffer[i + 4] !== 0x7B) continue; // payload 必须以 '{' 开头
    // 找到候选对齐点
    const dropped = buffer.slice(0, i);
    debugLog('chrome.stdin.frame.resync', {
      droppedBytes: i,
      droppedHex: dropped.toString('hex').slice(0, 64),
      alignedMsgLen: candidateLen
    });
    return buffer.slice(i);
  }
  // 未找到对齐点：保留末尾 4 字节（可能是下一个长度头的开始），丢弃其余
  const keep = buffer.slice(Math.max(0, buffer.length - 4));
  debugLog('chrome.stdin.frame.resync_failed', {
    droppedBytes: buffer.length - keep.length,
    keptTailBytes: keep.length
  });
  return keep;
}

function tryRecoverCompleteJsonFrame(buffer, msgLen) {
  try {
    const jsonStr = buffer.slice(4).toString('utf8').trimEnd();
    if (!jsonStr.endsWith('}')) return null;
    const message = JSON.parse(jsonStr);
    debugLog('chrome.stdin.frame.recovered', {
      msgLen,
      actualBytes: Buffer.byteLength(jsonStr, 'utf8'),
      type: message.type,
      id: message.id
    });
    return message;
  } catch (err) {
    debugLog('chrome.stdin.frame.recover_failed', { error: err.message });
    return null;
  }
}

function handleChromeMessage(message) {
  message = decodeUnicodeEscapeStrings(message);
  debugLog('chrome.stdin.message', { type: message.type, id: message.id, action: message.payload?.action, success: message.payload?.success });

  if (connected && ws && ws.readyState === 1) {
    ws.send(JSON.stringify(message));
    debugLog('ws.send', { type: message.type, id: message.id, success: message.payload?.success });
  } else {
    // 未连接时丢弃消息（Chrome 会收到 disconnect 并重连）
    console.error('[Relay] Daemon 未连接，消息已丢弃');
    debugLog('ws.not_connected.drop', { type: message.type, id: message.id });
  }
}

function decodeUnicodeEscapeStrings(value) {
  if (typeof value === 'string') {
    return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => {
      return String.fromCharCode(parseInt(hex, 16));
    });
  }
  if (Array.isArray(value)) return value.map(decodeUnicodeEscapeStrings);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = decodeUnicodeEscapeStrings(child);
    }
    return out;
  }
  return value;
}

// ── 启动 ──────────────────────────────────

process.stdin.resume();
process.stdin.setEncoding(null); // binary mode

// 关键：监听 stdin 关闭。Chrome 扩展断开 nativePort（disconnect 或 SW 重启）时，
// stdin 会触发 'end'/'close'。若不处理，relay 进程不会退出、WS 连接不断，
// 残留为"僵尸 relay"——仍占着 daemon 的 relayConnection slot，却不再有任何消息往来，
// 导致扩展重新 spawn 的新 relay 被拒/被抢占，握手永远完不成。
// 故 stdin 关闭即主动关闭 WS 并退出，让 daemon 释放 slot。
process.stdin.on('end', () => {
  console.error('[Relay] stdin 已关闭（Chrome 断开 nativePort），退出');
  debugLog('stdin.end');
  cleanupAndExit(0);
});
process.stdin.on('close', () => {
  console.error('[Relay] stdin 已关闭，退出');
  debugLog('stdin.close');
  cleanupAndExit(0);
});
process.stdin.on('error', (err) => {
  console.error('[Relay] stdin 错误:', err.message);
  debugLog('stdin.error', { error: err.message });
  cleanupAndExit(1);
});

function cleanupAndExit(code) {
  clearInterval(pingTimer);
  try { if (ws) ws.close(); } catch {}
  process.exit(code);
}

connectWs();

console.error(`[Relay] Native Relay 已启动，目标: ${DAEMON_WS_URL}`);
debugLog('relay.start', { url: DAEMON_WS_URL, argv: process.argv.slice(2) });
