// Редактор: просмотр страниц и рукописные пометки стилусом.
import * as db from './db.js';
import { drawBackground, drawItems, drawStroke, textBounds, renderPageToCanvas } from './render.js';
import { touchScore, staffPage, appendFilePages, printScore, editInfo, popupMenu } from './library.js';
import { $, el, modal, confirmDialog, toast, pickFiles, busy } from './ui.js';

const PEN_COLORS = ['#1b1b1b', '#1f4fd1', '#d12a2a', '#1d8a3a', '#e07b00', '#7b2fbf'];
const HL_COLORS = ['#ffe600', '#7cff4f', '#ff6ec7', '#4fd8ff', '#ffa94f'];
const TEXT_COLORS = PEN_COLORS;

// Штампы: типичные обозначения для пометок в нотах
const STAMPS = [
  { group: 'Динамика', items: ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sfz', 'fp'].map((t) => ({ txt: t, italic: true, bold: true, font: 'serif' })) },
  { group: 'Темп и характер', items: ['cresc.', 'dim.', 'rit.', 'rall.', 'accel.', 'a tempo', 'dolce', 'legato', 'stacc.'].map((t) => ({ txt: t, italic: true, font: 'serif', scale: 0.8 })) },
  { group: 'Знаки', items: ['♯', '♭', '♮', '♩', '♪', '♫', '>', '∨', '’', '×', '8va', 'Ped.', '✱', '?', '!', '◯'].map((t) => ({ txt: t, font: 'serif' })) },
  { group: 'Аппликатура', items: ['1', '2', '3', '4', '5'].map((t) => ({ txt: t, bold: true, font: 'sans', scale: 0.75 })) },
];

const SIZES = {
  pen: [0.0012, 0.002, 0.003, 0.0045, 0.007],
  hl: [0.008, 0.013, 0.02, 0.03],
  text: [0.018, 0.025, 0.033, 0.045, 0.06],
};

const settings = loadSettings();
function loadSettings() {
  const defaults = {
    tool: 'pen', penColor: PEN_COLORS[0], hlColor: HL_COLORS[0], textColor: PEN_COLORS[2],
    penSize: 1, hlSize: 1, textSize: 2, stylusOnly: null, stamp: STAMPS[0].items[4],
  };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('editor-settings') || '{}') }; } catch { return defaults; }
}
function saveSettings() { localStorage.setItem('editor-settings', JSON.stringify(settings)); }

// ---------- Состояние ----------
let score = null;
let pages = [];
let index = 0;
let zoom = 1; // 1 = страница целиком помещается на экране
let perfMode = false;
const history = new Map(); // pageId -> {undo: [], redo: []}
let saveTimer = null;
let thumbTimer = null;
let renderTimer = null;
let renderToken = 0;
let wakeLock = null;
const bgCache = new Map(); // `${pageId}:${width}` -> canvas
let onExit = () => {};

let stage, wrap, pageEl, bgCanvas, inkCanvas, liveCanvas;
let pageCssW = 0, pageCssH = 0;

export function initEditor({ exit }) {
  onExit = exit;
  stage = $('#stage');
  wrap = $('#page-wrap');
  pageEl = $('#page');
  bgCanvas = $('#bg-canvas');
  inkCanvas = $('#ink-canvas');
  liveCanvas = $('#live-canvas');

  $('#btn-back').addEventListener('click', () => closeEditor());
  $('#btn-prev').addEventListener('click', () => goTo(index - 1));
  $('#btn-next').addEventListener('click', () => goTo(index + 1));
  $('#page-indicator').addEventListener('click', togglePanel);
  $('#btn-pages').addEventListener('click', togglePanel);
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-zoom-in').addEventListener('click', () => zoomAt(zoom * 1.25));
  $('#btn-zoom-out').addEventListener('click', () => zoomAt(zoom / 1.25));
  $('#btn-fit').addEventListener('click', fitCycle);
  $('#btn-perf').addEventListener('click', () => setPerfMode(true));
  $('#btn-perf-exit').addEventListener('click', () => setPerfMode(false));
  $('#btn-more').addEventListener('click', (e) => moreMenu(e.currentTarget));
  $('#editor-title').addEventListener('click', async () => {
    if (await editInfo(score)) { score = await db.get('scores', score.id); $('#editor-title').textContent = score.title; }
  });
  $('#panel-close').addEventListener('click', togglePanel);
  $('#panel-add').addEventListener('click', (e) => addPageMenu(e.currentTarget));

  document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.tool === settings.tool && ['pen', 'hl', 'text', 'stamp'].includes(b.dataset.tool)) openToolOptions(b);
    else setTool(b.dataset.tool);
  }));
  $('#stylus-toggle').addEventListener('click', () => setStylusOnly(!settings.stylusOnly, true));

  setupPointer();
  window.addEventListener('resize', () => { if (score) layout(true); });
  window.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
    else if (perfMode) requestWakeLock();
  });
  window.addEventListener('pagehide', flushSave);
  updateToolUI();
}

