const screenshot = require('screenshot-desktop');
const sharp = require('sharp');
const WebSocket = require('ws');
const {
  mouse,
  keyboard,
  Button,
  Key,
  Point,
  screen,
} = require('@nut-tree-fork/nut-js');
const {
  loadConfig,
  MessageType,
  Role,
  encodeMessage,
  decodeMessage,
  encodeFrameBinary,
  LOG_PATH,
  ensureAppDir,
} = require('@ss-remote/shared');
const fs = require('fs');
const { startHostHotkeys } = require('./hotkeys');
const { typeMimic } = require('./type-text');

mouse.config.autoDelayMs = 0;
keyboard.config.autoDelayMs = 0;

let clipboardy;
function getClipboard() {
  if (!clipboardy) {
    clipboardy = require('clipboardy');
  }
  return clipboardy;
}

let ws = null;
let captureTimer = null;
let clipboardTimer = null;
let reconnectTimer = null;
let stopHotkeys = null;
let screenMeta = { width: 1920, height: 1080, scale: 1 };
let nativeSize = { width: 1920, height: 1080 };
let capturing = false;
let controllerConnected = false;
let manualLock = false; // Ctrl+Alt+L
let hostBusy = false; // host is using local mouse/keyboard
let hostIdleTimer = null;
let suppressHostUntil = 0; // ignore "host activity" caused by our own remote injection
let lastBroadcastEnabled = true;
let lastBroadcastReason = 'enabled';
let lastClipboardSent = '';
let lastClipboardApplied = '';
let applyingClipboard = false;

// Coalesce mouse moves so the cursor does not lag behind a queue of awaits
let pendingMove = null;
let moveInFlight = false;

const config = loadConfig();
if (process.env.SS_RELAY_URL) {
  config.relayUrl = process.env.SS_RELAY_URL;
}

function log(...args) {
  ensureAppDir();
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    /* ignore */
  }
  if (process.env.SS_FOREGROUND === '1') {
    console.log(...args);
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

const KEY_MAP = {
  Backspace: Key.Backspace,
  Tab: Key.Tab,
  Enter: Key.Enter,
  Escape: Key.Escape,
  Space: Key.Space,
  ' ': Key.Space,
  ArrowLeft: Key.Left,
  ArrowUp: Key.Up,
  ArrowRight: Key.Right,
  ArrowDown: Key.Down,
  Delete: Key.Delete,
  Home: Key.Home,
  End: Key.End,
  PageUp: Key.PageUp,
  PageDown: Key.PageDown,
  Insert: Key.Insert,
  Shift: Key.LeftShift,
  Control: Key.LeftControl,
  Alt: Key.LeftAlt,
  Meta: Key.LeftSuper,
  CapsLock: Key.CapsLock,
  F1: Key.F1,
  F2: Key.F2,
  F3: Key.F3,
  F4: Key.F4,
  F5: Key.F5,
  F6: Key.F6,
  F7: Key.F7,
  F8: Key.F8,
  F9: Key.F9,
  F10: Key.F10,
  F11: Key.F11,
  F12: Key.F12,
};

function resolveKey(name, code) {
  if (!name && !code) return null;
  if (KEY_MAP[name]) return KEY_MAP[name];
  if (code) {
    if (code.startsWith('Key') && code.length === 4) {
      const letter = code.slice(3);
      if (Key[letter] !== undefined) return Key[letter];
    }
    if (code.startsWith('Digit') && code.length === 6) {
      const d = code.slice(5);
      if (Key[`Num${d}`] !== undefined) return Key[`Num${d}`];
      if (Key[d] !== undefined) return Key[d];
    }
  }
  if (name && name.length === 1) {
    const upper = name.toUpperCase();
    if (Key[upper] !== undefined) return Key[upper];
  }
  return null;
}

async function refreshNativeSize(fromCaptureW, fromCaptureH) {
  try {
    const w = await screen.width();
    const h = await screen.height();
    if (w > 0 && h > 0) {
      nativeSize = { width: w, height: h };
      return;
    }
  } catch {
    /* ignore */
  }
  if (fromCaptureW && fromCaptureH) {
    nativeSize = { width: fromCaptureW, height: fromCaptureH };
  }
}

function toNativeCoords(event) {
  if (typeof event.nx === 'number' && typeof event.ny === 'number') {
    return {
      x: Math.round(clamp(event.nx, 0, 1) * (nativeSize.width - 1)),
      y: Math.round(clamp(event.ny, 0, 1) * (nativeSize.height - 1)),
    };
  }
  const scaleX = nativeSize.width / Math.max(1, screenMeta.width);
  const scaleY = nativeSize.height / Math.max(1, screenMeta.height);
  return {
    x: Math.round(clamp(event.x || 0, 0, screenMeta.width) * scaleX),
    y: Math.round(clamp(event.y || 0, 0, screenMeta.height) * scaleY),
  };
}

async function flushMouseMove() {
  if (moveInFlight || !pendingMove) return;
  moveInFlight = true;
  const next = pendingMove;
  pendingMove = null;
  try {
    noteRemoteInject();
    await mouse.setPosition(new Point(next.x, next.y));
    noteRemoteInject();
  } catch (err) {
    log('move error:', err.message);
  } finally {
    moveInFlight = false;
    if (pendingMove) {
      setImmediate(() => {
        flushMouseMove().catch(() => {});
      });
    }
  }
}

function isInputEnabled() {
  return !manualLock && !hostBusy;
}

function inputStateMessage() {
  if (manualLock) return 'Keyboard and Mouse disabled';
  if (hostBusy) return 'Host is using this PC';
  return 'Keyboard and Mouse enabled';
}

function inputStateReason() {
  if (manualLock) return 'manual';
  if (hostBusy) return 'host';
  return 'enabled';
}

function broadcastInputState(force = false) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const enabled = isInputEnabled();
  const reason = inputStateReason();
  const message = inputStateMessage();
  if (
    !force &&
    enabled === lastBroadcastEnabled &&
    reason === lastBroadcastReason
  ) {
    return;
  }
  lastBroadcastEnabled = enabled;
  lastBroadcastReason = reason;
  ws.send(
    encodeMessage(MessageType.INPUT_STATE, {
      enabled,
      reason,
      message,
    })
  );
  log(`remote input ${enabled ? 'ENABLED' : 'DISABLED'} (${reason})`);
}

