const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIN_TYPE_SCRIPT = path.join(__dirname, 'win-type.ps1');

let activeChild = null;
let cancelRequested = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function expandTabs(text, tabWidth = 4) {
  const width = Math.max(1, Math.min(16, Number(tabWidth) || 4));
  return String(text).replace(/\t/g, ' '.repeat(width));
}

function writeTempText(text) {
  const file = path.join(os.tmpdir(), `ss-type-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
}

/** Stop any in-flight mimic typing immediately (lock / host busy / shutdown). */
function cancelTyping() {
  cancelRequested = true;
  if (activeChild) {
    killProcessTree(activeChild);
    activeChild = null;
  }
}

function typeWindowsSendInput(text, delayMs, tabWidth) {
  const delay = Math.max(0, Number(delayMs) || 0);
  const normalized = expandTabs(text, tabWidth);
  const file = writeTempText(normalized);
  cancelRequested = false;

  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        WIN_TYPE_SCRIPT,
        '-TextFile',
        file,
        '-DelayMs',
        String(delay),
        '-TabWidth',
        String(tabWidth),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    activeChild = child;

    let stderr = '';
    const timeoutMs = Math.min(
      10 * 60_000,
      20_000 + Math.max(1, normalized.length) * (delay + 8) * 2
    );
    const timer = setTimeout(() => {
      killProcessTree(child);
      reject(new Error('Keyboard inject timed out'));
    }, timeoutMs);

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = null;
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = null;
      cleanup();
      if (cancelRequested) {
        resolve(); // cancelled cleanly
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `win-type.ps1 exited ${code}`));
    });

    function cleanup() {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  });
}

async function typeWithNut(text, delayMs, tabWidth) {
  const { keyboard, Key } = require('@nut-tree-fork/nut-js');
  keyboard.config.autoDelayMs = 0;
  const delay = Math.max(0, Number(delayMs) || 0);
  const normalized = expandTabs(text, tabWidth);
  cancelRequested = false;

  for (const char of normalized) {
    if (cancelRequested) return;
    if (char === '\r') continue;
    if (char === '\n') {
      await keyboard.pressKey(Key.Enter);
      await keyboard.releaseKey(Key.Enter);
    } else {
      await keyboard.type(char);
    }
    if (delay > 0) {
      const jitter = Math.floor(Math.random() * Math.max(1, delay));
      await sleep(delay + jitter);
    }
  }
}

/**
 * Type text at the host caret as real keystrokes (mimic typing).
 * Never uses clipboard. Tabs become spaces.
 */
async function typeMimic(text, options = {}, log = () => {}) {
  const delayMs = Math.max(0, Number(options.delayMs) || 0);
  const tabWidth = Math.max(1, Math.min(16, Number(options.tabWidth) || 4));
  // Hard cap — long runs monopolize the host keyboard
  const maxChars = Math.max(100, Math.min(20000, Number(options.maxChars) || 8000));
  const raw = String(text || '');
  const clipped = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
  const normalized = expandTabs(clipped, tabWidth);
  if (!normalized) return;

  log(`type-mimic chars=${normalized.length} delayMs=${delayMs}`);

  if (process.platform === 'win32') {
    await typeWindowsSendInput(normalized, delayMs, tabWidth);
    return;
  }
  await typeWithNut(normalized, delayMs, tabWidth);
}

module.exports = {
  typeMimic,
  cancelTyping,
  expandTabs,
};