export async function openEditor(scoreId) {
  score = await db.get('scores', scoreId);
  if (!score) return false;
  pages = await db.getPages(scoreId);
  if (!pages.length) {
    pages = [staffPage(scoreId, 0)];
    await db.put('pages', pages[0]);
  }
  history.clear();
  bgCache.clear();
  index = Math.min(score.lastPage || 0, pages.length - 1);
  zoom = 1;
  $('#editor-title').textContent = score.title;
  await touchScore(score.id, { openedAt: Date.now() });
  $('#panel').classList.remove('open');
  updateToolUI();
  layout();
  renderPanel();
  return true;
}

function closeEditor() { onExit(); }

// Вызывается при уходе из редактора (кнопка «назад» или навигация браузера)
export async function leaveEditor() {
  if (!score) return;
  const s = score;
  await flushSave();
  if (perfMode) setPerfMode(false);
  closePopovers();
  score = null;
  pages = [];
  bgCache.clear();
  await touchScore(s.id, { lastPage: s._lastIndex ?? 0 }, { thumb: true });
}

const page = () => pages[index];

// ---------- Раскладка и отрисовка ----------
function layout(keepCenter = false) {
  const p = page();
  if (!p) return;
  const pad = perfMode ? 0 : 12;
  const sw = stage.clientWidth - pad * 2;
  const sh = stage.clientHeight - pad * 2;
  const fitW = Math.min(sw, sh / p.aspect);
  const oldW = pageCssW;
  // центр видимой области в долях страницы, чтобы сохранить позицию при изменении размеров
  const cx = keepCenter && oldW ? (stage.scrollLeft + stage.clientWidth / 2 - pageEl.offsetLeft) / oldW : null;
  const cy = keepCenter && oldW ? (stage.scrollTop + stage.clientHeight / 2 - pageEl.offsetTop) / oldW : null;
  pageCssW = Math.max(50, fitW * zoom);
  pageCssH = pageCssW * p.aspect;
  wrap.style.padding = pad + 'px';
  for (const c of [pageEl, bgCanvas, inkCanvas, liveCanvas]) {
    c.style.width = pageCssW + 'px';
    c.style.height = pageCssH + 'px';
  }
  if (cx != null) {
    stage.scrollLeft = cx * pageCssW + pageEl.offsetLeft - stage.clientWidth / 2;
    stage.scrollTop = cy * pageCssW + pageEl.offsetTop - stage.clientHeight / 2;
  } else {
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
  }
  updateIndicator();
  scheduleRender(oldW === 0 || !keepCenter ? 0 : 180);
}

function pixelWidth() {
  const dpr = window.devicePixelRatio || 1;
  let w = Math.round(pageCssW * dpr);
  const aspect = page().aspect;
  const MAX_AREA = 14e6; // ограничение площади canvas на планшетах
  if (w * w * aspect > MAX_AREA) w = Math.floor(Math.sqrt(MAX_AREA / aspect));
  return Math.max(1, w);
}

function scheduleRender(delay) {
  clearTimeout(renderTimer);
  if (delay) renderTimer = setTimeout(renderPage, delay);
  else renderPage();
}

async function getBg(p, w) {
  const key = p.id + ':' + w;
  if (bgCache.has(key)) return bgCache.get(key);
  const h = Math.round(w * p.aspect);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const promise = drawBackground(c.getContext('2d'), w, h, p).then(() => c);
  bgCache.set(key, promise);
  if (bgCache.size > 4) bgCache.delete(bgCache.keys().next().value);
  promise.catch(() => bgCache.delete(key));
  return promise;
}

async function renderPage() {
  const token = ++renderToken;
  const p = page();
  const w = pixelWidth();
  const h = Math.round(w * p.aspect);
  renderInk(w, h);
  try {
    const bg = await getBg(p, w);
    if (token !== renderToken) return;
    bgCanvas.width = w;
    bgCanvas.height = h;
    bgCanvas.getContext('2d').drawImage(bg, 0, 0);
  } catch (e) {
    console.error(e);
    toast('Не удалось отрисовать страницу');
  }
  // Заранее готовим соседние страницы для быстрого перелистывания
  if (token === renderToken) {
    for (const j of [index + 1, index - 1]) {
      const q = pages[j];
      if (q && Math.abs(q.aspect - p.aspect) < 0.01) getBg(q, w).catch(() => {});
    }
  }
}

function renderInk(w = inkCanvas.width, h = inkCanvas.height) {
  if (inkCanvas.width !== w || inkCanvas.height !== h) {
    inkCanvas.width = w; inkCanvas.height = h;
    liveCanvas.width = w; liveCanvas.height = h;
  }
  const ctx = inkCanvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  drawItems(ctx, page().items || [], w);
}

