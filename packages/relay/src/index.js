const http = require('http');
const { WebSocketServer } = require('ws');
const {
  loadConfig,
  MessageType,
  Role,
  encodeMessage,
  decodeMessage,
  isBinaryFrame,
} = require('@ss-remote/shared');

const rooms = new Map();

function getRoom(pairCode) {
  if (!rooms.has(pairCode)) {
    rooms.set(pairCode, { host: null, controller: null });
  }
  return rooms.get(pairCode);
}

function peerOf(room, role) {
  return role === Role.HOST ? room.controller : room.host;
}

function forwardRaw(ws, raw) {
  const { pairCode, role } = ws.meta || {};
  if (!pairCode || !role) return;
  const room = getRoom(pairCode);
  const other = peerOf(room, role);
  if (other && other.readyState === 1) {
    // Keep Buffer as Buffer — never .toString() (breaks binary frames)
    other.send(raw);
  }
}

function startRelay(port) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ss-remote relay ok\n');
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.meta = { pairCode: null, role: null };

    ws.on('message', (raw, isBinary) => {
      // Binary screen frames — forward without JSON parse
      if (isBinary || isBinaryFrame(raw)) {
        forwardRaw(ws, raw);
        return;
      }

      const msg = decodeMessage(raw);
      if (!msg || !msg.type) return;

      if (msg.type === MessageType.PING) {
        ws.send(encodeMessage(MessageType.PONG));
        return;
      }

      if (msg.type === MessageType.REGISTER) {
        const pairCode = String(msg.pairCode || '').trim();
        const role = msg.role === Role.CONTROLLER ? Role.CONTROLLER : Role.HOST;
        if (!pairCode) {
          ws.send(encodeMessage(MessageType.ERROR, { error: 'pairCode required' }));
          return;
        }

        const room = getRoom(pairCode);
        const existing = role === Role.HOST ? room.host : room.controller;
        if (existing && existing !== ws && existing.readyState === 1) {
          try {
            existing.close(4000, 'replaced');
          } catch {
            /* ignore */
          }
        }

        if (role === Role.HOST) room.host = ws;
        else room.controller = ws;

        ws.meta = { pairCode, role };
        ws.send(encodeMessage(MessageType.REGISTERED, { role, pairCode }));

        const other = peerOf(room, role);
        if (other && other.readyState === 1) {
          other.send(encodeMessage(MessageType.PEER_JOINED, { role }));
          ws.send(encodeMessage(MessageType.PEER_JOINED, {
            role: role === Role.HOST ? Role.CONTROLLER : Role.HOST,
          }));
        }
        return;
      }

      // Forward all peer traffic after register (do not whitelist types —
      // older relays that omitted input_state dropped lock/host status).
      if (
        msg.type === MessageType.REGISTERED ||
        msg.type === MessageType.PEER_JOINED ||
        msg.type === MessageType.PEER_LEFT ||
        msg.type === MessageType.PING ||
        msg.type === MessageType.PONG ||
        msg.type === MessageType.ERROR
      ) {
        return;
      }
      forwardRaw(ws, raw);
    });

    ws.on('close', () => {
      const { pairCode, role } = ws.meta || {};
      if (!pairCode || !role) return;
      const room = rooms.get(pairCode);
      if (!room) return;

      if (role === Role.HOST && room.host === ws) room.host = null;
      if (role === Role.CONTROLLER && room.controller === ws) room.controller = null;

      const other = peerOf(room, role);
      if (other && other.readyState === 1) {
        other.send(encodeMessage(MessageType.PEER_LEFT, { role }));
      }

      if (!room.host && !room.controller) rooms.delete(pairCode);
    });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[relay] listening on ws://0.0.0.0:${port}`);
  });

  return server;
}

if (require.main === module) {
  const config = loadConfig();
  const port = Number(process.env.SS_RELAY_PORT || config.relayPort || 9000);
  startRelay(port);
}

module.exports = { startRelay };
