const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const {
  loadConfig,
  MessageType,
  Role,
  encodeMessage,
  decodeMessage,
  isBinaryFrame,
  decodeFrameBinary,
} = require('@ss-remote/shared');

let mainWindow = null;
let ws = null;
let reconnectTimer = null;
let clipboardTimer = null;
let lastClipboardSent = '';
let lastClipboardApplied = '';
let applyingClipboard = false;
let latestFrame = null;
let frameFlushScheduled = false;
const config = loadConfig();

/**
 * Single source of truth for header status + lock labels.
 * Renderer only displays what we push — it must not invent connection state.
 */
const session = {
  // connecting | connected | disconnected | error
  connection: 'connecting',
  hostPresent: false,
  inputEnabled: true,
  inputReason: 'enabled',
  inputMessage: 'Keyboard and Mouse enabled',
  pairCode: config.pairCode || '',
  relayUrl: config.relayUrl || '',
  errorMessage: '',
};

function deriveStatusPayload() {
  const base = {
    pairCode: session.pairCode,
    relayUrl: session.relayUrl,
    hostPresent: session.hostPresent,
    inputEnabled: session.inputEnabled,
    inputReason: session.inputReason,
    inputMessage: session.inputMessage,
  };

  if (session.connection === 'error') {
    return {
      ...base,
      state: 'error',
      message: session.errorMessage || `Cannot reach relay at ${session.relayUrl}`,
    };
  }
  if (session.connection === 'disconnected') {
    return {
      ...base,
      state: 'disconnected',
      message: 'Relay disconnected',
    };
  }
  if (session.connection === 'connecting') {
    return {
      ...base,
      state: 'connecting',
      message: 'Connecting to relay…',
    };
  }

  // Connected to relay
  if (!session.hostPresent) {
    return {
      ...base,
      state: 'connected',
      message: 'Connected — waiting for host…',
    };
  }

  if (!session.inputEnabled) {
    return {
      ...base,
      state: 'locked',
      message: session.inputMessage || (
        session.inputReason === 'host'
          ? 'Host is using this PC'
          : 'Keyboard & Mouse disabled'
      ),
    };
  }

  return {
    ...base,
    state: 'ready',
    message: 'Live — you have full control',
  };
}

function pushSession() {
  const status = deriveStatusPayload();
  sendToRenderer('session', status);
  // Keep legacy channels for compatibility
  sendToRenderer('status', status);
  sendToRenderer('input-state', {
    enabled: session.inputEnabled,
    reason: session.inputReason,
    message: session.inputMessage,
  });

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!session.inputEnabled && session.hostPresent && session.connection === 'connected') {
      mainWindow.setTitle(`SS Remote — ${status.message}`);
    } else if (session.hostPresent && session.connection === 'connected') {
      mainWindow.setTitle('SS Remote — Live');
    } else {
      mainWindow.setTitle('SS Remote — Controller');
    }
  }
}

function setConnection(connection, errorMessage = '') {
  session.connection = connection;
  session.errorMessage = errorMessage || '';
  if (connection === 'disconnected' || connection === 'error' || connection === 'connecting') {
    session.hostPresent = false;
  }
  pushSession();
}

function setHostPresent(present) {
  session.hostPresent = !!present;
  if (!present) {
    session.inputEnabled = true;
    session.inputReason = 'enabled';
    session.inputMessage = 'Keyboard and Mouse enabled';
  }
  pushSession();
}

function applyInputState(msg) {
  const enabled = msg.enabled !== false && msg.enabled !== 'false';
  session.inputEnabled = enabled;
  session.inputReason = msg.reason || (enabled ? 'enabled' : 'manual');
  session.inputMessage =
    msg.message ||
    (enabled
      ? 'Keyboard and Mouse enabled'
      : session.inputReason === 'host'
        ? 'Host is using this PC'
        : 'Keyboard and Mouse disabled');
  pushSession();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'SS Remote — Controller',
    backgroundColor: '#0f1218',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    // Replay authoritative session — never hardcode "waiting for host"
    pushSession();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function flushLatestFrame() {
  frameFlushScheduled = false;
  if (!latestFrame) return;
  const frame = latestFrame;
  latestFrame = null;
  // Frames prove the host is sharing — promote out of "waiting"
  if (!session.hostPresent && session.connection === 'connected') {
    session.hostPresent = true;
    pushSession();
  }
  sendToRenderer('frame', frame);
}

function queueFrameToRenderer(frame) {
  latestFrame = frame;
  if (!frameFlushScheduled) {
    frameFlushScheduled = true;
    setImmediate(flushLatestFrame);
  }
}

function applyRemoteClipboard(text) {
  if (typeof text !== 'string') return;
  applyingClipboard = true;
  lastClipboardApplied = text;
  lastClipboardSent = text;
  try {
    clipboard.writeText(text);
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    applyingClipboard = false;
  }, 400);
}