function updateIndicator() {
  if (score) score._lastIndex = index;
  $('#page-indicator').textContent = `${index + 1} / ${pages.length}`;
  $('#perf-indicator').textContent = `${index + 1} / ${pages.length}`;
  $('#btn-prev').disabled = index === 0;
  $('#btn-next').disabled = index >= pages.length - 1;
  const h = history.get(page().id);
  $('#btn-undo').disabled = !h || !h.undo.length;
  $('#btn-redo').disabled = !h || !h.redo.length;
  document.querySelectorAll('.thumb-item').forEach((t) => t.classList.toggle('current', Number(t.dataset.index) === index));
}

function goTo(i, { fromEnd = false } = {}) {
  if (i < 0 || i >= pages.length || i === index) return;
  cancelStroke();
  flushSave();
  index = i;
  zoom = zoom > 1.01 ? zoom : 1;
  layout();
  if (fromEnd) stage.scrollTop = stage.scrollHeight;
  const cur = document.querySelector('.thumb-item.current');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

function zoomAt(z, clientX, clientY) {
  z = Math.max(1, Math.min(6, z));
  if (Math.abs(z - zoom) < 0.001) return;
  const r = stage.getBoundingClientRect();
  const fx = clientX ?? r.left + r.width / 2;
  const fy = clientY ?? r.top + r.height / 2;
  // точка страницы под пальцами
  const px = (stage.scrollLeft + fx - r.left - pageEl.offsetLeft) / pageCssW;
  const py = (stage.scrollTop + fy - r.top - pageEl.offsetTop) / pageCssW;
  zoom = z;
  const oldW = pageCssW;
  layout(false);
  stage.scrollLeft = px * pageCssW + pageEl.offsetLeft - (fx - r.left);
  stage.scrollTop = py * pageCssW + pageEl.offsetTop - (fy - r.top);
  if (oldW) scheduleRender(220);
}

function fitCycle() {
  // По ширине ↔ страница целиком
  const p = page();
  const pad = 24;
  const fitPage = Math.min(stage.clientWidth - pad, (stage.clientHeight - pad) / p.aspect);
  const widthZoom = (stage.clientWidth - pad) / fitPage;
  zoom = zoom > 1.01 || widthZoom < 1.05 ? 1 : widthZoom;
  layout();
}

// ---------- Инструменты ----------
function setTool(tool) {
  settings.tool = tool;
  saveSettings();
  updateToolUI();
}

function currentColor() {
  if (settings.tool === 'hl') return settings.hlColor;
  if (settings.tool === 'text' || settings.tool === 'stamp') return settings.textColor;
  return settings.penColor;
}

function updateToolUI() {
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === settings.tool));
  const sw = $('#tool-color');
  if (sw) sw.style.background = currentColor();
  $('#stylus-toggle').classList.toggle('active', !!settings.stylusOnly);
  $('#stylus-toggle').title = settings.stylusOnly ? 'Рисует только стилус, пальцем — листать и масштабировать' : 'Рисуют и стилус, и палец';
  stage && stage.setAttribute('data-tool', settings.tool);
  const stampBtn = document.querySelector('[data-tool="stamp"] .stamp-preview');
  if (stampBtn) stampBtn.textContent = settings.stamp.txt;
}

function setStylusOnly(on, announce) {
  settings.stylusOnly = on;
  saveSettings();
  updateToolUI();
  if (announce) toast(on ? 'Режим стилуса: рисует только стилус, пальцем — листать и масштабировать' : 'Рисовать можно и пальцем');
}

