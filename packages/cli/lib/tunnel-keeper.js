#!/usr/bin/env node
/**
 * Keeps a localtunnel open after `ss start all` exits.
 * Usage: node tunnel-keeper.js <port>
 */
const fs = require('fs');
const localtunnel = require('localtunnel');
const {
  ensureAppDir,
  LOG_PATH,
  TUNNEL_PID_PATH,
  CONNECTION_PATH,
} = require('@ss-remote/shared');

const port = Number(process.argv[2] || 9000);

function toWsUrl(httpsUrl) {
  return httpsUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:').replace(/\/$/, '');
}

function log(msg) {
  ensureAppDir();
  try {
    fs.appendFileSync(LOG_PATH, `[tunnel] ${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

async function open() {
  ensureAppDir();
  fs.writeFileSync(TUNNEL_PID_PATH, String(process.pid));

  const tunnel = await localtunnel({ port });
  const httpsUrl = tunnel.url;
  const info = {
    publicWsUrl: toWsUrl(httpsUrl),
    httpsUrl,
    localPort: port,
    pid: process.pid,
    provider: 'localtunnel',
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(CONNECTION_PATH, JSON.stringify(info, null, 2));
  log(`localtunnel ready ${httpsUrl}`);

  tunnel.on('close', () => {
    log('localtunnel closed — exiting');
    process.exit(0);
  });
  tunnel.on('error', (err) => {
    log(`localtunnel error: ${err.message}`);
  });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

open().catch((err) => {
  log(`failed: ${err.message}`);
  process.exit(1);
});

// stay alive
setInterval(() => {}, 60_000);
