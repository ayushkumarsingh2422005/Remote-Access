/**
 * Host global hotkeys.
 * Windows: RegisterHotKey via a small PowerShell helper (no missing native binary).
 * Other platforms: best-effort via node-global-key-listener if present.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function parseShortcut(spec) {
  const parts = String(spec || '')
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  const needCtrl = parts.includes('ctrl') || parts.includes('control');
  const needAlt = parts.includes('alt');
  const needShift = parts.includes('shift');
  const needMeta =
    parts.includes('meta') ||
    parts.includes('win') ||
    parts.includes('cmd') ||
    parts.includes('super');

  const key = parts.find(
    (p) => !['ctrl', 'control', 'alt', 'shift', 'meta', 'win', 'cmd', 'super'].includes(p)
  );

  return {
    needCtrl,
    needAlt,
    needShift,
    needMeta,
    key: key ? key.toUpperCase() : null,
  };
}

/** Virtual-key codes for letters/digits/F-keys */
function keyToVk(key) {
  if (!key) return null;
  const k = String(key).toUpperCase();
  if (k.length === 1) {
    const code = k.charCodeAt(0);
    if (code >= 0x30 && code <= 0x39) return code; // 0-9
    if (code >= 0x41 && code <= 0x5a) return code; // A-Z
  }
  const f = /^F(\d{1,2})$/.exec(k);
  if (f) {
    const n = Number(f[1]);
    if (n >= 1 && n <= 24) return 0x70 + (n - 1);
  }
  const named = {
    SPACE: 0x20,
    TAB: 0x09,
    ENTER: 0x0d,
    ESCAPE: 0x1b,
    ESC: 0x1b,
    LEFT: 0x25,
    UP: 0x26,
    RIGHT: 0x27,
    DOWN: 0x28,
    DELETE: 0x2e,
    HOME: 0x24,
    END: 0x23,
  };
  return named[k] || null;
}

function modsToFlags(parsed) {
  let flags = 0x4000; // MOD_NOREPEAT
  if (parsed.needAlt) flags |= 0x0001;
  if (parsed.needCtrl) flags |= 0x0002;
  if (parsed.needShift) flags |= 0x0004;
  if (parsed.needMeta) flags |= 0x0008;
  return flags;
}

function startWindowsHotkeys({ lockSpec, unlockSpec, onLock, onUnlock, log }) {
  const lock = parseShortcut(lockSpec);
  const unlock = parseShortcut(unlockSpec);
  const lockVk = keyToVk(lock.key);
  const unlockVk = keyToVk(unlock.key);

  if (!lockVk || !unlockVk) {
    if (log) log('hotkeys: invalid shortcut keys');
    return () => {};
  }

  const lockMods = modsToFlags(lock);
  const unlockMods = modsToFlags(unlock);

  const ps1 = path.join(__dirname, 'win-hotkeys.ps1');
  if (!fs.existsSync(ps1)) {
    if (log) log('hotkeys: missing win-hotkeys.ps1');
    return () => {};
  }

  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      ps1,
      String(lockMods),
      String(lockVk),
      String(unlockMods),
      String(unlockVk),
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let lastFire = 0;
  const handleLine = (line) => {
    const msg = String(line || '').trim();
    if (!msg) return;
    const now = Date.now();
    if (now - lastFire < 350) return;
    if (msg === 'LOCK') {
      lastFire = now;
      onLock();
    } else if (msg === 'UNLOCK') {
      lastFire = now;
      onUnlock();
    } else if (msg.startsWith('ERR:') && log) {
      log('hotkeys:', msg.slice(4).trim());
    }
  };

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) handleLine(line);
  });

  child.stderr.on('data', (chunk) => {
    if (log) log('hotkeys stderr:', chunk.toString().trim());
  });

  child.on('error', (err) => {
    if (log) log('hotkeys process error:', err.message);
  });

  child.on('exit', (code) => {
    if (log && code && code !== 0) log('hotkeys process exited:', code);
  });

  if (log) log(`hotkeys ready (Windows): lock=${lockSpec} unlock=${unlockSpec}`);

  return () => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  };
}

function startLegacyHotkeys({ lockSpec, unlockSpec, onLock, onUnlock, log }) {
  let listener = null;
  try {
    const { GlobalKeyboardListener } = require('node-global-key-listener');
    listener = new GlobalKeyboardListener();
  } catch (err) {
    if (log) log('hotkeys unavailable:', err.message);
    return () => {};
  }

  const lock = parseShortcut(lockSpec);
  const unlock = parseShortcut(unlockSpec);
  let lastFire = 0;

  const downHas = (down, names) => names.some((n) => down[n]);
  const matches = (parsed, e, down) => {
    if (!parsed || !parsed.key || e.state !== 'DOWN') return false;
    if (String(e.name || '').toUpperCase() !== parsed.key) return false;
    const ctrl = downHas(down, ['LEFT CTRL', 'RIGHT CTRL']);
    const alt = downHas(down, ['LEFT ALT', 'RIGHT ALT']);
    const shift = downHas(down, ['LEFT SHIFT', 'RIGHT SHIFT']);
    const meta = downHas(down, ['LEFT META', 'RIGHT META', 'LEFT WINDOWS', 'RIGHT WINDOWS']);
    return (
      parsed.needCtrl === ctrl &&
      parsed.needAlt === alt &&
      parsed.needShift === shift &&
      parsed.needMeta === meta
    );
  };

  // Guard against async spawn crash killing the agent
  const onChildError = (err) => {
    if (log) log('hotkeys spawn failed (non-fatal):', err.message);
  };
  process.once('uncaughtException', function guard(err) {
    if (err && err.code === 'ENOENT' && /KeyServer|global-key/i.test(String(err.path || err.message))) {
      if (log) log('hotkeys binary missing — continuing without global shortcuts');
      process.off('uncaughtException', guard);
      return;
    }
    process.off('uncaughtException', guard);
    throw err;
  });

  let stop;
  try {
    stop = listener.addListener((e, down) => {
      const now = Date.now();
      if (now - lastFire < 400) return;
      if (matches(lock, e, down)) {
        lastFire = now;
        onLock();
        return;
      }
      if (matches(unlock, e, down)) {
        lastFire = now;
        onUnlock();
      }
    });
  } catch (err) {
    if (log) log('hotkeys failed:', err.message);
    return () => {};
  }

  if (listener.proc) {
    listener.proc.on('error', onChildError);
  }

  return () => {
    try {
      if (typeof stop === 'function') stop();
      if (listener && typeof listener.kill === 'function') listener.kill();
    } catch {
      /* ignore */
    }
  };
}

function startHostHotkeys(opts) {
  if (process.platform === 'win32') {
    return startWindowsHotkeys(opts);
  }
  return startLegacyHotkeys(opts);
}

module.exports = {
  parseShortcut,
  keyToVk,
  startHostHotkeys,
};
