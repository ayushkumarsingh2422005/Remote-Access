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

function encodeMessage(type, payload = {}) {
  return JSON.stringify({ type, ...payload, t: Date.now() });
}

function decodeMessage(data) {
  try {
    return JSON.parse(typeof data === 'string' ? data : data.toString());
  } catch {
    return null;
  }
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
  ensureAppDir,
  loadConfig,
  saveConfig,
  encodeMessage,
  decodeMessage,
};
