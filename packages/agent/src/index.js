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
  LOG_PATH,
  ensureAppDir,
} = require('@ss-remote/shared');
const fs = require('fs');
const { startHostHotkeys } = require('./hotkeys');

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
let inputEnabled = true; // remote mouse/keyboard allowed
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
  if (code && KEY_MAP[code.replace(/^Key/, '').replace(/^Digit/, '')]) {
    /* fall through */
  }
  if (!name && !code) return null;
  if (KEY_MAP[name]) return KEY_MAP[name];
  // Prefer e.code style (KeyA, Digit1) for layout-independent mapping
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
    await mouse.setPosition(new Point(next.x, next.y));
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

function broadcastInputState() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    encodeMessage(MessageType.INPUT_STATE, {
      enabled: inputEnabled,
      message: inputEnabled
        ? 'Keyboard and Mouse enabled'
        : 'Keyboard and Mouse disabled',
    })
  );
  log(inputEnabled ? 'remote input ENABLED' : 'remote input DISABLED');
}

function setInputEnabled(enabled) {
  if (inputEnabled === enabled) {
    broadcastInputState();
    return;
  }
  inputEnabled = enabled;
  pendingMove = null;
  broadcastInputState();
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
  log(`host hotkeys: lock=${lockSpec} unlock=${unlockSpec}`);

  stopHotkeys = startHostHotkeys({
    lockSpec,
    unlockSpec,
    onLock: () => setInputEnabled(false),
    onUnlock: () => setInputEnabled(true),
    log,
  });
}

async function applyInput(event) {
  if (!inputEnabled) return;
  try {
    if (event.action === 'mousemove') {
      pendingMove = toNativeCoords(event);
      flushMouseMove().catch(() => {});
      return;
    }

    if (event.action === 'mousedown' || event.action === 'mouseup') {
      const { x, y } = toNativeCoords(event);
      pendingMove = null;
      await mouse.setPosition(new Point(x, y));
      const btn =
        event.button === 2
          ? Button.RIGHT
          : event.button === 1
            ? Button.MIDDLE
            : Button.LEFT;
      if (event.action === 'mousedown') await mouse.pressButton(btn);
      else await mouse.releaseButton(btn);
      return;
    }

    if (event.action === 'scroll') {
      const amount = Math.max(1, Math.round(Math.abs(event.dy || event.deltaY || 1) / 40));
      if ((event.dy || event.deltaY || 0) < 0) await mouse.scrollUp(amount);
      else await mouse.scrollDown(amount);
      return;
    }

    if (event.action === 'paste-text') {
      await applyClipboardText(event.text || '');
      // Inject Ctrl+V so the focused app receives paste
      await keyboard.pressKey(Key.LeftControl);
      await keyboard.pressKey(Key.V);
      await keyboard.releaseKey(Key.V);
      await keyboard.releaseKey(Key.LeftControl);
      return;
    }

    if (event.action === 'keydown' || event.action === 'keyup') {
      const key = resolveKey(event.key, event.code);
      if (!key) {
        if (event.action === 'keydown' && event.key && event.key.length === 1) {
          await keyboard.type(event.key);
        }
        return;
      }
      if (event.action === 'keydown') await keyboard.pressKey(key);
      else await keyboard.releaseKey(key);
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

async function captureAndSend() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !controllerConnected || capturing) {
    return;
  }
  // If the tunnel is backed up, skip this capture so latency does not snowball
  if (ws.bufferedAmount > 1_500_000) {
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

    // Drop if backlog appeared while we were encoding
    if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1_500_000) {
      return;
    }

    ws.send(
      encodeMessage(MessageType.FRAME, {
        width: outW,
        height: outH,
        scale,
        nativeWidth: nativeSize.width,
        nativeHeight: nativeSize.height,
        data: jpeg.toString('base64'),
      })
    );
  } catch (err) {
    log('capture error:', err.message);
  } finally {
    capturing = false;
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
}

function stopCaptureLoop() {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }
  if (clipboardTimer) {
    clearInterval(clipboardTimer);
    clipboardTimer = null;
  }
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
      broadcastInputState();
    }

    if (msg.type === MessageType.PEER_LEFT && msg.role === Role.CONTROLLER) {
      log('controller disconnected — waiting');
      controllerConnected = false;
      stopCaptureLoop();
    }

    if (msg.type === MessageType.INPUT && msg.event) {
      if (!inputEnabled) return;
      await applyInput(msg.event);
    }

    if (msg.type === MessageType.CLIPBOARD && msg.from === Role.CONTROLLER) {
      if (!inputEnabled) return;
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