function openToolOptions(anchor) {
  const tool = settings.tool;
  const colors = tool === 'hl' ? HL_COLORS : tool === 'pen' ? PEN_COLORS : TEXT_COLORS;
  const colorKey = tool === 'hl' ? 'hlColor' : tool === 'pen' ? 'penColor' : 'textColor';
  const sizeKey = tool === 'hl' ? 'hlSize' : tool === 'pen' ? 'penSize' : 'textSize';
  const sizes = SIZES[tool === 'stamp' ? 'text' : tool];
  closePopovers();
  const pop = el('div', { class: 'popover' });
  pop.append(el('div', { class: 'pop-label' }, 'Цвет'));
  const row = el('div', { class: 'swatches' });
  for (const c of colors) {
    row.append(el('button', {
      class: 'swatch' + (settings[colorKey] === c ? ' active' : ''), style: `background:${c}`, 'aria-label': c,
      onclick: (ev) => {
        settings[colorKey] = c; saveSettings(); updateToolUI();
        row.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', b === ev.currentTarget));
      },
    }));
  }
  const custom = el('input', { type: 'color', value: settings[colorKey], class: 'swatch custom', title: 'Свой цвет' });
  custom.addEventListener('input', () => { settings[colorKey] = custom.value; saveSettings(); updateToolUI(); });
  row.append(custom);
  pop.append(row);
  pop.append(el('div', { class: 'pop-label' }, tool === 'text' || tool === 'stamp' ? 'Размер' : 'Толщина'));
  const sizeRow = el('div', { class: 'sizes' });
  sizes.forEach((s, i) => {
    const dot = el('span', { class: 'size-dot', style: `width:${6 + i * 5}px;height:${6 + i * 5}px` });
    sizeRow.append(el('button', {
      class: 'size-btn' + (settings[sizeKey] === i ? ' active' : ''),
      onclick: () => { settings[sizeKey] = i; saveSettings(); sizeRow.querySelectorAll('.size-btn').forEach((b, j) => b.classList.toggle('active', j === i)); },
    }, dot));
  });
  pop.append(sizeRow);
  if (tool === 'stamp') {
    for (const g of STAMPS) {
      pop.append(el('div', { class: 'pop-label' }, g.group));
      const grid = el('div', { class: 'stamps' });
      for (const s of g.items) {
        grid.append(el('button', {
          class: 'stamp-btn' + (settings.stamp.txt === s.txt ? ' active' : ''),
          style: `font-style:${s.italic ? 'italic' : 'normal'};font-weight:${s.bold ? 'bold' : 'normal'};font-family:${s.font === 'sans' ? 'system-ui,sans-serif' : '"Times New Roman",Georgia,serif'}`,
          onclick: () => { settings.stamp = s; saveSettings(); updateToolUI(); closePopovers(); },
        }, s.txt));
      }
      pop.append(grid);
    }
  }
  document.body.append(pop);
  positionPopover(pop, anchor);
}

function positionPopover(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
  pop.style.top = r.bottom + 8 + 'px';
  pop.style.maxHeight = window.innerHeight - r.bottom - 24 + 'px';
  setTimeout(() => document.addEventListener('pointerdown', function h(e) {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', h); }
  }), 0);
}

function closePopovers() { document.querySelectorAll('.popover').forEach((p) => p.remove()); }

// ---------- История и сохранение ----------
function hist() {
  const id = page().id;
  if (!history.has(id)) history.set(id, { undo: [], redo: [] });
  return history.get(id);
}

function commit(newItems) {
  const p = page();
  const h = hist();
  h.undo.push(p.items || []);
  if (h.undo.length > 100) h.undo.shift();
  h.redo = [];
  p.items = newItems;
  changed();
}

let panelThumbTimer = null;
function changed() {
  renderInk();
  updateIndicator();
  scheduleSave();
  clearTimeout(panelThumbTimer);
  const i = index;
  panelThumbTimer = setTimeout(() => refreshThumb(i), 800);
}

function undo() {
  const h = hist();
  if (!h.undo.length) return;
  h.redo.push(page().items);
  page().items = h.undo.pop();
  changed();
}

function redo() {
  const h = hist();
  if (!h.redo.length) return;
  h.undo.push(page().items);
  page().items = h.redo.pop();
  changed();
}

const dirty = new Set();
function scheduleSave() {
  dirty.add(page());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty.size || !score) return;
  const list = [...dirty];
  dirty.clear();
  try {
    await db.putMany(list.map((p) => ['pages', p]));
    const firstChanged = list.some((p) => p.order === 0 || p === pages[0]);
    clearTimeout(thumbTimer);
    const id = score.id;
    if (firstChanged) thumbTimer = setTimeout(() => touchScore(id, { lastPage: index }, { thumb: true }), 1500);
    else await touchScore(id, { lastPage: index });
  } catch (e) {
    console.error(e);
    toast('Ошибка сохранения!');
  }
}

// ---------- Ввод: стилус, палец, мышь ----------
const pointers = new Map(); // pointerId -> {x, y, type, startX, startY, t}
let stroke = null; // текущий штрих
let erasing = null; // {removed: Set}
let dragText = null; // {item, dx, dy, orig}
let gesture = null; // {type:'pan'|'pinch', ...}
let lastTap = 0;

function toPage(e) {
  const r = pageEl.getBoundingClientRect();
  return { x: (e.clientX - r.left) / pageCssW, y: (e.clientY - r.top) / pageCssW };
}

function isDrawingPointer(e) {
  if (perfMode || settings.tool === 'hand') return false;
  if (e.pointerType === 'pen') return true;
  if (e.pointerType === 'mouse') return e.button === 0;
  return !settings.stylusOnly;
}

function setupPointer() {
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onCancel);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomAt(zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    }
  }, { passive: false });
  // Safari: жест масштабирования трекпадом
  stage.addEventListener('gesturestart', (e) => e.preventDefault());
}

