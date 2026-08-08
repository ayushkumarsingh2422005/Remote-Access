const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIN_TYPE_SCRIPT = path.join(__dirname, 'win-type.ps1');

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

function typeWindowsSendInput(text, delayMs, tabWidth) {
  const delay = Math.max(0, Number(delayMs) || 0);
  const normalized = expandTabs(text, tabWidth);
  const file = writeTempText(normalized);

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

    let stderr = '';
    const timeoutMs = Math.min(
      30 * 60_000,
      30_000 + Math.max(1, normalized.length) * (delay + 8) * 2
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Keyboard inject timed out'));
    }, timeoutMs);

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
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

  for (const char of normalized) {
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
  const normalized = expandTabs(text, tabWidth);
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
  expandTabs,
};