function syncInputGate() {
  if (!isInputEnabled()) {
    pendingMove = null;
  }
  broadcastInputState();
}

function setManualLock(locked) {
  manualLock = !!locked;
  syncInputGate();
}

/** Remote injection is often not marked INJECTED by Windows — ignore echo as "host". */
function noteRemoteInject() {
  const pad = Math.max(400, Number(config.hostInjectGraceMs) || 700);
  suppressHostUntil = Date.now() + pad;
}

function onHostPhysicalActivity() {
  // Ignore activity that is just our own remote mouse/keyboard echoing back
  if (Date.now() < suppressHostUntil) return;

  const wasBusy = hostBusy;
  hostBusy = true;
  if (hostIdleTimer) clearTimeout(hostIdleTimer);
  const idleMs = Math.max(500, Number(config.hostPriorityMs) || 2000);
  hostIdleTimer = setTimeout(() => {
    hostIdleTimer = null;
    // Don't re-enable during an active remote inject window
    if (Date.now() < suppressHostUntil) {
      hostIdleTimer = setTimeout(() => {
        hostIdleTimer = null;
        if (Date.now() >= suppressHostUntil) {
          hostBusy = false;
          syncInputGate();
        }
      }, suppressHostUntil - Date.now() + 50);
      return;
    }
    hostBusy = false;
    syncInputGate();
  }, idleMs);

  if (!wasBusy) {
    syncInputGate();
  }
}

function setupHotkeys() {
  if (stopHotkeys) {
    try {
      stopHotkeys();
    } catch {
      /* ignore */
    }
    stopHotkeys = null;
  }

  const lockSpec = config.lockInputShortcut || 'Ctrl+Alt+L';
  const unlockSpec = config.unlockInputShortcut || 'Ctrl+Alt+U';

  try {
    stopHotkeys = startHostHotkeys({
      lockSpec,
      unlockSpec,
      onLock: () => setManualLock(true),
      onUnlock: () => setManualLock(false),
      onHostActivity: () => onHostPhysicalActivity(),
      log,
    });
  } catch (err) {
    log('hotkeys setup failed (agent continues):', err.message);
    stopHotkeys = null;
  }
}

let typingBusy = false;

