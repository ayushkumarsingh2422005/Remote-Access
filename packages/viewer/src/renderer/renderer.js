const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const placeholder = document.getElementById('placeholder');
const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');

let frameW = 0;
let frameH = 0;
let lastFpsAt = Date.now();
let frameCount = 0;
let fps = 0;
let pressedKeys = new Set();

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
  const scaleX = frameW / rect.width;
  const scaleY = frameH / rect.height;
  return {
    x: Math.max(0, Math.min(frameW, (clientX - rect.left) * scaleX)),
    y: Math.max(0, Math.min(frameH, (clientY - rect.top) * scaleY)),
  };
}

function sendInput(event) {
  window.ssRemote.sendInput(event);
}

canvas.addEventListener('mousemove', (e) => {
  const { x, y } = mapCoords(e.clientX, e.clientY);
  sendInput({ action: 'mousemove', x, y });
});

canvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  canvas.focus();
  const { x, y } = mapCoords(e.clientX, e.clientY);
  sendInput({ action: 'mousedown', x, y, button: e.button });
});

canvas.addEventListener('mouseup', (e) => {
  e.preventDefault();
  const { x, y } = mapCoords(e.clientX, e.clientY);
  sendInput({ action: 'mouseup', x, y, button: e.button });
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  sendInput({ action: 'scroll', dy: e.deltaY, deltaY: e.deltaY });
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (document.activeElement !== canvas) return;
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
    canvas.hidden = true;
    placeholder.hidden = false;
    return;
  }

  placeholder.hidden = true;
  canvas.hidden = false;

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
