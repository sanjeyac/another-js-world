import { Engine } from './engine.js';
import { DIR_LEFT, DIR_RIGHT, DIR_UP, DIR_DOWN } from './vm.js';
import { PART_LAST } from './tables.js';
import * as store from './storage.js';
import { readZip } from './zip.js';
import { initI18n, setLanguage, getLanguage, languages, t } from './i18n.js';

const REQUIRED = ['memlist.bin', ...Array.from({ length: 13 }, (_, i) => 'bank' + (i + 1).toString(16).padStart(2, '0'))];
const DEV_DATA_DIRS = ['game/']; // local copy of the game files (git-ignored)
const $ = (id) => document.getElementById(id);

const canvas = $('canvas');
const ctx2d = canvas.getContext('2d', { alpha: false });
const image = ctx2d.createImageData(320, 200);
const pixels = new Uint32Array(image.data.buffer);
const palette = new Uint32Array(16).fill(0xFF000000);

const input = { dirMask: 0, button: false, lastChar: 0, code: false, save: false, load: false };
const charQueue = [];

/** Platform layer handed to the engine. */
const sys = {
  input,
  setPalette(p) {
    for (let i = 0; i < 16; i++) {
      const r = (p[i * 2] & 0x0F) * 17;
      const g = (p[i * 2 + 1] >> 4) * 17;
      const b = (p[i * 2 + 1] & 0x0F) * 17;
      palette[i] = 0xFF000000 | (b << 16) | (g << 8) | r;
    }
  },
  updateDisplay(page) {
    for (let i = 0, o = 0; i < 32000; i++) {
      const v = page[i];
      pixels[o++] = palette[v >> 4];
      pixels[o++] = palette[v & 15];
    }
    ctx2d.putImageData(image, 0, 0);
  },
};

// ---------------------------------------------------------------- state
let files = null;       // Map name -> Uint8Array
let engine = null;
let audio = null;       // { ctx, node }
let muted = false;
let paused = true;
let pendingFrame = false;
let dueAt = 0;
let lastShown = 0;
let saveSlot = 0;

const inPasswordScreen = () => engine && engine.res.currentPartId === PART_LAST;

// ---------------------------------------------------------------- data files
const show = (id, on) => { $(id).hidden = !on; };
const setupStatus = (msg, err = false) => { const s = $('setup-status'); s.textContent = msg; s.classList.toggle('err', err); };

async function loadStoredFiles() {
  const map = new Map();
  for (const name of REQUIRED) {
    const data = await store.getFile(name);
    if (!data) return null;
    map.set(name, new Uint8Array(data));
  }
  return map;
}

async function loadServerFiles() {
  for (const dir of DEV_DATA_DIRS) {
    try {
      const map = new Map();
      for (const name of REQUIRED) {
        const r = await fetch(dir + name);
        if (!r.ok) throw new Error(name);
        map.set(name, new Uint8Array(await r.arrayBuffer()));
      }
      if (map.get('memlist.bin').length < 1000) throw new Error('bad memlist');
      return map;
    } catch { /* try next directory */ }
  }
  return null;
}

/** Ask the browser not to evict the saved game files when it is short on space. */
function keepStorage() {
  navigator.storage?.persist?.().catch(() => {});
}

async function ingestFiles(fileList) {
  const map = new Map();
  try {
    for (const f of fileList) {
      if (/\.zip$/i.test(f.name)) {
        setupStatus(t('setup.reading'));
        for (const [name, data] of await readZip(await f.arrayBuffer())) if (REQUIRED.includes(name)) map.set(name, data);
      } else {
        const name = f.name.toLowerCase().split(/[\\/]/).pop();
        if (REQUIRED.includes(name)) map.set(name, new Uint8Array(await f.arrayBuffer()));
      }
    }
  } catch (err) {
    setupStatus(/^zip\./.test(err.message) ? t(err.message) : String(err.message || err), true);
    return;
  }
  const missing = REQUIRED.filter((n) => !map.has(n));
  if (missing.length) {
    setupStatus(t('setup.missing', { count: missing.length, files: missing.join(', ') }), true);
    return;
  }
  setupStatus(t('setup.saving'));
  let stored = true;
  try {
    for (const [name, data] of map) await store.putFile(name, data);
  } catch (err) {
    console.warn('could not store game files', err);
    stored = false;
  }
  files = map;
  setupStatus('');
  show('setup', false);
  show('start', true);
  if (stored) keepStorage();
  else toast(t('setup.notStored'), 8000);
}

