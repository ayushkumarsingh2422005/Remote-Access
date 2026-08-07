const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const {
  loadConfig,
  MessageType,
  Role,
  encodeMessage,
  decodeMessage,
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
  sendToRenderer('frame', frame);
}

function queueFrameToRenderer(frame) {
  // Drop older frames — only the newest matters for live desktop
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

  sendToRenderer('status', { state: 'connecting', relayUrl: config.relayUrl });

  ws = new WebSocket(config.relayUrl);

  ws.on('open', () => {
    ws.send(
      encodeMessage(MessageType.REGISTER, {
        role: Role.CONTROLLER,
        pairCode: config.pairCode,
      })
    );
    sendToRenderer('status', {
      state: 'connected',
      relayUrl: config.relayUrl,
      pairCode: config.pairCode,
    });
    startClipboardSync();
  });

  ws.on('message', (raw) => {
    const msg = decodeMessage(raw);
    if (!msg) return;

    if (msg.type === MessageType.PEER_JOINED && msg.role === Role.HOST) {
      sendToRenderer('status', {
        state: 'ready',
        relayUrl: config.relayUrl,
        pairCode: config.pairCode,
        message: 'Host is sharing — live view active',
      });
    }

    if (msg.type === MessageType.PEER_LEFT && msg.role === Role.HOST) {
      latestFrame = null;
      sendToRenderer('status', {
        state: 'waiting',
        message: 'Host disconnected — waiting…',
      });
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
      sendToRenderer('screen-info', msg);
    }

    if (msg.type === MessageType.CLIPBOARD && msg.from === Role.HOST) {
      applyRemoteClipboard(msg.text || '');
      sendToRenderer('clipboard', { text: msg.text || '', from: 'host' });
    }

    if (msg.type === MessageType.INPUT_STATE) {
      sendToRenderer('input-state', {
        enabled: msg.enabled !== false,
        reason: msg.reason || (msg.enabled !== false ? 'enabled' : 'manual'),
        message: msg.message || (
          msg.enabled !== false
            ? 'Keyboard and Mouse enabled'
            : 'Keyboard and Mouse disabled'
        ),
      });
    }

    if (msg.type === MessageType.ERROR) {
      sendToRenderer('status', { state: 'error', message: msg.error });
    }
  });

  ws.on('close', () => {
    stopClipboardSync();
    sendToRenderer('status', { state: 'disconnected', message: 'Relay disconnected' });
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectRelay();
      }, 2000);
    }
  });

  ws.on('error', () => {
    sendToRenderer('status', {
      state: 'error',
      message: `Cannot reach relay at ${config.relayUrl}`,
    });
  });
}

ipcMain.on('input', (_event, inputEvent) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(encodeMessage(MessageType.INPUT, { event: inputEvent }));
});

ipcMain.on('clipboard-to-host', (_event, text) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
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
