const screenshot = require('screenshot-desktop');
const sharp = require('sharp');
const WebSocket = require('ws');
const {
  mouse,
  keyboard,
  Button,
  Key,
  Point,
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

mouse.config.autoDelayMs = 0;
keyboard.config.autoDelayMs = 0;

let ws = null;
let captureTimer = null;
let reconnectTimer = null;
let screenMeta = { width: 1920, height: 1080, scale: 1 };
let capturing = false;
let controllerConnected = false;
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

function resolveKey(name) {
  if (!name) return null;
  if (KEY_MAP[name]) return KEY_MAP[name];
  if (name.length === 1) {
    const upper = name.toUpperCase();
    if (Key[upper] !== undefined) return Key[upper];
  }
  return null;
}

async function applyInput(event) {
  try {
    if (event.action === 'mousemove') {
      const x = Math.round(event.x * screenMeta.scale);
      const y = Math.round(event.y * screenMeta.scale);
      await mouse.setPosition(new Point(x, y));
      return;
    }

    if (event.action === 'mousedown' || event.action === 'mouseup') {
      const x = Math.round(event.x * screenMeta.scale);
      const y = Math.round(event.y * screenMeta.scale);
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

    if (event.action === 'click') {
      const x = Math.round(event.x * screenMeta.scale);
      const y = Math.round(event.y * screenMeta.scale);
      await mouse.setPosition(new Point(x, y));
      const btn =
        event.button === 2
          ? Button.RIGHT
          : event.button === 1
            ? Button.MIDDLE
            : Button.LEFT;
      await mouse.click(btn);
      return;
    }

    if (event.action === 'scroll') {
      const amount = Math.max(1, Math.round(Math.abs(event.dy || event.deltaY || 1) / 40));
      if ((event.dy || event.deltaY || 0) < 0) await mouse.scrollUp(amount);
      else await mouse.scrollDown(amount);
      return;
    }

    if (event.action === 'keydown' || event.action === 'keyup') {
      const key = resolveKey(event.key);
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

async function captureAndSend() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !controllerConnected || capturing) {
    return;
  }
  capturing = true;
  try {
    const img = await screenshot({ format: 'jpg' });
    const meta = await sharp(img).metadata();
    const srcW = meta.width || 1920;
    const srcH = meta.height || 1080;
    const maxW = config.maxWidth || 1280;
    const scale = srcW > maxW ? srcW / maxW : 1;
    const outW = Math.round(srcW / scale);
    const outH = Math.round(srcH / scale);

    screenMeta = { width: outW, height: outH, scale };

    const jpeg = await sharp(img)
      .resize(outW, outH, { fit: 'inside' })
      .jpeg({ quality: config.quality || 55, mozjpeg: true })
      .toBuffer();

    ws.send(
      encodeMessage(MessageType.FRAME, {
        width: outW,
        height: outH,
        scale,
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
}

function stopCaptureLoop() {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
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
      ws.send(
        encodeMessage(MessageType.SCREEN_INFO, {
          width: screenMeta.width,
          height: screenMeta.height,
          scale: screenMeta.scale,
        })
      );
    }

    if (msg.type === MessageType.PEER_JOINED && msg.role === Role.CONTROLLER) {
      log('controller connected — sharing screen');
      controllerConnected = true;
      startCaptureLoop();
    }

    if (msg.type === MessageType.PEER_LEFT && msg.role === Role.CONTROLLER) {
      log('controller disconnected — waiting');
      controllerConnected = false;
      stopCaptureLoop();
    }

    if (msg.type === MessageType.INPUT && msg.event) {
      await applyInput(msg.event);
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

log('agent starting');
connect();

// Keep process alive
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(encodeMessage(MessageType.PING));
  }
}, 15000);