$('file-input').addEventListener('change', (e) => ingestFiles(e.target.files));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); if (!files) ingestFiles(e.dataTransfer.files); });

// ---------------------------------------------------------------- audio
function startAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ latencyHint: 'interactive' });
  const node = ctx.createScriptProcessor(2048, 0, 1);
  node.onaudioprocess = (e) => {
    const out = e.outputBuffer.getChannelData(0);
    if (paused || !engine) { out.fill(0); return; }
    engine.mixer.render(out, out.length);
    if (muted) out.fill(0);
  };
  node.connect(ctx.destination);
  ctx.resume();
  audio = { ctx, node };
}

// ---------------------------------------------------------------- game lifecycle
function newEngine() {
  const e = new Engine(sys, (name) => files.get(name), audio ? audio.ctx.sampleRate : 22050);
  e.saveHandler = async (snap) => {
    try { await store.putSave(saveSlot, snap); rememberSlot(saveSlot); toast(t('toast.saved', { slot: saveSlot })); }
    catch { toast(t('toast.saveFailed')); }
  };
  e.init();
  return e;
}

const LAST_SLOT_KEY = 'another-world-last-slot';
const lastSlot = () => Number(localStorage.getItem(LAST_SLOT_KEY)) || 0;
const rememberSlot = (slot) => { try { localStorage.setItem(LAST_SLOT_KEY, String(slot)); } catch { /* private mode */ } };

function startGame(slot = 0) {
  show('start', false);
  if (!audio) startAudio();
  engine = newEngine();
  if (slot) {
    saveSlot = slot;
    store.getSave(slot).then((snap) => { if (snap && engine) engine.pendingLoad = snap; });
  }
  input.dirMask = 0; input.button = false; input.lastChar = 0;
  resume();
  requestAnimationFrame(loop);
}

function resume() {
  show('menu', false);
  show('pause-label', false);
  $('pause-btn').classList.remove('on');
  paused = false;
  lastShown = performance.now();
  dueAt = lastShown;
  if (audio) audio.ctx.resume();
}

/** Quick pause (top-left button): freezes the game without opening the menu. */
function quickPause() {
  paused = true;
  show('pause-label', true);
  $('pause-btn').classList.add('on');
}

function pause() {
  show('pause-label', false);
  $('pause-btn').classList.remove('on');
  paused = true;
  show('menu', true);
  $('menu-msg').textContent = '';
}

function fail(err) {
  console.error(err);
  paused = true;
  $('error-text').textContent = String(err && err.stack ? err.stack : err);
  show('error', true);
}

function gamepadState() {
  let mask = 0;
  let button = false;
  for (const gp of navigator.getGamepads ? navigator.getGamepads() : []) {
    if (!gp) continue;
    const ax = gp.axes[0] || 0;
    const ay = gp.axes[1] || 0;
    if (ax < -0.5 || gp.buttons[14]?.pressed) mask |= DIR_LEFT;
    if (ax > 0.5 || gp.buttons[15]?.pressed) mask |= DIR_RIGHT;
    if (ay < -0.5 || gp.buttons[12]?.pressed) mask |= DIR_UP;
    if (ay > 0.5 || gp.buttons[13]?.pressed) mask |= DIR_DOWN;
    if (gp.buttons[0]?.pressed || gp.buttons[1]?.pressed || gp.buttons[2]?.pressed || gp.buttons[3]?.pressed) button = true;
  }
  return { mask, button };
}

