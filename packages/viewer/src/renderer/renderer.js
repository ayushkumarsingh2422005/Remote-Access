const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d', { alpha: false });
const placeholder = document.getElementById('placeholder');
const viewport = document.getElementById('viewport');
const cursorEl = document.getElementById('cursor');
const inputLockEl = document.getElementById('input-lock');
const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');

let frameW = 0;
let frameH = 0;
let lastFpsAt = Date.now();
let frameCount = 0;
let fps = 0;
let pressedKeys = new Set();
let latestNorm = null;
let moveTimer = null;
let pairCode = '';
let relayUrl = '';
let drawing = false;
let pendingFrame = null;
let inputEnabled = true;
const MOVE_INTERVAL_MS = 16;

function shortRelay(url) {
  if (!url) return '';
  try {
    const u = new URL(url.replace(/^ws/i, 'http'));
    const host = u.host;
    return host.length > 36 ? `${host.slice(0, 18)}…${host.slice(-12)}` : host;
  } catch {
    return url.length > 40 ? `${url.slice(0, 40)}…` : url;
  }
}

function updateMeta() {
  metaEl.textContent = [
    pairCode ? `pair: ${pairCode}` : null,
    relayUrl ? shortRelay(relayUrl) : null,
    `${fps} fps`,
  ]
    .filter(Boolean)
    .join('  ·  ');
}

function setStatus(data) {
  const state = data.state || 'unknown';
  statusEl.className = `status ${state}`;
  statusEl.textContent =
    data.message ||
    ({
      connecting: 'Connecting to relay…',
      connected: 'Connected — waiting for host…',
      waiting: 'Waiting for host…',
      ready: 'Live — you have full control',
      disconnected: 'Disconnected',
      error: data.message || 'Error',
    }[state] || state);

  if (data.pairCode) pairCode = data.pairCode;
  if (data.relayUrl) relayUrl = data.relayUrl;
  updateMeta();
}

function mapCoords(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || frameW <= 0 || frameH <= 0) {
    return { x: 0, y: 0, nx: 0, ny: 0 };
  }
  const x = ((clientX - rect.left) / rect.width) * frameW;
  const y = ((clientY - rect.top) / rect.height) * frameH;
  const nx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const ny = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  return {
    x: Math.max(0, Math.min(frameW, x)),
    y: Math.max(0, Math.min(frameH, y)),
    nx,
    ny,
  };
}

function setInputEnabled(enabled, message, reason) {
  inputEnabled = enabled !== false;
  viewport.classList.toggle('input-disabled', !inputEnabled);
  inputLockEl.hidden = inputEnabled;
  inputLockEl.classList.toggle('host', reason === 'host');
  inputLockEl.textContent = message || (
    inputEnabled ? 'Keyboard and Mouse enabled' : 'Keyboard and Mouse disabled'
  );

  if (!inputEnabled) {
    pressedKeys.clear();
    latestNorm = null;
    cursorEl.style.opacity = '0';
    statusEl.className = 'status waiting';
    statusEl.textContent = message || 'Keyboard and Mouse disabled';
  } else {
    statusEl.className = 'status ready';
    statusEl.textContent = 'Live — you have full control';
  }
}

function sendInput(event) {
  if (!inputEnabled) return;
  window.ssRemote.sendInput(event);
}

function flushMove() {
  if (!latestNorm) return;
  const p = latestNorm;
  latestNorm = null;
  sendInput({
    action: 'mousemove',
    x: p.x,
    y: p.y,
    nx: p.nx,
    ny: p.ny,
  });
}

function queueMove(coords) {
  latestNorm = coords;
  if (!moveTimer) {
    moveTimer = setTimeout(() => {
      moveTimer = null;
      flushMove();
    }, MOVE_INTERVAL_MS);
  }
}

function updateLocalCursor(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const viewRect = viewport.getBoundingClientRect();
  const x = clientX - viewRect.left;
  const y = clientY - viewRect.top;
  const inside =
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom;
  cursorEl.style.opacity = inside ? '1' : '0';
  cursorEl.style.transform = `translate(${x}px, ${y}px) rotate(-20deg)`;
}

