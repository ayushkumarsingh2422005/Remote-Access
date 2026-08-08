const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d', { alpha: false });
const placeholder = document.getElementById('placeholder');
const viewport = document.getElementById('viewport');
const cursorEl = document.getElementById('cursor');
const lockChipEl = document.getElementById('lock-chip');
const metaPairEl = document.getElementById('meta-pair');
const metaRestEl = document.getElementById('meta-rest');
const btnType = document.getElementById('btn-type');

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
let controlLabel = '';
let controlReason = '';
let lastSessionState = 'connecting';
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
  if (metaPairEl) {
    metaPairEl.textContent = pairCode ? `pair: ${pairCode}` : '';
  }
  if (metaRestEl) {
    const rest = [
      relayUrl ? shortRelay(relayUrl) : null,
      `${fps} fps`,
    ]
      .filter(Boolean)
      .join('  ·  ');
    metaRestEl.textContent = rest ? `·  ${rest}` : '';
  }
}

/** Always-visible status chip right beside the Type button */
function paintStatusChip(mode, text) {
  if (!lockChipEl) return;
  lockChipEl.textContent = text || '';
  lockChipEl.className = `lock-chip ${mode || 'wait'}`;
  lockChipEl.style.display = 'inline-flex';
}

function applySession(data) {
  if (!data || typeof data !== 'object') return;

  if (data.pairCode) pairCode = data.pairCode;
  if (data.relayUrl) relayUrl = data.relayUrl;
  if (data.state) lastSessionState = data.state;

  const hasInputFields =
    typeof data.inputEnabled === 'boolean' ||
    typeof data.enabled === 'boolean' ||
    data.state === 'locked';

  if (hasInputFields) {
    if (data.state === 'locked') {
      inputEnabled = false;
    } else if (typeof data.inputEnabled === 'boolean') {
      inputEnabled = data.inputEnabled;
    } else if (typeof data.enabled === 'boolean') {
      inputEnabled = data.enabled;
    } else {
      inputEnabled = data.inputEnabled !== false && data.inputEnabled !== 'false';
    }
  }

  if (!inputEnabled) {
    controlReason =
      data.inputReason === 'host' || data.reason === 'host' ? 'host' : 'manual';
    controlLabel =
      data.inputMessage ||
      data.message ||
      (controlReason === 'host'
        ? 'Host is using this PC'
        : 'Keyboard & Mouse disabled');
  } else if (hasInputFields) {
    controlLabel = '';
    controlReason = '';
  }

  if (viewport) viewport.classList.toggle('input-disabled', !inputEnabled);

  if (!inputEnabled) {
    paintStatusChip(
      controlReason === 'host' ? 'host' : 'manual',
      controlLabel || 'Input disabled'
    );
  } else if (data.state === 'ready' || (data.hostPresent && inputEnabled && lastSessionState === 'ready')) {
    paintStatusChip('live', 'Live — full control');
  } else if (data.state === 'error' || data.state === 'disconnected') {
    paintStatusChip('error', data.message || data.state);
  } else if (data.state === 'connecting' || data.state === 'connected' || data.state === 'waiting') {
    paintStatusChip('wait', data.message || 'Waiting for host…');
  } else if (data.hostPresent && inputEnabled) {
    paintStatusChip('live', 'Live — full control');
  } else if (data.message) {
    paintStatusChip('wait', data.message);
  }

  if (!inputEnabled) {
    if (pressedKeys.size > 0) releaseAllLocalKeys();
    else pressedKeys.clear();
    latestNorm = null;
    if (cursorEl) cursorEl.style.opacity = '0';
  }

  updateMeta();
}

function setStatus(data) {
  applySession(data);
}

function setInputEnabled(enabled, message, reason) {
  const on = enabled !== false && enabled !== 'false';
  applySession({
    state: on ? 'ready' : 'locked',
    inputEnabled: on,
    inputReason: reason,
    inputMessage: message,
    hostPresent: true,
    message: on
      ? 'Live — full control'
      : message || (reason === 'host' ? 'Host is using this PC' : 'Keyboard & Mouse disabled'),
    pairCode,
    relayUrl,
  });
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
  const isRelease = event && (event.action === 'keyup' || event.action === 'mouseup');
  if (!inputEnabled && !isRelease) return;
  window.ssRemote.sendInput(event);
}