function loop(now) {
  requestAnimationFrame(loop);
  if (paused || !engine) return;
  try {
    const gp = gamepadState();
    input.dirMask = kbMask | touchMask | gp.mask;
    input.button = kbButton || touchButton || gp.button;

    for (let n = 0; n < 4; n++) {
      if (!pendingFrame) {
        if (input.lastChar === 0 && charQueue.length) input.lastChar = charQueue.shift();
        engine.runFrame();
        pendingFrame = true;
        dueAt = lastShown + engine.frameDelay;
      }
      // Small tolerance so a 50 Hz script runs at full speed on 60 Hz displays.
      if (now < dueAt - 6) break;
      engine.showFrame();
      pendingFrame = false;
      lastShown = now - dueAt > 60 ? now : dueAt;
    }
  } catch (err) {
    fail(err);
  }
}

// ---------------------------------------------------------------- keyboard
let kbMask = 0;
let kbButton = false;
const KEY_DIRS = {
  ArrowLeft: DIR_LEFT, ArrowRight: DIR_RIGHT, ArrowUp: DIR_UP, ArrowDown: DIR_DOWN,
  KeyA: DIR_LEFT, KeyD: DIR_RIGHT, KeyW: DIR_UP, KeyS: DIR_DOWN,
};
const KEY_BUTTONS = new Set(['Space', 'Enter', 'NumpadEnter', 'KeyZ', 'KeyX', 'ControlLeft', 'ShiftLeft']);

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Escape' || (e.code === 'KeyP' && !inPasswordScreen())) {
    if (engine && $('error').hidden) {
      if (e.code === 'KeyP' && $('menu').hidden) { paused ? resume() : quickPause(); } else { paused ? resume() : pause(); }
      e.preventDefault();
    }
    return;
  }
  if (paused || !engine || e.target === kbd) return; // the soft keyboard input handles its own typing
  const typing = inPasswordScreen();
  if (e.code === 'Backspace' && typing) { charQueue.push(8); e.preventDefault(); return; }
  if (typing && /^Key[A-Z]$/.test(e.code)) { charQueue.push(e.code.charCodeAt(3) + 32); e.preventDefault(); return; }
  const dir = KEY_DIRS[e.code];
  if (dir) { kbMask |= dir; e.preventDefault(); }
  else if (KEY_BUTTONS.has(e.code)) { kbButton = true; e.preventDefault(); }
  else if (e.code === 'F5') { startSave(saveSlot || 1); e.preventDefault(); }
  else if (e.code === 'F9') { startLoad(saveSlot || 1); e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  const dir = KEY_DIRS[e.code];
  if (dir) kbMask &= ~dir;
  else if (KEY_BUTTONS.has(e.code)) kbButton = false;
});
window.addEventListener('blur', () => { kbMask = 0; kbButton = false; touchMask = 0; touchButton = false; });
document.addEventListener('visibilitychange', () => { if (document.hidden && engine && !paused) pause(); });

// Soft keyboard for the password screen (mobile): a hidden input that is kept holding a single space,
// so that deleting is detectable even when the field is "empty".
const kbd = $('kbd');
function openSoftKeyboard() { kbd.value = ' '; kbd.focus({ preventScroll: true }); }
kbd.addEventListener('input', () => {
  if (kbd.value.length < 1) charQueue.push(8);
  else for (const ch of kbd.value.trim().toLowerCase()) if (ch >= 'a' && ch <= 'z') charQueue.push(ch.charCodeAt(0));
  kbd.value = ' ';
});
kbd.addEventListener('keydown', (e) => { if (e.key === 'Enter') { kbButton = true; setTimeout(() => { kbButton = false; }, 120); } });

// ---------------------------------------------------------------- touch controls
let touchMask = 0;
let touchButton = false;

// Floating joystick: the whole left band is the touch zone, the origin is where the thumb lands and the drawn d-pad
// moves there. Direction = angle of the drag: horizontal wins over vertical (running), diagonals are wide sectors.
const pad = $('pad');
const dpad = pad.querySelector('.dpad');
let padPointer = -1, padOx = 0, padOy = 0, padRestX = 0, padRestY = 0;

