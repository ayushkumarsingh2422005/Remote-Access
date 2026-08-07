/**
 * Parse shortcuts like "Ctrl+Alt+L" and match node-global-key-listener events.
 */

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

function downHas(down, names) {
  return names.some((n) => down[n]);
}

function matchesShortcut(parsed, e, down) {
  if (!parsed || !parsed.key) return false;
  if (e.state !== 'DOWN') return false;

  const name = String(e.name || '').toUpperCase();
  if (name !== parsed.key) return false;

  const ctrl = downHas(down, ['LEFT CTRL', 'RIGHT CTRL']);
  const alt = downHas(down, ['LEFT ALT', 'RIGHT ALT']);
  const shift = downHas(down, ['LEFT SHIFT', 'RIGHT SHIFT']);
  const meta = downHas(down, ['LEFT META', 'RIGHT META', 'LEFT WINDOWS', 'RIGHT WINDOWS']);

  if (parsed.needCtrl !== ctrl) return false;
  if (parsed.needAlt !== alt) return false;
  if (parsed.needShift !== shift) return false;
  if (parsed.needMeta !== meta) return false;
  return true;
}

function startHostHotkeys({ lockSpec, unlockSpec, onLock, onUnlock, log }) {
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

  const stop = listener.addListener((e, down) => {
    const now = Date.now();
    if (now - lastFire < 400) return; // debounce

    if (matchesShortcut(lock, e, down)) {
      lastFire = now;
      onLock();
      return;
    }
    if (matchesShortcut(unlock, e, down)) {
      lastFire = now;
      onUnlock();
    }
  });

  return () => {
    try {
      if (typeof stop === 'function') stop();
      if (listener && typeof listener.kill === 'function') listener.kill();
    } catch {
      /* ignore */
    }
  };
}

module.exports = {
  parseShortcut,
  matchesShortcut,
  startHostHotkeys,
};