async function applyInput(event) {
  if (!isInputEnabled()) return;
  noteRemoteInject();
  try {
    if (event.action === 'type-text') {
      if (typingBusy) return;
      typingBusy = true;
      try {
        const raw = String(event.text || '');
        const text = raw.length > 100000 ? raw.slice(0, 100000) : raw;
        const delayMs = Math.max(0, Math.min(200, Number(event.delayMs) || 25));
        const approxMs = Math.max(1000, text.length * (delayMs + 10));
        suppressHostUntil = Date.now() + approxMs + 800;
        await typeMimic(
          text,
          { delayMs, tabWidth: event.tabWidth || 4 },
          log
        );
        noteRemoteInject();
      } finally {
        typingBusy = false;
      }
      return;
    }

    if (event.action === 'mousemove') {
      pendingMove = toNativeCoords(event);
      flushMouseMove().catch(() => {});
      return;
    }

    if (event.action === 'mousedown' || event.action === 'mouseup') {
      const { x, y } = toNativeCoords(event);
      pendingMove = null;
      noteRemoteInject();
      await mouse.setPosition(new Point(x, y));
      const btn =
        event.button === 2
          ? Button.RIGHT
          : event.button === 1
            ? Button.MIDDLE
            : Button.LEFT;
      noteRemoteInject();
      if (event.action === 'mousedown') await mouse.pressButton(btn);
      else await mouse.releaseButton(btn);
      noteRemoteInject();
      return;
    }

    if (event.action === 'scroll') {
      noteRemoteInject();
      const amount = Math.max(1, Math.round(Math.abs(event.dy || event.deltaY || 1) / 40));
      if ((event.dy || event.deltaY || 0) < 0) await mouse.scrollUp(amount);
      else await mouse.scrollDown(amount);
      noteRemoteInject();
      return;
    }

    if (event.action === 'paste-text') {
      noteRemoteInject();
      await applyClipboardText(event.text || '');
      await keyboard.pressKey(Key.LeftControl);
      await keyboard.pressKey(Key.V);
      await keyboard.releaseKey(Key.V);
      await keyboard.releaseKey(Key.LeftControl);
      noteRemoteInject();
      return;
    }

    if (event.action === 'keydown' || event.action === 'keyup') {
      const key = resolveKey(event.key, event.code);
      noteRemoteInject();
      if (!key) {
        if (event.action === 'keydown' && event.key && event.key.length === 1) {
          await keyboard.type(event.key);
        }
        noteRemoteInject();
        return;
      }
      if (event.action === 'keydown') await keyboard.pressKey(key);
      else await keyboard.releaseKey(key);
      noteRemoteInject();
    }
  } catch (err) {
    log('input error:', err.message);
  }
}

async function applyClipboardText(text) {
  if (typeof text !== 'string') return;
  applyingClipboard = true;
  lastClipboardApplied = text;
  lastClipboardSent = text;
  try {
    const clip = getClipboard();
    await clip.write(text);
  } catch (err) {
    log('clipboard write error:', err.message);
  } finally {
    setTimeout(() => {
      applyingClipboard = false;
    }, 400);
  }
}

function sendClipboardToController(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !controllerConnected) return;
  if (text === lastClipboardSent) return;
  lastClipboardSent = text;
  ws.send(
    encodeMessage(MessageType.CLIPBOARD, {
      text,
      from: Role.HOST,
    })
  );
}

async function pollClipboard() {
  if (!controllerConnected || applyingClipboard) return;
  try {
    const clip = getClipboard();
    const text = await clip.read();
    if (typeof text === 'string' && text.length > 0 && text !== lastClipboardSent) {
      // Cap size to keep tunnel happy
      const payload = text.length > 200000 ? text.slice(0, 200000) : text;
      sendClipboardToController(payload);
    }
  } catch {
    /* ignore empty / locked clipboard */
  }
}

let pendingFramePacket = null;
const SEND_BUFFER_LIMIT = 400_000; // ~400KB — keep Tailscale/WS from stalling

function trySendFramePacket(packet) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > SEND_BUFFER_LIMIT) {
    pendingFramePacket = packet; // keep only newest
    return false;
  }
  try {
    ws.send(packet);
    pendingFramePacket = null;
    return true;
  } catch (err) {
    log('frame send error:', err.message);
    return false;
  }
}

function flushPendingFrame() {
  if (!pendingFramePacket) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > SEND_BUFFER_LIMIT / 2) return;
  try {
    ws.send(pendingFramePacket);
    pendingFramePacket = null;
  } catch (err) {
    log('frame flush error:', err.message);
  }
}

