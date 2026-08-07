#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  ensureAppDir,
  loadConfig,
  saveConfig,
  PID_PATH,
  RELAY_PID_PATH,
  TUNNEL_PID_PATH,
  LOG_PATH,
  CONFIG_PATH,
  CONNECTION_PATH,
} = require('@ss-remote/shared');
const {
  startInternetTunnel,
  readConnection,
  clearConnection,
  toWsUrl,
} = require('../lib/tunnel');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const AGENT_ENTRY = path.join(ROOT, 'packages', 'agent', 'src', 'index.js');
const RELAY_ENTRY = path.join(ROOT, 'packages', 'relay', 'src', 'index.js');
const VIEWER_DIR = path.join(ROOT, 'packages', 'viewer');

function isRunning(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writePid(file, pid) {
  ensureAppDir();
  fs.writeFileSync(file, String(pid));
}

function clearPid(file) {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

function killPid(pid) {
  if (!isRunning(pid)) return false;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

function startDetached(entry, pidFile, label, env = {}) {
  ensureAppDir();
  const existing = readPid(pidFile);
  if (existing && isRunning(existing)) {
    console.log(`${label} already running (pid ${existing})`);
    return existing;
  }

  const out = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    cwd: ROOT,
    env: { ...process.env, ...env },
  });
  child.unref();
  writePid(pidFile, child.pid);
  console.log(`${label} started (pid ${child.pid})`);
  return child.pid;
}

function stopByPidFile(pidFile, label) {
  const pid = readPid(pidFile);
  if (!pid) {
    console.log(`${label} is not running`);
    clearPid(pidFile);
    return;
  }
  if (!isRunning(pid)) {
    console.log(`${label} is not running`);
    clearPid(pidFile);
    return;
  }
  killPid(pid);
  clearPid(pidFile);
  console.log(`${label} stopped (pid ${pid})`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function status() {
  const config = loadConfig();
  const agentPid = readPid(PID_PATH);
  const relayPid = readPid(RELAY_PID_PATH);
  const tunnelPid = readPid(TUNNEL_PID_PATH);
  const agentOn = agentPid && isRunning(agentPid);
  const relayOn = relayPid && isRunning(relayPid);
  const tunnelOn = tunnelPid && isRunning(tunnelPid);
  const conn = readConnection();

  console.log('ss-remote status');
  console.log(`  config:   ${CONFIG_PATH}`);
  console.log(`  relay:    ${relayOn ? `running (pid ${relayPid})` : 'stopped'}`);
  console.log(`  tunnel:   ${tunnelOn ? `running (pid ${tunnelPid})` : 'stopped'}`);
  console.log(`  agent:    ${agentOn ? `running (pid ${agentPid})` : 'stopped'}`);
  console.log(`  pairCode: ${config.pairCode}`);
  console.log(`  relayUrl: ${config.relayUrl}`);
  if (conn && conn.publicWsUrl) {
    console.log(`  public:   ${conn.publicWsUrl}`);
  }
  console.log(`  log:      ${LOG_PATH}`);
}

function printHelp() {
  console.log(`
ss — Screen Share remote desktop

Usage:
  ss start all          Start local relay + internet tunnel + silent agent
  ss stop all           Stop agent, tunnel, and local relay
  ss start agent        Start only the background agent (sharer)
  ss stop agent         Stop the background agent
  ss start relay        Start only the local relay server
  ss stop relay         Stop the local relay server
  ss status             Show running state
  ss share              Show the public link to send your friend
  ss connect <url>      Controller: save public link and open viewer
  ss viewer             Open the remote viewer (controller)
  ss config             Show config path and values
  ss config set <k> <v> Update a config value
  ss help               Show this help

Typical (India ↔ US, no VPS):
  Host:       ss start all     → copy the public link
  Friend:     ss connect <url> → opens viewer and takes control

Host shortcuts (while agent is running):
  Ctrl+Alt+L   Disable remote mouse & keyboard (screen keeps sharing)
  Ctrl+Alt+U   Resume remote mouse & keyboard

Config file: ${CONFIG_PATH}
`.trim());
}

function printShareBanner(publicWsUrl, pairCode) {
  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log('  Screen sharing is LIVE over the internet');
  console.log('══════════════════════════════════════════════════');
  console.log('');
  console.log('  Send this command to your friend:');
  console.log('');
  console.log(`    ss connect ${publicWsUrl}`);
  console.log('');
  console.log(`  Pair code (must match): ${pairCode}`);
  console.log('');
  console.log('  Or they can run:');
  console.log(`    ss config set relayUrl ${publicWsUrl}`);
  console.log(`    ss config set pairCode ${pairCode}`);
  console.log('    ss viewer');
  console.log('');
  console.log('══════════════════════════════════════════════════');
}

async function startAll() {
  const config = loadConfig();
  const port = config.relayPort || 9000;
  const localRelay = `ws://127.0.0.1:${port}`;

  startDetached(RELAY_ENTRY, RELAY_PID_PATH, 'relay', {
    SS_RELAY_PORT: String(port),
  });

  // Give the relay a moment to bind
  await sleep(800);

  console.log('Opening free internet tunnel…');
  let tunnelInfo;
  try {
    tunnelInfo = await startInternetTunnel(port);
    console.log(`tunnel ready → ${tunnelInfo.publicWsUrl}`);
  } catch (err) {
    console.error('Could not open internet tunnel:', err.message);
    console.error('You can still use local network with relayUrl ws://127.0.0.1:' + port);
    startDetached(AGENT_ENTRY, PID_PATH, 'agent', {
      SS_RELAY_URL: localRelay,
    });
    return;
  }

  // Host agent always talks to local relay; friend uses the public tunnel URL
  startDetached(AGENT_ENTRY, PID_PATH, 'agent', {
    SS_RELAY_URL: localRelay,
  });

  printShareBanner(tunnelInfo.publicWsUrl, config.pairCode);
}

function stopAll() {
  stopByPidFile(PID_PATH, 'agent');
  stopByPidFile(TUNNEL_PID_PATH, 'tunnel');
  stopByPidFile(RELAY_PID_PATH, 'relay');
  clearConnection();
}

function share() {
  const config = loadConfig();
  const conn = readConnection();
  const tunnelPid = readPid(TUNNEL_PID_PATH);
  if (!conn || !conn.publicWsUrl || !(tunnelPid && isRunning(tunnelPid))) {
    console.log('No active public tunnel. On the host computer run: ss start all');
    return;
  }
  printShareBanner(conn.publicWsUrl, config.pairCode);
}

function openViewer() {
  let electronBin;
  try {
    electronBin = require(require.resolve('electron', { paths: [VIEWER_DIR, ROOT] }));
  } catch {
    console.error('Electron is not installed. Run npm install from the project root.');
    process.exit(1);
  }

  const child = spawn(electronBin, ['.'], {
    cwd: VIEWER_DIR,
    stdio: 'inherit',
    env: process.env,
    detached: false,
  });
  child.on('exit', (code) => process.exit(code || 0));
}

function connectCmd(urlArg) {
  if (!urlArg) {
    console.error('Usage: ss connect <public-wss-url>');
    console.error('Example: ss connect wss://random-words.trycloudflare.com');
    process.exit(1);
  }
  let url = urlArg.trim();
  if (url.startsWith('https://') || url.startsWith('http://')) {
    url = toWsUrl(url);
  }
  if (!/^wss?:\/\//i.test(url)) {
    console.error('URL must look like wss://….trycloudflare.com');
    process.exit(1);
  }

  const config = loadConfig();
  saveConfig({ relayUrl: url.replace(/\/$/, '') });
  console.log(`Saved relayUrl → ${url}`);
  console.log(`Using pairCode → ${config.pairCode}`);
  console.log('Make sure the host used the same pairCode (ss config set pairCode …).');
  console.log('Opening viewer…');
  openViewer();
}

function configCmd(args) {
  if (args[0] === 'set' && args[1] && args[2] !== undefined) {
    const key = args[1];
    let value = args.slice(2).join(' ');
    if (['quality', 'fps', 'maxWidth', 'relayPort'].includes(key)) {
      value = Number(value);
    }
    const next = saveConfig({ [key]: value });
    console.log(`Updated ${key}. Current config:`);
    console.log(JSON.stringify(next, null, 2));
    return;
  }
  const config = loadConfig();
  console.log(`Config path: ${CONFIG_PATH}`);
  console.log(JSON.stringify(config, null, 2));
  if (fs.existsSync(CONNECTION_PATH)) {
    console.log(`Active connection: ${CONNECTION_PATH}`);
    console.log(fs.readFileSync(CONNECTION_PATH, 'utf8'));
  }
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case 'start':
      if (sub === 'all') await startAll();
      else if (sub === 'agent') {
        const config = loadConfig();
        startDetached(AGENT_ENTRY, PID_PATH, 'agent', {
          SS_RELAY_URL: config.relayUrl,
        });
      } else if (sub === 'relay') {
        const config = loadConfig();
        startDetached(RELAY_ENTRY, RELAY_PID_PATH, 'relay', {
          SS_RELAY_PORT: String(config.relayPort || 9000),
        });
      } else printHelp();
      break;
    case 'stop':
      if (sub === 'all') stopAll();
      else if (sub === 'agent') stopByPidFile(PID_PATH, 'agent');
      else if (sub === 'relay') stopByPidFile(RELAY_PID_PATH, 'relay');
      else if (sub === 'tunnel') {
        stopByPidFile(TUNNEL_PID_PATH, 'tunnel');
        clearConnection();
      } else printHelp();
      break;
    case 'status':
      status();
      break;
    case 'share':
      share();
      break;
    case 'connect':
      connectCmd(sub);
      break;
    case 'viewer':
      openViewer();
      break;
    case 'config':
      configCmd([sub, ...rest].filter(Boolean));
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