function pollLocalClipboard() {
  if (!ws || ws.readyState !== WebSocket.OPEN || applyingClipboard) return;
  try {
    const text = clipboard.readText();
    if (!text || text === lastClipboardSent) return;
    const payload = text.length > 200000 ? text.slice(0, 200000) : text;
    lastClipboardSent = payload;
    ws.send(
      encodeMessage(MessageType.CLIPBOARD, {
        text: payload,
        from: Role.CONTROLLER,
      })
    );
  } catch {
    /* ignore */
  }
}

function startClipboardSync() {
  stopClipboardSync();
  clipboardTimer = setInterval(pollLocalClipboard, 500);
}

function stopClipboardSync() {
  if (clipboardTimer) {
    clearInterval(clipboardTimer);
    clipboardTimer = null;
  }
}

function connectRelay() {
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.close();
    } catch {
      /* ignore */
    }
  }

  session.pairCode = config.pairCode || '';
  session.relayUrl = config.relayUrl || '';
  setConnection('connecting');

  ws = new WebSocket(config.relayUrl);

  ws.on('open', () => {
    ws.send(
      encodeMessage(MessageType.REGISTER, {
        role: Role.CONTROLLER,
        pairCode: config.pairCode,
      })
    );
    session.connection = 'connected';
    session.hostPresent = false;
    session.errorMessage = '';
    pushSession();
    startClipboardSync();
  });

  ws.on('message', (raw, isBinary) => {
    if (isBinary || isBinaryFrame(raw)) {
      const frame = decodeFrameBinary(raw);
      if (!frame || !frame.jpeg || frame.jpeg.length < 2) return;
      queueFrameToRenderer({
        width: frame.width,
        height: frame.height,
        jpeg: Buffer.from(frame.jpeg),
      });
      return;
    }

    const msg = decodeMessage(raw);
    if (!msg) return;

    if (msg.type === MessageType.PEER_JOINED && msg.role === Role.HOST) {
      setHostPresent(true);
    }

    if (msg.type === MessageType.PEER_LEFT && msg.role === Role.HOST) {
      latestFrame = null;
      setHostPresent(false);
      sendToRenderer('frame', null);
    }

    if (msg.type === MessageType.FRAME) {
      queueFrameToRenderer({
        width: msg.width,
        height: msg.height,
        scale: msg.scale,
        nativeWidth: msg.nativeWidth,
        nativeHeight: msg.nativeHeight,
        data: msg.data,
      });
    }

    if (msg.type === MessageType.SCREEN_INFO) {
      if (!session.hostPresent) setHostPresent(true);
      sendToRenderer('screen-info', msg);
    }

    if (msg.type === MessageType.CLIPBOARD && msg.from === Role.HOST) {
      applyRemoteClipboard(msg.text || '');
      sendToRenderer('clipboard', { text: msg.text || '', from: 'host' });
    }

    if (msg.type === MessageType.INPUT_STATE || msg.type === 'input_state') {
      applyInputState(msg);
    }

    if (msg.type === MessageType.ERROR) {
      setConnection('error', msg.error || 'Error');
    }
  });

  ws.on('close', () => {
    stopClipboardSync();
    session.inputEnabled = true;
    session.inputReason = 'enabled';
    session.inputMessage = 'Keyboard and Mouse enabled';
    setConnection('disconnected');
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectRelay();
      }, 2000);
    }
  });

  ws.on('error', () => {
    setConnection('error', `Cannot reach relay at ${config.relayUrl}`);
  });
}

ipcMain.on('input', (_event, inputEvent) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!session.inputEnabled) return;
  ws.send(encodeMessage(MessageType.INPUT, { event: inputEvent }));
});

ipcMain.on('clipboard-to-host', (_event, text) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!session.inputEnabled) return;
  if (typeof text !== 'string') return;
  const payload = text.length > 200000 ? text.slice(0, 200000) : text;
  lastClipboardSent = payload;
  ws.send(
    encodeMessage(MessageType.CLIPBOARD, {
      text: payload,
      from: Role.CONTROLLER,
    })
  );
});

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('get-session', () => deriveStatusPayload());
ipcMain.handle('get-input-state', () => ({
  enabled: session.inputEnabled,
  reason: session.inputReason,
  message: session.inputMessage,
}));
ipcMain.handle('read-clipboard', () => {
  try {
    return clipboard.readText();
  } catch {
    return '';
  }
});
ipcMain.handle('write-clipboard', (_e, text) => {
  applyRemoteClipboard(typeof text === 'string' ? text : '');
  return true;
});

app.whenReady().then(() => {
  createWindow();
  connectRelay();
});

app.on('window-all-closed', () => {
  stopClipboardSync();
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
