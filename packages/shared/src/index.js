const os = require('os');
const path = require('path');
const fs = require('fs');

const APP_DIR = path.join(os.homedir(), '.ss-remote');
const CONFIG_PATH = path.join(APP_DIR, 'config.json');
const PID_PATH = path.join(APP_DIR, 'agent.pid');
const RELAY_PID_PATH = path.join(APP_DIR, 'relay.pid');
const TUNNEL_PID_PATH = path.join(APP_DIR, 'tunnel.pid');
const CONNECTION_PATH = path.join(APP_DIR, 'connection.json');
const LOG_PATH = path.join(APP_DIR, 'agent.log');

const MessageType = {
  REGISTER: 'register',
  REGISTERED: 'registered',
  PEER_JOINED: 'peer_joined',
  PEER_LEFT: 'peer_left',
  FRAME: 'frame',
  INPUT: 'input',
  SCREEN_INFO: 'screen_info',
  CLIPBOARD: 'clipboard',
  INPUT_STATE: 'input_state',
  ERROR: 'error',
  PING: 'ping',
  PONG: 'pong',
};

const Role = {
  HOST: 'host',
  CONTROLLER: 'controller',
};

const DEFAULT_CONFIG = {
  relayUrl: 'ws://127.0.0.1:9000',
  pairCode: 'ss-home',
  quality: 55,
  fps: 10,
  maxWidth: 1280,
  relayPort: 9000,
  // Host-side global shortcuts (sender PC)
  lockInputShortcut: 'Ctrl+Alt+L',
  unlockInputShortcut: 'Ctrl+Alt+U',
  // After host stops using mouse/keyboard, wait this many ms before giving control back
  hostPriorityMs: 2000,
  // Ignore brief host-activity echoes after remote click/key inject (not mouse-move)
  hostInjectGraceMs: 450,
};

function ensureAppDir() {
  if (!fs.existsSync(APP_DIR)) {
    fs.mkdirSync(APP_DIR, { recursive: true });
  }
}

function loadConfig() {
  ensureAppDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(partial) {
  ensureAppDir();
  const next = { ...loadConfig(), ...partial };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

/** Binary screen frame: magic(1) + width(u16 BE) + height(u16 BE) + jpeg bytes */
const FRAME_BIN_MAGIC = 0x01;

function encodeMessage(type, payload = {}) {
  return JSON.stringify({ type, ...payload, t: Date.now() });
}

function decodeMessage(data) {
  try {
    if (Buffer.isBuffer(data) && data.length > 0 && data[0] === FRAME_BIN_MAGIC) {
      return null; // binary frame — use decodeFrameBinary
    }
    return JSON.parse(typeof data === 'string' ? data : data.toString());
  } catch {
    return null;
  }
}

function isBinaryFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return buf.length >= 5 && buf[0] === FRAME_BIN_MAGIC;
}

function encodeFrameBinary(width, height, jpegBuffer) {
  const w = Math.max(0, Math.min(65535, width | 0));
  const h = Math.max(0, Math.min(65535, height | 0));
  const header = Buffer.allocUnsafe(5);
  header[0] = FRAME_BIN_MAGIC;
  header.writeUInt16BE(w, 1);
  header.writeUInt16BE(h, 3);
  return Buffer.concat([header, jpegBuffer]);
}

function decodeFrameBinary(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 5 || buf[0] !== FRAME_BIN_MAGIC) return null;
  return {
    width: buf.readUInt16BE(1),
    height: buf.readUInt16BE(3),
    jpeg: buf.subarray(5),
  };
}

module.exports = {
  APP_DIR,
  CONFIG_PATH,
  PID_PATH,
  RELAY_PID_PATH,
  TUNNEL_PID_PATH,
  CONNECTION_PATH,
  LOG_PATH,
  MessageType,
  Role,
  DEFAULT_CONFIG,
  FRAME_BIN_MAGIC,
  ensureAppDir,
  loadConfig,
  saveConfig,
  encodeMessage,
  decodeMessage,
  isBinaryFrame,
  encodeFrameBinary,
  decodeFrameBinary,
};
