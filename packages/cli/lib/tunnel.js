const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const {
  APP_DIR,
  ensureAppDir,
  LOG_PATH,
  TUNNEL_PID_PATH,
  CONNECTION_PATH,
} = require('@ss-remote/shared');

const BIN_DIR = path.join(APP_DIR, 'bin');

function toWsUrl(httpsUrl) {
  return httpsUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:').replace(/\/$/, '');
}

function writeConnection(info) {
  ensureAppDir();
  fs.writeFileSync(CONNECTION_PATH, JSON.stringify(info, null, 2));
}

function readConnection() {
  try {
    if (!fs.existsSync(CONNECTION_PATH)) return null;
    return JSON.parse(fs.readFileSync(CONNECTION_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function clearConnection() {
  try {
    if (fs.existsSync(CONNECTION_PATH)) fs.unlinkSync(CONNECTION_PATH);
  } catch {
    /* ignore */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function platformAsset() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'win32') {
    return {
      url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
      name: 'cloudflared.exe',
    };
  }
  if (platform === 'darwin') {
    const suffix = arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
    return {
      url: `https://github.com/cloudflare/cloudflared/releases/latest/download/${suffix}`,
      name: 'cloudflared',
      tgz: true,
    };
  }
  const suffix = arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
  return {
    url: `https://github.com/cloudflare/cloudflared/releases/latest/download/${suffix}`,
    name: 'cloudflared',
  };
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const getter = url.startsWith('https') ? https : http;
    const req = getter.get(url, { headers: { 'User-Agent': 'ss-remote' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        download(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    });
    req.on('error', (err) => {
      try {
        fs.unlinkSync(dest);
      } catch {
        /* ignore */
      }
      reject(err);
    });
  });
}

function cloudflaredPath() {
  const asset = platformAsset();
  return path.join(BIN_DIR, asset.name);
}

async function ensureCloudflared() {
  ensureAppDir();
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  const asset = platformAsset();
  const binPath = cloudflaredPath();
  if (fs.existsSync(binPath)) return binPath;

  console.log('Downloading Cloudflare tunnel helper (one-time, free, no account)…');
  const tmp = path.join(BIN_DIR, asset.tgz ? 'cloudflared.tgz' : `${asset.name}.tmp`);
  await download(asset.url, tmp);

  if (asset.tgz) {
    const { execSync } = require('child_process');
    execSync(`tar -xzf "${tmp}" -C "${BIN_DIR}"`, { stdio: 'ignore' });
    fs.unlinkSync(tmp);
  } else {
    fs.renameSync(tmp, binPath);
  }

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(binPath, 0o755);
    } catch {
      /* ignore */
    }
  }

  if (!fs.existsSync(binPath)) {
    throw new Error('Failed to install cloudflared binary');
  }
  console.log('Tunnel helper ready.');
  return binPath;
}

async function startLocalTunnel(localPort) {
  ensureAppDir();
  // Don't orphan a previous tunnel process
  try {
    if (fs.existsSync(TUNNEL_PID_PATH)) {
      const oldPid = Number(fs.readFileSync(TUNNEL_PID_PATH, 'utf8').trim());
      if (oldPid && isPidAlive(oldPid)) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(oldPid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } else {
          try {
            process.kill(oldPid, 'SIGTERM');
          } catch {
            /* ignore */
          }
        }
      }
      try {
        fs.unlinkSync(TUNNEL_PID_PATH);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  const keeper = path.join(__dirname, 'tunnel-keeper.js');
  const out = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [keeper, String(localPort)], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    cwd: path.resolve(__dirname, '..', '..', '..'),
    env: { ...process.env },
  });
  child.unref();
  fs.writeFileSync(TUNNEL_PID_PATH, String(child.pid));

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(400);
    const conn = readConnection();
    if (conn && conn.publicWsUrl && isPidAlive(child.pid)) {
      return conn;
    }
    if (!isPidAlive(child.pid)) {
      throw new Error('localtunnel process exited before publishing a URL');
    }
  }
  throw new Error('Timed out waiting for localtunnel URL');
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startCloudflareTunnel(localPort) {
  const bin = await ensureCloudflared();
  ensureAppDir();

  const logFd = fs.openSync(LOG_PATH, 'a');
  const child = spawn(
    bin,
    ['tunnel', '--url', `http://127.0.0.1:${localPort}`, '--no-autoupdate'],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );

  fs.writeFileSync(TUNNEL_PID_PATH, String(child.pid));

  const httpsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for public tunnel URL (30s)'));
    }, 30000);

    const onData = (chunk) => {
      const text = chunk.toString();
      buf += text;
      try {
        fs.writeSync(logFd, text);
      } catch {
        /* ignore */
      }
      const match = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolve(match[0]);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Tunnel exited early (code ${code})`));
    });
  });

  child.unref();

  const info = {
    publicWsUrl: toWsUrl(httpsUrl),
    httpsUrl,
    localPort,
    pid: child.pid,
    provider: 'cloudflare',
    createdAt: new Date().toISOString(),
  };
  writeConnection(info);
  return info;
}

async function startTailscaleEndpoint(localPort) {
  const { execFileSync } = require('child_process');

  function findTailscaleBin() {
    if (process.platform === 'win32') {
      const candidates = [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Tailscale', 'tailscale.exe'),
      ];
      for (const c of candidates) {
        if (c && fs.existsSync(c)) return c;
      }
    }
    return 'tailscale';
  }

  const bin = findTailscaleBin();
  try {
    execFileSync(bin, ['version'], { stdio: 'ignore', windowsHide: true });
  } catch {
    throw new Error(
      'Tailscale CLI not found. Install Tailscale on this PC: https://tailscale.com/download'
    );
  }

  let ip = '';
  try {
    ip = execFileSync(bin, ['ip', '-4'], {
      encoding: 'utf8',
      windowsHide: true,
    })
      .trim()
      .split(/\s+/)[0];
  } catch {
    throw new Error(
      'Tailscale is installed but not connected. Open the Tailscale app and log in, then retry.'
    );
  }

  if (!ip || !/^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    throw new Error(
      `Could not read a Tailscale IPv4 address (got "${ip || 'empty'}"). Is Tailscale connected?`
    );
  }

  // No cloud tunnel process — clear any previous tunnel pid
  try {
    if (fs.existsSync(TUNNEL_PID_PATH)) fs.unlinkSync(TUNNEL_PID_PATH);
  } catch {
    /* ignore */
  }

  const publicWsUrl = `ws://${ip}:${localPort}`;
  const info = {
    publicWsUrl,
    httpsUrl: null,
    localPort,
    pid: null,
    provider: 'tailscale',
    tailscaleIp: ip,
    createdAt: new Date().toISOString(),
    note: 'Friend must be on the same Tailscale network (tailnet).',
  };
  writeConnection(info);
  return info;
}

/**
 * Opens connectivity for the local relay.
 * Modes via SS_TUNNEL:
 *   localtunnel (default) | cloudflare | tailscale
 */
async function startInternetTunnel(localPort) {
  const mode = (process.env.SS_TUNNEL || 'localtunnel').toLowerCase();

  if (mode === 'tailscale' || mode === 'ts') {
    return startTailscaleEndpoint(localPort);
  }

  if (mode === 'cloudflare' || mode === 'cf') {
    return startCloudflareTunnel(localPort);
  }

  return startLocalTunnel(localPort);
}

module.exports = {
  TUNNEL_PID_PATH,
  CONNECTION_PATH,
  ensureCloudflared,
  startInternetTunnel,
  startTailscaleEndpoint,
  readConnection,
  clearConnection,
  toWsUrl,
};
