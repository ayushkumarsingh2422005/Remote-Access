const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const placeholder = document.getElementById('placeholder');
const viewport = document.getElementById('viewport');
const cursorEl = document.getElementById('cursor');
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
const MOVE_INTERVAL_MS = 16; // ~60 updates/sec max

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

  if (data.pairCode || data.relayUrl) {
    metaEl.textContent = [
      data.pairCode ? `pair: ${data.pairCode}` : null,
      data.relayUrl || null,
      fps ? `${fps} fps` : null,
    ]
      .filter(Boolean)
      .join('  ·  ');
  }
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

function sendInput(event) {
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

canvas.addEventListener('mousemove', (e) => {
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
  e.preventDefault();
  // Push local clipboard to host, then ask host to paste
  const text = await window.ssRemote.readClipboard();
  window.ssRemote.sendClipboardToHost(text || '');
  // Small delay so host clipboard is set before Ctrl+V
  setTimeout(() => {
    sendInput({ action: 'paste-text', text: text || '' });
  }, 80);
}

window.addEventListener('keydown', async (e) => {
  if (document.activeElement !== canvas) return;

  // Bidirectional paste: sync our clipboard → host, then paste there
  if (isMod(e) && (e.key === 'v' || e.key === 'V') && !e.altKey && !e.shiftKey) {
    await handlePasteShortcut(e);
    return;
  }

  // Copy on remote still goes through; host clipboard will sync back to us
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

window.ssRemote.onFrame((frame) => {
  if (!frame || !frame.data) {
    viewport.hidden = true;
    placeholder.hidden = false;
    return;
  }

  placeholder.hidden = true;
  viewport.hidden = false;

  const img = new Image();
  img.onload = () => {
    frameW = frame.width || img.width;
    frameH = frame.height || img.height;
    if (canvas.width !== frameW || canvas.height !== frameH) {
      canvas.width = frameW;
      canvas.height = frameH;
    }
    ctx.drawImage(img, 0, 0);
    frameCount += 1;
    const now = Date.now();
    if (now - lastFpsAt >= 1000) {
      fps = frameCount;
      frameCount = 0;
      lastFpsAt = now;
      metaEl.textContent = metaEl.textContent.replace(/\s·\s\d+\sfps|$/, `  ·  ${fps} fps`);
    }
  };
  img.src = `data:image/jpeg;base64,${frame.data}`;
});

window.ssRemote.getConfig().then((cfg) => {
  metaEl.textContent = `pair: ${cfg.pairCode}  ·  ${cfg.relayUrl}`;
});