function releaseAllLocalKeys() {
  for (const code of pressedKeys) {
    window.ssRemote.sendInput({ action: 'keyup', key: code, code });
  }
  pressedKeys.clear();
  window.ssRemote.sendInput({ action: 'mouseup', button: 0, nx: 0.5, ny: 0.5 });
  window.ssRemote.sendInput({ action: 'mouseup', button: 2, nx: 0.5, ny: 0.5 });
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
  // Center the red dot on the pointer
  const x = clientX - viewRect.left - 5;
  const y = clientY - viewRect.top - 5;
  const inside =
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom;
  cursorEl.style.opacity = inside ? '1' : '0';
  cursorEl.style.transform = `translate(${x}px, ${y}px)`;
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

function toJpegBytes(frame) {
  if (frame.jpeg) {
    const j = frame.jpeg;
    if (j instanceof Uint8Array) return j;
    if (ArrayBuffer.isView(j)) {
      return new Uint8Array(j.buffer, j.byteOffset, j.byteLength);
    }
    // Electron sometimes serializes Node Buffers as { type:'Buffer', data:[...] }
    if (j && j.type === 'Buffer' && Array.isArray(j.data)) {
      return Uint8Array.from(j.data);
    }
    if (Array.isArray(j)) return Uint8Array.from(j);
  }
  if (frame.data) return base64ToUint8Array(frame.data);
  throw new Error('frame has no image data');
}

async function paintFrame(frame) {
  const bytes = toJpegBytes(frame);
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

let lastScrollAt = 0;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!inputEnabled) return;
  const now = Date.now();
  if (now - lastScrollAt < 30) return; // throttle scroll storms
  lastScrollAt = now;
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

window.ssRemote.onStatus(applySession);
if (typeof window.ssRemote.onSession === 'function') {
  window.ssRemote.onSession(applySession);
}

// input-state is also embedded in session/status from main; keep as fallback only
window.ssRemote.onInputState((data) => {
  const on = data.enabled !== false && data.enabled !== 'false';
  applySession({
    // Do not invent connection state — only paint lock chrome
    inputEnabled: on,
    inputReason: data.reason,
    inputMessage: data.message,
    state: on ? undefined : 'locked',
    message: on ? undefined : data.message,
    pairCode,
    relayUrl,
  });
});

if (typeof window.ssRemote.getSession === 'function') {
  window.ssRemote.getSession().then((data) => {
    if (data) applySession(data);
  }).catch(() => {});
}

window.ssRemote.onFrame((frame) => {
  const hasImage = frame && (frame.jpeg || frame.data);
  if (!hasImage) {
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

/* —— Mimic typing dialog —— */
const typeModal = document.getElementById('type-modal');
const typeText = document.getElementById('type-text');
const typeSpeed = document.getElementById('type-speed');
const typeSend = document.getElementById('type-send');
const typeStatus = document.getElementById('type-status');
const typeClose = document.getElementById('type-close');

function openTypeModal() {
  typeModal.hidden = false;
  typeStatus.textContent = '';
  typeStatus.className = 'type-status';
  setTimeout(() => typeText.focus(), 50);
}

function closeTypeModal() {
  typeModal.hidden = true;
  if (!viewport.hidden) canvas.focus();
}

btnType.addEventListener('click', () => {
  if (!inputEnabled) {
    typeStatus.textContent = 'Input is disabled on the host right now.';
    openTypeModal();
    typeStatus.className = 'type-status warn';
    return;
  }
  openTypeModal();
});

typeClose.addEventListener('click', closeTypeModal);
typeModal.querySelector('.modal-backdrop').addEventListener('click', closeTypeModal);

window.addEventListener('keydown', (e) => {
  if (typeModal.hidden) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeTypeModal();
  }
});

typeSend.addEventListener('click', () => {
  const text = typeText.value;
  if (!text) {
    typeStatus.textContent = 'Add some text first.';
    typeStatus.className = 'type-status warn';
    return;
  }
  if (!inputEnabled) {
    typeStatus.textContent = 'Host has blocked remote input.';
    typeStatus.className = 'type-status warn';
    return;
  }

  const delayMs = Number(typeSpeed.value) || 25;
  const maxChars = 100000;
  const payload = text.length > maxChars ? text.slice(0, maxChars) : text;

  sendInput({
    action: 'type-text',
    text: payload,
    delayMs,
    tabWidth: 4,
  });

  typeStatus.textContent = `Sent ${payload.length} characters — typing on host…`;
  typeStatus.className = 'type-status ok';
  typeText.value = '';
});