function isMod(e) {
  return e.ctrlKey || e.metaKey;
}

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function paintFrame(frame) {
  const bytes = base64ToUint8Array(frame.data);
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);

  frameW = frame.width || bitmap.width;
  frameH = frame.height || bitmap.height;
  if (canvas.width !== frameW || canvas.height !== frameH) {
    canvas.width = frameW;
    canvas.height = frameH;
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  frameCount += 1;
  const now = Date.now();
  if (now - lastFpsAt >= 1000) {
    fps = frameCount;
    frameCount = 0;
    lastFpsAt = now;
    updateMeta();
  }
}

async function drainFrames() {
  if (drawing) return;
  drawing = true;
  try {
    while (pendingFrame) {
      const frame = pendingFrame;
      pendingFrame = null; // drop anything that arrived mid-decode; keep only newest next loop
      try {
        await paintFrame(frame);
      } catch {
        /* skip bad frame */
      }
    }
  } finally {
    drawing = false;
    if (pendingFrame) {
      drainFrames();
    }
  }
}

function enqueueFrame(frame) {
  // Always keep only the latest frame — never queue a backlog
  pendingFrame = frame;
  drainFrames();
}

canvas.addEventListener('mousemove', (e) => {
  if (!inputEnabled) {
    cursorEl.style.opacity = '0';
    return;
  }
  updateLocalCursor(e.clientX, e.clientY);
  queueMove(mapCoords(e.clientX, e.clientY));
});

canvas.addEventListener('mouseenter', (e) => {
  updateLocalCursor(e.clientX, e.clientY);
});

canvas.addEventListener('mouseleave', () => {
  cursorEl.style.opacity = '0';
  flushMove();
});

canvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  canvas.focus();
  flushMove();
  const { x, y, nx, ny } = mapCoords(e.clientX, e.clientY);
  sendInput({ action: 'mousedown', x, y, nx, ny, button: e.button });
});

canvas.addEventListener('mouseup', (e) => {
  e.preventDefault();
  const { x, y, nx, ny } = mapCoords(e.clientX, e.clientY);
  sendInput({ action: 'mouseup', x, y, nx, ny, button: e.button });
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  sendInput({ action: 'scroll', dy: e.deltaY, deltaY: e.deltaY });
}, { passive: false });

async function handlePasteShortcut(e) {
  if (!inputEnabled) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  const text = await window.ssRemote.readClipboard();
  window.ssRemote.sendClipboardToHost(text || '');
  setTimeout(() => {
    sendInput({ action: 'paste-text', text: text || '' });
  }, 80);
}

window.addEventListener('keydown', async (e) => {
  if (document.activeElement !== canvas) return;

  if (isMod(e) && (e.key === 'v' || e.key === 'V') && !e.altKey && !e.shiftKey) {
    await handlePasteShortcut(e);
    return;
  }

  e.preventDefault();
  if (pressedKeys.has(e.code)) return;
  pressedKeys.add(e.code);
  sendInput({
    action: 'keydown',
    key: e.key,
    code: e.code,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    meta: e.metaKey,
  });
});

window.addEventListener('keyup', (e) => {
  if (document.activeElement !== canvas && !pressedKeys.has(e.code)) return;
  if (isMod(e) && (e.key === 'v' || e.key === 'V')) {
    pressedKeys.delete(e.code);
    return;
  }
  e.preventDefault();
  pressedKeys.delete(e.code);
  sendInput({
    action: 'keyup',
    key: e.key,
    code: e.code,
  });
});

window.addEventListener('blur', () => {
  for (const code of pressedKeys) {
    sendInput({ action: 'keyup', key: code, code });
  }
  pressedKeys.clear();
});

window.ssRemote.onStatus(setStatus);

window.ssRemote.onInputState((data) => {
  setInputEnabled(data.enabled !== false, data.message, data.reason);
});

window.ssRemote.onFrame((frame) => {
  if (!frame || !frame.data) {
    viewport.hidden = true;
    placeholder.hidden = false;
    pendingFrame = null;
    return;
  }

  placeholder.hidden = true;
  viewport.hidden = false;
  enqueueFrame(frame);
});

window.ssRemote.getConfig().then((cfg) => {
  pairCode = cfg.pairCode || '';
  relayUrl = cfg.relayUrl || '';
  updateMeta();
});