function onDown(e) {
  if (e.pointerType === 'pen' && settings.stylusOnly == null) setStylusOnly(true, true);
  closePopovers();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType, startX: e.clientX, startY: e.clientY, t: performance.now() });
  try { stage.setPointerCapture(e.pointerId); } catch {}

  const touches = [...pointers.values()].filter((p) => p.type === 'touch');
  if (e.pointerType === 'touch' && touches.length === 2) {
    // второй палец: отменяем начатый пальцем штрих и начинаем масштабирование
    if (stroke && stroke.pointerType === 'touch') cancelStroke();
    if (erasing && erasing.pointerType === 'touch') { finishErase(); }
    startPinch();
    return;
  }
  if (gesture && gesture.type === 'pinch') return;

  if (isDrawingPointer(e) && !stroke && !erasing && !dragText) {
    e.preventDefault();
    startTool(e);
  } else if (!isDrawingPointer(e) && !stroke) {
    gesture = { type: 'pan', id: e.pointerId, sl: stage.scrollLeft, st: stage.scrollTop, x: e.clientX, y: e.clientY, t: performance.now() };
  }
}

function onMove(e) {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX;
  p.y = e.clientY;
  if (gesture && gesture.type === 'pinch' && gesture.ids.includes(e.pointerId)) { movePinch(); return; }
  if (stroke && stroke.pointerId === e.pointerId) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) addPoint(ev);
    drawLive();
    return;
  }
  if (erasing && erasing.pointerId === e.pointerId) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) eraseAt(ev);
    return;
  }
  if (dragText && dragText.pointerId === e.pointerId) {
    const pt = toPage(e);
    dragText.item.x = pt.x - dragText.dx;
    dragText.item.y = pt.y - dragText.dy;
    dragText.moved = true;
    renderInk();
    return;
  }
  if (gesture && gesture.type === 'pan' && gesture.id === e.pointerId) {
    stage.scrollLeft = gesture.sl - (e.clientX - gesture.x);
    stage.scrollTop = gesture.st - (e.clientY - gesture.y);
  }
}

function onUp(e) {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (gesture && gesture.type === 'pinch') {
    if (gesture.ids.includes(e.pointerId)) {
      scheduleRender(0);
      const rest = [...pointers.entries()].find(([, q]) => q.type === 'touch');
      gesture = rest ? { type: 'pan', id: rest[0], sl: stage.scrollLeft, st: stage.scrollTop, x: rest[1].x, y: rest[1].y, t: performance.now(), noTap: true } : null;
    }
    return;
  }
  if (stroke && stroke.pointerId === e.pointerId) { finishStroke(); return; }
  if (erasing && erasing.pointerId === e.pointerId) { finishErase(); return; }
  if (dragText && dragText.pointerId === e.pointerId) { finishDragText(); return; }
  if (gesture && gesture.type === 'pan' && gesture.id === e.pointerId && p) {
    endPan(e, p);
    gesture = null;
  }
}

function onCancel(e) {
  pointers.delete(e.pointerId);
  if (stroke && stroke.pointerId === e.pointerId) cancelStroke();
  if (erasing && erasing.pointerId === e.pointerId) finishErase();
  if (dragText && dragText.pointerId === e.pointerId) finishDragText();
  if (gesture && (gesture.id === e.pointerId || (gesture.ids && gesture.ids.includes(e.pointerId)))) gesture = null;
}

function endPan(e, p) {
  const dx = e.clientX - p.startX;
  const dy = e.clientY - p.startY;
  const dt = performance.now() - p.t;
  const canScrollX = stage.scrollWidth > stage.clientWidth + 2;
  // Быстрый горизонтальный свайп — перелистывание
  if (!canScrollX && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 600) {
    goTo(dx < 0 ? index + 1 : index - 1);
    return;
  }
  // Касание (тап)
  if (!gesture.noTap && Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 350) {
    const now = performance.now();
    if (now - lastTap < 320) {
      lastTap = 0;
      zoom = zoom > 1.01 ? 1 : 2;
      if (zoom === 1) layout(); else zoomAt(2.0001, e.clientX, e.clientY);
      return;
    }
    lastTap = now;
    const r = stage.getBoundingClientRect();
    const rel = (e.clientX - r.left) / r.width;
    if (rel > 0.7) setTimeout(() => { if (lastTap === now) goTo(index + 1); }, 330);
    else if (rel < 0.3) setTimeout(() => { if (lastTap === now) goTo(index - 1); }, 330);
  }
}

function startPinch() {
  const ids = [...pointers.entries()].filter(([, p]) => p.type === 'touch').slice(0, 2).map(([id]) => id);
  const [a, b] = ids.map((id) => pointers.get(id));
  gesture = {
    type: 'pinch', ids,
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
  };
  const r = stage.getBoundingClientRect();
  gesture.px = (stage.scrollLeft + gesture.mx - r.left - pageEl.offsetLeft) / pageCssW;
  gesture.py = (stage.scrollTop + gesture.my - r.top - pageEl.offsetTop) / pageCssW;
}