async function captureAndSend() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !controllerConnected || capturing) {
    flushPendingFrame();
    return;
  }
  // If send buffer is full, don't capture more — just try to flush latest pending
  if (ws.bufferedAmount > SEND_BUFFER_LIMIT) {
    flushPendingFrame();
    return;
  }

  capturing = true;
  try {
    const img = await screenshot({ format: 'jpg' });
    const meta = await sharp(img).metadata();
    const srcW = meta.width || nativeSize.width;
    const srcH = meta.height || nativeSize.height;

    const maxW = config.maxWidth || 1280;
    const scale = srcW > maxW ? srcW / maxW : 1;
    const outW = Math.round(srcW / scale);
    const outH = Math.round(srcH / scale);

    screenMeta = { width: outW, height: outH, scale };

    const jpeg = await sharp(img)
      .resize(outW, outH, { fit: 'fill' })
      .jpeg({ quality: config.quality || 55, mozjpeg: true })
      .toBuffer();

    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const packet = encodeFrameBinary(outW, outH, jpeg);
    trySendFramePacket(packet);
  } catch (err) {
    log('capture error:', err.message);
  } finally {
    capturing = false;
    flushPendingFrame();
  }
}

function startCaptureLoop() {
  stopCaptureLoop();
  const interval = Math.max(50, Math.round(1000 / (config.fps || 10)));
  captureTimer = setInterval(() => {
    captureAndSend().catch(() => {});
  }, interval);
  clipboardTimer = setInterval(() => {
    pollClipboard().catch(() => {});
  }, 500);
  flushPendingFrame._timer = setInterval(flushPendingFrame, 100);
}

function stopCaptureLoop() {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }
  if (flushPendingFrame._timer) {
    clearInterval(flushPendingFrame._timer);
    flushPendingFrame._timer = null;
  }
  if (clipboardTimer) {
    clearInterval(clipboardTimer);
    clipboardTimer = null;
  }
  pendingFramePacket = null;
}

function connect() {
  const url = config.relayUrl;
  log('connecting to relay', url);

  ws = new WebSocket(url);

  ws.on('open', () => {
    log('connected to relay');
    ws.send(
      encodeMessage(MessageType.REGISTER, {
        role: Role.HOST,
        pairCode: config.pairCode,
      })
    );
  });

  ws.on('message', async (raw) => {
    const msg = decodeMessage(raw);
    if (!msg) return;

    if (msg.type === MessageType.REGISTERED) {
      log('registered as host, pairCode=', config.pairCode);
      await refreshNativeSize();
      ws.send(
        encodeMessage(MessageType.SCREEN_INFO, {
          width: screenMeta.width,
          height: screenMeta.height,
          scale: screenMeta.scale,
          nativeWidth: nativeSize.width,
          nativeHeight: nativeSize.height,
        })
      );
    }

    if (msg.type === MessageType.PEER_JOINED && msg.role === Role.CONTROLLER) {
      log('controller connected — sharing screen');
      controllerConnected = true;
      startCaptureLoop();
      broadcastInputState(true);
    }

    if (msg.type === MessageType.PEER_LEFT && msg.role === Role.CONTROLLER) {
      log('controller disconnected — waiting');
      controllerConnected = false;
      stopCaptureLoop();
    }

    if (msg.type === MessageType.INPUT && msg.event) {
      if (!isInputEnabled()) return;
      await applyInput(msg.event);
    }

    if (msg.type === MessageType.CLIPBOARD && msg.from === Role.CONTROLLER) {
      if (!isInputEnabled()) return;
      await applyClipboardText(msg.text || '');
    }
  });

  ws.on('close', () => {
    log('relay connection closed — reconnecting');
    controllerConnected = false;
    stopCaptureLoop();
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    log('ws error:', err.message);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function shutdown() {
  stopCaptureLoop();
  if (hostIdleTimer) {
    clearTimeout(hostIdleTimer);
    hostIdleTimer = null;
  }
  if (stopHotkeys) {
    try {
      stopHotkeys();
    } catch {
      /* ignore */
    }
    stopHotkeys = null;
  }
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

refreshNativeSize()
  .then(() => {
    log('agent starting', `screen=${nativeSize.width}x${nativeSize.height}`);
    setupHotkeys();
    connect();
  })
  .catch(() => {
    log('agent starting');
    setupHotkeys();
    connect();
  });

setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(encodeMessage(MessageType.PING));
  }
}, 15000);