function padPlace() {
  dpad.style.transform = `translate(${padOx - padRestX}px, ${padOy - padRestY}px)`;
}
const landscape = matchMedia('(orientation: landscape)');
const DIRS = [['left', DIR_LEFT], ['right', DIR_RIGHT], ['up', DIR_UP], ['down', DIR_DOWN]];
function padSetMask(m) {
  if (m !== touchMask) navigator.vibrate?.(6);
  touchMask = m;
  for (const [cls, bit] of DIRS) pad.classList.toggle(cls, !!(m & bit));
}

// Portrait: four fixed arrows, direction from the touch position relative to their centre
function padUpdateFixed(e) {
  const r = pad.querySelector('.arrows').getBoundingClientRect();
  const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
  const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
  let m = 0;
  if (dx < -0.3) m |= DIR_LEFT;
  if (dx > 0.3) m |= DIR_RIGHT;
  if (dy < -0.3) m |= DIR_UP;
  if (dy > 0.3) m |= DIR_DOWN;
  padSetMask(m);
}

function padUpdate(e) {
  if (!landscape.matches) return padUpdateFixed(e);
  const btn = dpad.querySelector('.knob').getBoundingClientRect().width || 40;
  let dx = e.clientX - padOx, dy = e.clientY - padOy;
  const dist = Math.hypot(dx, dy);
  const maxR = btn * 1.5; // max drag radius: 1.5 buttons
  if (dist > maxR) { // the thumb went far: drag the origin along so reversing direction stays quick
    padOx += dx * (1 - maxR / dist); padOy += dy * (1 - maxR / dist);
    dx = e.clientX - padOx; dy = e.clientY - padOy;
    padPlace();
  }
  dpad.style.setProperty('--kx', dx + 'px'); dpad.style.setProperty('--ky', dy + 'px');
  let m = 0;
  const d = Math.hypot(dx, dy);
  if (d > btn * 0.4) {
    if (Math.abs(dx) / d > 0.35) m |= dx < 0 ? DIR_LEFT : DIR_RIGHT;
    if (Math.abs(dy) / d > 0.5) m |= dy < 0 ? DIR_UP : DIR_DOWN;
  }
  padSetMask(m);
}
function padRelease(e) {
  if (e && e.pointerId !== padPointer) return;
  padPointer = -1;
  touchMask = 0;
  pad.classList.remove('left', 'right', 'up', 'down');
  dpad.style.transform = '';
  dpad.style.removeProperty('--kx'); dpad.style.removeProperty('--ky');
  pad.classList.remove('on');
}
pad.addEventListener('pointerdown', (e) => {
  if (padPointer !== -1) return;
  padPointer = e.pointerId;
  pad.classList.add('on');
  pad.setPointerCapture(e.pointerId);
  dpad.style.transform = '';
  const r = dpad.getBoundingClientRect(); // zero-sized in portrait, where the arrows are used
  padRestX = r.left + r.width / 2; padRestY = r.top + r.height / 2;
  padOx = e.clientX; padOy = e.clientY;
  padPlace();
  padUpdate(e);
  e.preventDefault();
});
pad.addEventListener('pointermove', (e) => { if (e.pointerId === padPointer) padUpdate(e); });
for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(t, padRelease);

const action = $('action');
const setButton = (on) => { touchButton = on; action.classList.toggle('down', on); };
action.addEventListener('pointerdown', (e) => { action.setPointerCapture(e.pointerId); setButton(true); e.preventDefault(); });
for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) action.addEventListener(t, () => setButton(false));

window.addEventListener('contextmenu', (e) => e.preventDefault());
$('menu-btn').addEventListener('click', () => { if (engine) pause(); });
$('pause-btn').addEventListener('click', () => {
  if (!engine || !$('error').hidden) return;
  if (!paused) quickPause();
  else if ($('menu').hidden) resume();
});

if (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) { $('controls').hidden = false; $('app').classList.add('touch'); }
else $('app').classList.add('desktop');

