/**
 * Remote input allowlist.
 *
 * The controller may only drive the host with:
 *   - typing / text-caret keys (letters, digits, punctuation, Shift, Backspace, …)
 *   - mouse movement
 *   - left click and right click
 *
 * Win, Print Screen, Alt, Ctrl chords, F-keys, scroll, middle-click, and other
 * OS / system keys must stay on the local (controller) PC.
 */

const EDIT_KEYS = new Set([
  'Backspace',
  'Delete',
  'Enter',
  'Tab',
  ' ',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
]);

const EDIT_CODES = new Set([
  'Backspace',
  'Delete',
  'Enter',
  'NumpadEnter',
  'Tab',
  'Space',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'ShiftLeft',
  'ShiftRight',
]);

const TYPING_CODES = new Set([
  ...EDIT_CODES,
  'Comma',
  'Period',
  'Slash',
  'Backslash',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Semicolon',
  'Quote',
  'Backquote',
  'IntlBackslash',
  'IntlRo',
  'IntlYen',
  'NumpadAdd',
  'NumpadSubtract',
  'NumpadMultiply',
  'NumpadDivide',
  'NumpadDecimal',
  'NumpadComma',
]);

function isTypingCode(code) {
  if (!code) return false;
  if (TYPING_CODES.has(code)) return true;
  if (/^Key[A-Z]$/.test(code)) return true;
  if (/^Digit[0-9]$/.test(code)) return true;
  if (/^Numpad[0-9]$/.test(code)) return true;
  return false;
}

const BLOCKED_KEYS = new Set([
  'Meta',
  'OS',
  'Alt',
  'AltGraph',
  'Control',
  'Escape',
  'PrintScreen',
  'ScrollLock',
  'Pause',
  'ContextMenu',
  'CapsLock',
  'NumLock',
  'Insert',
  'PageUp',
  'PageDown',
  'Help',
  'Clear',
]);

const BLOCKED_CODES = new Set([
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'Escape',
  'PrintScreen',
  'ScrollLock',
  'Pause',
  'ContextMenu',
  'CapsLock',
  'NumLock',
  'Insert',
  'PageUp',
  'PageDown',
  'Help',
  'Fn',
]);

function flag(event, domName, shortName) {
  return !!(event && (event[domName] === true || event[shortName] === true));
}

function isFunctionKey(key, code) {
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/;
  return fn.test(key || '') || fn.test(code || '');
}

function isPrintableTypingKey(key) {
  if (typeof key !== 'string' || !key) return false;
  if (key === 'Dead') return true;
  return key.length === 1;
}

function isOsOrMediaCode(code) {
  if (!code) return false;
  return (
    code.startsWith('Media') ||
    code.startsWith('Volume') ||
    code.startsWith('Launch') ||
    code.startsWith('Browser') ||
    code.startsWith('Lang') ||
    code === 'Power' ||
    code === 'Sleep' ||
    code === 'WakeUp'
  );
}

function isAllowedRemoteKeyEvent(event) {
  if (!event) return false;
  const key = event.key || '';
  const code = event.code || '';
  const meta = flag(event, 'metaKey', 'meta');
  const alt = flag(event, 'altKey', 'alt');
  const ctrl = flag(event, 'ctrlKey', 'ctrl');

  // Win / Cmd chords (Win+R, Win+E, Cmd+Tab, …) stay local
  if (meta) return false;

  if (isFunctionKey(key, code) || isOsOrMediaCode(code)) return false;
  if (BLOCKED_KEYS.has(key) || BLOCKED_CODES.has(code)) return false;

  // Ctrl chords stay local (Ctrl+V, Ctrl+S, Ctrl+W, Ctrl+Esc, …).
  // AltGr is Ctrl+Alt and is required for some keyboard layouts.
  const altGr = ctrl && alt;
  if (ctrl && !altGr) return false;

  // Alt+Tab, Alt+F4, menu mnemonics stay local. AltGr printable chars pass.
  if (alt && !altGr) return false;

  if (isPrintableTypingKey(key)) return true;
  if (EDIT_KEYS.has(key) || isTypingCode(code)) return true;
  if (key === 'Shift' || code === 'ShiftLeft' || code === 'ShiftRight') return true;

  return false;
}

function isAllowedRemoteMouseEvent(event) {
  if (!event) return false;
  const action = event.action;
  if (action === 'mousemove') return true;
  if (action === 'mousedown' || action === 'mouseup') {
    const button = event.button;
    return button === 0 || button === 2;
  }
  return false;
}

function isAllowedRemoteInput(event) {
  if (!event || !event.action) return false;
  const action = event.action;

  if (action === 'type-text' || action === 'clipboard-only') {
    return true;
  }
  if (action === 'paste-text') return false;

  if (action === 'mousemove' || action === 'mousedown' || action === 'mouseup') {
    return isAllowedRemoteMouseEvent(event);
  }

  if (action === 'scroll' || action === 'wheel') return false;

  if (action === 'keydown' || action === 'keyup') {
    return isAllowedRemoteKeyEvent(event);
  }

  return false;
}

/** True when this key must not be swallowed locally (Win, PrtScn, Alt+Tab, …). */
function shouldKeepKeyLocal(event) {
  return !isAllowedRemoteKeyEvent(event);
}

module.exports = {
  isAllowedRemoteInput,
  isAllowedRemoteKeyEvent,
  isAllowedRemoteMouseEvent,
  shouldKeepKeyLocal,
};