function movePinch() {
  const [a, b] = gesture.ids.map((id) => pointers.get(id));
  if (!a || !b) return;
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const z = Math.max(1, Math.min(6, gesture.zoom * d / gesture.dist));
  const r = stage.getBoundingClientRect();
  if (Math.abs(z - zoom) > 0.002) {
    zoom = z;
    const p = page();
    const pad = perfMode ? 0 : 12;
    const fitW = Math.min(stage.clientWidth - pad * 2, (stage.clientHeight - pad * 2) / p.aspect);
    pageCssW = fitW * zoom;
    pageCssH = pageCssW * p.aspect;
    for (const c of [pageEl, bgCanvas, inkCanvas, liveCanvas]) { c.style.width = pageCssW + 'px'; c.style.height = pageCssH + 'px'; }
    scheduleRender(250);
  }
  stage.scrollLeft = gesture.px * pageCssW + pageEl.offsetLeft - (mx - r.left);
  stage.scrollTop = gesture.py * pageCssW + pageEl.offsetTop - (my - r.top);
}

// ---- Рисование ----
function startTool(e) {
  const tool = settings.tool;
  const pt = toPage(e);
  if (tool === 'pen' || tool === 'hl') {
    const sizes = SIZES[tool];
    stroke = {
      pointerId: e.pointerId, pointerType: e.pointerType,
      item: { t: 'stroke', tool, c: tool === 'hl' ? settings.hlColor : settings.penColor, w: sizes[Math.min(sizes.length - 1, tool === 'hl' ? settings.hlSize : settings.penSize)], pts: [] },
    };
    addPoint(e);
    drawLive();
  } else if (tool === 'eraser') {
    erasing = { pointerId: e.pointerId, pointerType: e.pointerType, removed: new Set() };
    eraseAt(e);
  } else if (tool === 'text' || tool === 'stamp') {
    const hit = hitText(pt);
    if (hit) {
      dragText = { pointerId: e.pointerId, item: hit, dx: pt.x - hit.x, dy: pt.y - hit.y, orig: { x: hit.x, y: hit.y }, moved: false, before: page().items.map((i) => i) };
    } else if (tool === 'stamp') {
      const s = settings.stamp;
      const size = SIZES.text[Math.min(SIZES.text.length - 1, settings.textSize)] * (s.scale || 1);
      commit([...(page().items || []), { t: 'text', x: pt.x, y: pt.y, s: size, c: settings.textColor, txt: s.txt, italic: !!s.italic, bold: !!s.bold, font: s.font || 'serif' }]);
    } else {
      pointers.delete(e.pointerId);
      addTextDialog(pt);
    }
  }
}

function addPoint(e) {
  const pt = toPage(e);
  let pr = e.pointerType === 'pen' ? e.pressure : 0.5;
  if (!pr && e.pointerType === 'pen') pr = 0.5;
  const pts = stroke.item.pts;
  const n = pts.length;
  if (n >= 3) {
    const dx = pt.x - pts[n - 3], dy = pt.y - pts[n - 2];
    if (dx * dx + dy * dy < (0.6 / pageCssW) ** 2) return; // слишком близко к предыдущей точке
  }
  pts.push(round(pt.x), round(pt.y), Math.round(pr * 100) / 100);
}

const round = (v) => Math.round(v * 1e5) / 1e5;

function drawLive() {
  const ctx = liveCanvas.getContext('2d');
  ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
  drawStroke(ctx, stroke.item, liveCanvas.width);
}

function finishStroke() {
  const item = stroke.item;
  stroke = null;
  liveCanvas.getContext('2d').clearRect(0, 0, liveCanvas.width, liveCanvas.height);
  if (item.pts.length) commit([...(page().items || []), item]);
}

function cancelStroke() {
  if (!stroke) return;
  stroke = null;
  liveCanvas.getContext('2d').clearRect(0, 0, liveCanvas.width, liveCanvas.height);
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function eraseAt(e) {
  // Проходим по пути ластика с маленьким шагом, чтобы не пропускать штрихи при быстром движении
  const pt = toPage(e);
  const last = erasing.last;
  erasing.last = pt;
  if (last) {
    const step = 6 / pageCssW;
    const d = Math.hypot(pt.x - last.x, pt.y - last.y);
    const n = Math.min(200, Math.floor(d / step));
    for (let i = 1; i <= n; i++) eraseAtPoint({ x: last.x + (pt.x - last.x) * i / (n + 1), y: last.y + (pt.y - last.y) * i / (n + 1) }, e.pointerType);
  }
  eraseAtPoint(pt, e.pointerType);
}

function eraseAtPoint(pt, pointerType) {
  const e = { pointerType };
  const r = (e.pointerType === 'pen' ? 10 : 16) / pageCssW;
  const items = page().items || [];
  const ctx = inkCanvas.getContext('2d');
  let hit = false;
  for (const it of items) {
    if (erasing.removed.has(it)) continue;
    if (it.t === 'text') {
      const b = textBounds(ctx, it);
      if (pt.x > b.x0 - r && pt.x < b.x1 + r && pt.y > b.y0 - r && pt.y < b.y1 + r) { erasing.removed.add(it); hit = true; }
      continue;
    }
    const pts = it.pts;
    const rr = r + it.w / 2;
    if (pts.length === 3) {
      if (Math.hypot(pt.x - pts[0], pt.y - pts[1]) < rr) { erasing.removed.add(it); hit = true; }
      continue;
    }
    for (let i = 3; i < pts.length; i += 3) {
      if (distToSeg(pt.x, pt.y, pts[i - 3], pts[i - 2], pts[i], pts[i + 1]) < rr) { erasing.removed.add(it); hit = true; break; }
    }
  }
  if (hit) {
    const ctx2 = inkCanvas.getContext('2d');
    ctx2.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
    drawItems(ctx2, items.filter((i) => !erasing.removed.has(i)), inkCanvas.width);
  }
}

function finishErase() {
  const removed = erasing.removed;
  erasing = null;
  if (removed.size) commit(page().items.filter((i) => !removed.has(i)));
}

function hitText(pt) {
  const items = page().items || [];
  const ctx = inkCanvas.getContext('2d');
  const pad = 6 / pageCssW;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.t !== 'text') continue;
    const b = textBounds(ctx, it);
    if (pt.x > b.x0 - pad && pt.x < b.x1 + pad && pt.y > b.y0 - pad && pt.y < b.y1 + pad) return it;
  }
  return null;
}