// ---------------------------------------------------------------- menu
let toastTimer = 0;
function toast(msg, ms = 1800) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

function startSave(slot) {
  saveSlot = slot;
  input.save = true; // handled at the start of the next VM frame, where the state is consistent
}

async function startLoad(slot) {
  const snap = await store.getSave(slot);
  if (!snap) { toast(t('toast.empty', { slot })); return false; }
  engine.pendingLoad = snap;
  toast(t('toast.loaded', { slot }));
  return true;
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    await screen.orientation?.lock?.('landscape');
  } catch { /* not supported (e.g. iPhone Safari) */ }
}

const APP_VERSION = document.querySelector('meta[name=app-version]')?.content || 'dev';
const updateVersionLabel = () => { $('version').textContent = t('start.version', { sha: APP_VERSION }); };
document.addEventListener('languagechange', updateVersionLabel);

const updateMuteLabel = () => { $('mute-state').textContent = t(muted ? 'menu.off' : 'menu.on'); };

// Language selector: one entry per language listed in i18n/languages.json
function buildLanguageSelect() {
  const sel = $('lang-select');
  sel.replaceChildren(...Object.entries(languages).map(([code, name]) => new Option(name, code)));
  sel.value = getLanguage();
  sel.addEventListener('change', () => setLanguage(sel.value));
}
document.addEventListener('languagechange', updateMuteLabel);

// Both the start screen and the menu have a fullscreen button; hide them where the API does not exist.
if (!document.documentElement.requestFullscreen) for (const b of document.querySelectorAll('[data-act=fullscreen]')) b.hidden = true;
$('start-fs').addEventListener('click', toggleFullscreen);

let forgetTimer = 0;
function disarmForget() {
  const b = document.querySelector('[data-act=forget]');
  b.classList.remove('armed');
  b.textContent = t('menu.forget');
}

$('menu').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const slot = Number(btn.dataset.slot);
  switch (btn.dataset.act) {
    case 'resume': resume(); break;
    case 'save': startSave(slot); resume(); break;
    case 'load': if (await startLoad(slot)) resume(); else $('menu-msg').textContent = t('toast.empty', { slot }); break;
    case 'code':
      input.code = true;
      resume();
      openSoftKeyboard();
      break;
    case 'mute':
      muted = !muted;
      updateMuteLabel();
      break;
    case 'fullscreen': await toggleFullscreen(); break;
    case 'restart':
      pendingFrame = false;
      engine.mixer.stopAll();
      engine = newEngine();
      resume();
      break;
    case 'forget':
      // Two taps instead of confirm(): mobile browsers can suppress native dialogs
      if (!btn.classList.contains('armed')) {
        btn.classList.add('armed');
        btn.textContent = t('confirm.forget');
        clearTimeout(forgetTimer);
        forgetTimer = setTimeout(disarmForget, 4000);
        break;
      }
      try { await store.clearFiles(); } catch (err) { console.warn('clear failed', err); }
      location.reload();
      break;
  }
});
$('start-btn').addEventListener('click', () => startGame());
$('continue-btn').addEventListener('click', () => startGame(lastSlot()));

// ---------------------------------------------------------------- boot
(async function boot() {
  await initI18n();
  buildLanguageSelect();
  if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try {
    files = await loadStoredFiles();
    if (!files) {
      files = await loadServerFiles();
      // files served next to the page (game/) cannot be removed from here
      if (files) document.querySelector('[data-act=forget]').hidden = true;
    }
  } catch (err) {
    console.warn('data lookup failed', err);
  }
  if (!files) { show('boot', false); show('setup', true); return; }
  keepStorage();
  try {
    const slot = lastSlot();
    if (slot && await store.getSave(slot)) {
      const label = () => { $('continue-btn').textContent = t('start.continue', { slot }); };
      label();
      document.addEventListener('languagechange', label);
      show('continue-btn', true);
    }
  } catch { /* no saves available */ }
  show('boot', false);
  show('start', true);
}());
