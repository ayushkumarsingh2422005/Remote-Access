const { app, BrowserWindow, ipcMain } = require('electron');
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
      sendToRenderer('status', {
        state: 'waiting',
        message: 'Host disconnected — waiting…',
      });
      sendToRenderer('frame', null);
    }

    if (msg.type === MessageType.FRAME) {
      sendToRenderer('frame', {
        width: msg.width,
        height: msg.height,
        scale: msg.scale,
        data: msg.data,
      });
    }

    if (msg.type === MessageType.SCREEN_INFO) {
      sendToRenderer('screen-info', msg);
    }

    if (msg.type === MessageType.ERROR) {
      sendToRenderer('status', { state: 'error', message: msg.error });
    }
  });

  ws.on('close', () => {
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

ipcMain.handle('get-config', () => loadConfig());

app.whenReady().then(() => {
  createWindow();
  connectRelay();
});

app.on('window-all-closed', () => {
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