function finishDragText() {
  const d = dragText;
  dragText = null;
  if (d.moved) {
    // Фиксируем перемещение в истории: восстанавливаем копию «до» для отмены
    const moved = { ...d.item };
    d.item.x = d.orig.x; d.item.y = d.orig.y;
    commit(page().items.map((i) => (i === d.item ? moved : i)));
  } else {
    editTextDialog(d.item);
  }
}

async function addTextDialog(pt) {
  const r = await modal({
    title: 'Текст', okText: 'Добавить',
    fields: [
      { name: 'txt', label: 'Текст пометки', type: 'textarea', value: '' },
      { name: 'style', label: 'Начертание', type: 'select', value: 'italic', options: [
        { value: 'italic', label: 'Курсив (как в нотах)' }, { value: 'normal', label: 'Обычный' }, { value: 'bold', label: 'Жирный' },
      ] },
    ],
  });
  if (!r || !r.txt.trim()) return;
  const size = SIZES.text[Math.min(SIZES.text.length - 1, settings.textSize)];
  commit([...(page().items || []), {
    t: 'text', x: pt.x, y: pt.y, s: size, c: settings.textColor, txt: r.txt.trim(),
    italic: r.style === 'italic', bold: r.style === 'bold', font: 'serif',
  }]);
}

async function editTextDialog(item) {
  const r = await modal({
    title: 'Изменить пометку', okText: 'Сохранить',
    fields: [
      { name: 'txt', label: 'Текст (оставьте пустым, чтобы удалить)', type: 'textarea', value: item.txt },
      { name: 'size', label: 'Размер', type: 'select', value: String(Math.round(item.s * 1000)), options: [
        ...new Set([...SIZES.text.map((s) => Math.round(s * 1000)), Math.round(item.s * 1000)])].sort((a, b) => a - b).map((v) => ({ value: String(v), label: String(v) })) },
    ],
  });
  if (!r) return;
  const txt = r.txt.trim();
  if (!txt) commit(page().items.filter((i) => i !== item));
  else commit(page().items.map((i) => (i === item ? { ...item, txt, s: Number(r.size) / 1000 } : i)));
}

// ---------- Клавиатура и педаль для перелистывания ----------
function onKey(e) {
  if (!score || document.querySelector('dialog[open]')) return;
  if (e.target.matches && e.target.matches('input,textarea,select')) return;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (['ArrowRight', 'PageDown', ' ', 'ArrowDown'].includes(k)) {
    if (k === 'ArrowDown' && stage.scrollTop + stage.clientHeight < stage.scrollHeight - 2) return;
    e.preventDefault(); goTo(index + 1);
  } else if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(k)) {
    if (k === 'ArrowUp' && stage.scrollTop > 2) return;
    e.preventDefault(); goTo(index - 1);
  } else if (k === 'Escape' && perfMode) setPerfMode(false);
  else if (!e.ctrlKey && !e.metaKey) {
    const map = { p: 'pen', h: 'hl', e: 'eraser', t: 'text', s: 'stamp', m: 'hand' };
    if (map[k]) setTool(map[k]);
  }
}

// ---------- Режим выступления ----------
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

function setPerfMode(on) {
  perfMode = on;
  document.body.classList.toggle('perf', on);
  $('#panel').classList.remove('open');
  if (on) {
    requestWakeLock();
    const de = document.documentElement;
    if (de.requestFullscreen) de.requestFullscreen().catch(() => {});
    toast('Режим выступления: касание справа/слева или свайп — листать');
  } else {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  zoom = 1;
  setTimeout(() => layout(), 60);
}

// ---------- Панель страниц ----------
function togglePanel() {
  $('#panel').classList.toggle('open');
  setTimeout(() => layout(true), 260);
}

let thumbObserver = null;
function renderPanel() {
  const list = $('#thumb-list');
  list.replaceChildren();
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const node = en.target;
      thumbObserver.unobserve(node);
      const p = pages[Number(node.dataset.index)];
      if (!p) continue;
      renderPageToCanvas(p, 220).then((c) => {
        c.className = 'thumb-canvas';
        node.querySelector('.thumb-box').replaceChildren(c);
      }).catch(() => {});
    }
  }, { root: list, rootMargin: '200px' });
  pages.forEach((p, i) => {
    const item = el('div', { class: 'thumb-item' + (i === index ? ' current' : ''), 'data-index': i },
      el('div', { class: 'thumb-box', style: `aspect-ratio: 1 / ${p.aspect}` }),
      el('div', { class: 'thumb-num' }, String(i + 1)));
    item.addEventListener('click', () => goTo(i));
    list.append(item);
    thumbObserver.observe(item);
  });
}

function refreshThumb(i) {
  const node = document.querySelector(`.thumb-item[data-index="${i}"]`);
  if (!node || !pages[i]) return;
  renderPageToCanvas(pages[i], 220).then((c) => { c.className = 'thumb-canvas'; node.querySelector('.thumb-box').replaceChildren(c); }).catch(() => {});
}

async function savePageOrder() {
  pages.forEach((p, i) => { p.order = i; });
  await db.putMany(pages.map((p) => ['pages', p]));
  await touchScore(score.id, { lastPage: index }, { thumb: true });
  renderPanel();
  updateIndicator();
}

function addPageMenu(anchor) {
  const cur = page();
  popupMenu(anchor, [
    { label: 'Нотный стан после текущей', action: () => insertPages([staffPage(score.id, 0, cur.bg.type === 'staff' ? cur.bg.staves : 12, cur.bg.type === 'staff' && cur.bg.grand)]) },
    { label: 'Чистый лист после текущей', action: () => insertPages([staffPage(score.id, 0, 0)]) },
    { label: 'Из PDF или фото…', action: async () => {
      const files = await pickFiles('application/pdf,image/*', true);
      if (!files.length) return;
      busy(true, 'Добавление страниц…');
      try {
        const all = [];
        for (const f of files) all.push(...await appendFilePages(score.id, f, 0));
        await insertPages(all, true);
      } catch (e) { console.error(e); toast('Ошибка: ' + e.message); }
      busy(false);
    } },
  ]);
}

async function insertPages(newPages, saved = false) {
  await flushSave();
  pages.splice(index + 1, 0, ...newPages);
  if (!saved) await db.putMany(newPages.map((p) => ['pages', p]));
  index += 1;
  await savePageOrder();
  layout();
  toast(newPages.length > 1 ? `Добавлено страниц: ${newPages.length}` : 'Страница добавлена');
}

async function deleteCurrentPage() {
  if (pages.length <= 1) { toast('Нельзя удалить единственную страницу'); return; }
  const ok = await confirmDialog('Удалить страницу?', `Страница ${index + 1} и её пометки будут удалены.`);
  if (!ok) return;
  const [removed] = pages.splice(index, 1);
  await db.del('pages', removed.id);
  // Удаляем файл-подложку, если он больше не используется
  if (removed.bg.fileId && !pages.some((p) => p.bg.fileId === removed.bg.fileId)) await db.del('files', removed.bg.fileId);
  history.delete(removed.id);
  dirty.delete(removed);
  index = Math.min(index, pages.length - 1);
  await savePageOrder();
  layout();
}

async function movePage(delta) {
  const j = index + delta;
  if (j < 0 || j >= pages.length) return;
  [pages[index], pages[j]] = [pages[j], pages[index]];
  index = j;
  await savePageOrder();
  layout();
}

async function clearPage() {
  if (!(page().items || []).length) { toast('На странице нет пометок'); return; }
  const ok = await confirmDialog('Стереть все пометки?', 'Будут удалены все пометки на этой странице. Действие можно отменить кнопкой «Отменить».', 'Стереть');
  if (ok) commit([]);
}

function moreMenu(anchor) {
  popupMenu(anchor, [
    { label: '＋ Добавить страницу…', action: () => addPageMenu(anchor) },
    { label: 'Переместить страницу назад', action: () => movePage(-1) },
    { label: 'Переместить страницу вперёд', action: () => movePage(1) },
    { label: 'Стереть пометки на странице', action: clearPage },
    { label: settings.stylusOnly ? 'Рисовать и пальцем' : 'Рисовать только стилусом', action: () => setStylusOnly(!settings.stylusOnly, true) },
    { label: 'Печать / сохранить в PDF', action: async () => { await flushSave(); printScore(score.id); } },
    { label: 'Удалить страницу…', danger: true, action: deleteCurrentPage },
  ]);
}

