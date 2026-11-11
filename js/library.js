// Библиотека нот: список, создание, импорт, резервное копирование.
import * as db from './db.js';
import { openPdf, loadImageFromBlob, renderPageToCanvas, forgetFile } from './render.js';
import { $, el, modal, confirmDialog, pickFiles, toast, busy, downloadBlob } from './ui.js';

const A4 = 297 / 210;
let onOpenScore = () => {};
let state = { search: '', sort: localStorage.getItem('lib-sort') || 'recent' };

export function initLibrary({ openScore }) {
  onOpenScore = openScore;
  $('#lib-search').addEventListener('input', (e) => { state.search = e.target.value.trim().toLowerCase(); renderLibrary(); });
  const sortSel = $('#lib-sort');
  sortSel.value = state.sort;
  sortSel.addEventListener('change', () => { state.sort = sortSel.value; localStorage.setItem('lib-sort', state.sort); renderLibrary(); });
  $('#btn-new').addEventListener('click', createBlankScore);
  $('#btn-import').addEventListener('click', importFiles);
  $('#btn-backup').addEventListener('click', exportBackup);
  $('#btn-restore').addEventListener('click', importBackup);

  // Перетаскивание файлов на библиотеку
  const view = $('#library');
  view.addEventListener('dragover', (e) => { e.preventDefault(); view.classList.add('drop'); });
  view.addEventListener('dragleave', () => view.classList.remove('drop'));
  view.addEventListener('drop', (e) => {
    e.preventDefault();
    view.classList.remove('drop');
    const files = [...e.dataTransfer.files];
    if (files.length) importFileList(files);
  });
}

function fileBaseName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || 'Без названия';
}

export async function makeThumbnail(scoreId) {
  const pages = await db.getPages(scoreId);
  if (!pages.length) return null;
  const canvas = await renderPageToCanvas(pages[0], 360);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

export async function touchScore(scoreId, patch = {}, { thumb = false } = {}) {
  const score = await db.get('scores', scoreId);
  if (!score) return;
  Object.assign(score, patch, { updatedAt: Date.now() });
  if (thumb) {
    try { score.thumb = await makeThumbnail(scoreId); } catch (e) { console.warn(e); }
  }
  const pages = await db.getPages(scoreId);
  score.pageCount = pages.length;
  await db.put('scores', score);
}

async function saveNewScore(score, pages, files = []) {
  const entries = [
    ...files.map((f) => ['files', f]),
    ...pages.map((p) => ['pages', p]),
    ['scores', score],
  ];
  await db.putMany(entries);
  await touchScore(score.id, {}, { thumb: true });
}

function newScore(title, composer = '') {
  const now = Date.now();
  return { id: db.uid(), title, composer, createdAt: now, updatedAt: now, openedAt: now, pageCount: 0, lastPage: 0, fav: false };
}

export function staffPage(scoreId, order, staves = 10, grand = false) {
  return { id: db.uid(), scoreId, order, aspect: A4, bg: { type: 'staff', staves: Number(staves), grand: !!grand }, items: [] };
}

async function createBlankScore() {
  const r = await modal({
    title: 'Новая нотная тетрадь',
    okText: 'Создать',
    fields: [
      { name: 'title', label: 'Название', value: 'Мои ноты' },
      { name: 'composer', label: 'Композитор / автор', value: '' },
      { name: 'pages', label: 'Количество страниц', type: 'number', value: 4, min: 1, max: 200 },
      { name: 'staves', label: 'Тип бумаги', type: 'select', value: '12',
        options: [
          { value: '8', label: 'Нотный стан — 8 строк (крупно)' },
          { value: '10', label: 'Нотный стан — 10 строк' },
          { value: '12', label: 'Нотный стан — 12 строк' },
          { value: '14', label: 'Нотный стан — 14 строк (мелко)' },
          { value: 'grand', label: 'Фортепиано — 6 систем по 2 стана' },
          { value: '0', label: 'Чистый лист' },
        ] },
    ],
  });
  if (!r) return;
  const score = newScore(r.title.trim() || 'Без названия', r.composer.trim());
  const count = Math.max(1, Math.min(200, parseInt(r.pages, 10) || 1));
  const grand = r.staves === 'grand';
  const staves = grand ? 12 : Number(r.staves);
  const pages = Array.from({ length: count }, (_, i) => staffPage(score.id, i, staves, grand));
  await saveNewScore(score, pages);
  onOpenScore(score.id);
}

async function importFiles() {
  const files = await pickFiles('application/pdf,image/*', true);
  if (files.length) importFileList(files);
}

async function importFileList(files) {
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const imgs = files.filter((f) => f.type.startsWith('image/')).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  let lastId = null;
  try {
    for (const file of pdfs) {
      busy(true, `Импорт «${file.name}»…`);
      lastId = await importPdf(file);
    }
    if (imgs.length) {
      busy(true, 'Импорт изображений…');
      lastId = await importImages(imgs);
    }
    busy(false);
    const n = pdfs.length + (imgs.length ? 1 : 0);
    if (!n) { toast('Поддерживаются PDF и изображения'); return; }
    toast(n === 1 ? 'Ноты добавлены' : `Добавлено: ${n}`);
    await renderLibrary();
    if (n === 1 && lastId) onOpenScore(lastId);
  } catch (e) {
    console.error(e);
    busy(false);
    toast('Ошибка импорта: ' + (e.message || e));
  }
}

async function importPdf(file) {
  const fileId = db.uid();
  const buf = new Uint8Array(await file.arrayBuffer());
  const doc = await openPdf(buf.slice());
  const score = newScore(fileBaseName(file.name));
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    pages.push({ id: db.uid(), scoreId: score.id, order: i - 1, aspect: vp.height / vp.width, bg: { type: 'pdf', fileId, pageNum: i }, items: [] });
  }
  doc.destroy();
  const blob = new Blob([buf], { type: 'application/pdf' });
  await saveNewScore(score, pages, [{ id: fileId, type: 'pdf', name: file.name, blob }]);
  return score.id;
}

async function imageEntry(file, scoreId, order) {
  const img = await loadImageFromBlob(file);
  const fileId = db.uid();
  const aspect = img.naturalHeight / img.naturalWidth;
  URL.revokeObjectURL(img.src);
  return {
    file: { id: fileId, type: 'image', name: file.name, blob: file },
    page: { id: db.uid(), scoreId, order, aspect, bg: { type: 'image', fileId }, items: [] },
  };
}

async function importImages(files) {
  const score = newScore(fileBaseName(files[0].name));
  const entries = [];
  for (let i = 0; i < files.length; i++) entries.push(await imageEntry(files[i], score.id, i));
  await saveNewScore(score, entries.map((e) => e.page), entries.map((e) => e.file));
  return score.id;
}

// Добавление страниц из файла в существующую партитуру (используется редактором).
export async function appendFilePages(scoreId, file, startOrder) {
  const pages = [];
  const files = [];
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const fileId = db.uid();
    const buf = new Uint8Array(await file.arrayBuffer());
    const doc = await openPdf(buf.slice());
    for (let i = 1; i <= doc.numPages; i++) {
      const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
      pages.push({ id: db.uid(), scoreId, order: startOrder + i - 1, aspect: vp.height / vp.width, bg: { type: 'pdf', fileId, pageNum: i }, items: [] });
    }
    doc.destroy();
    files.push({ id: fileId, type: 'pdf', name: file.name, blob: new Blob([buf], { type: 'application/pdf' }) });
  } else if (file.type.startsWith('image/')) {
    const e = await imageEntry(file, scoreId, startOrder);
    pages.push(e.page);
    files.push(e.file);
  }
  await db.putMany([...files.map((f) => ['files', f]), ...pages.map((p) => ['pages', p])]);
  return pages;
}

// ---------- Список ----------
const thumbUrls = new Map();
function thumbUrl(score) {
  if (!score.thumb) return null;
  const key = score.id + ':' + score.updatedAt;
  if (!thumbUrls.has(key)) thumbUrls.set(key, URL.createObjectURL(score.thumb));
  return thumbUrls.get(key);
}

function formatDate(ts) {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('ru-RU', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

function pagesWord(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'страница';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'страницы';
  return 'страниц';
}

export async function renderLibrary() {
  let scores = await db.getAll('scores');
  const total = scores.length;
  if (state.search) {
    scores = scores.filter((s) => (s.title + ' ' + (s.composer || '')).toLowerCase().includes(state.search));
  }
  const sorters = {
    recent: (a, b) => (b.openedAt || 0) - (a.openedAt || 0),
    updated: (a, b) => b.updatedAt - a.updatedAt,
    title: (a, b) => a.title.localeCompare(b.title, 'ru'),
    composer: (a, b) => (a.composer || '').localeCompare(b.composer || '', 'ru') || a.title.localeCompare(b.title, 'ru'),
  };
  scores.sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || sorters[state.sort](a, b));

  const grid = $('#lib-grid');
  grid.replaceChildren();
  $('#lib-empty').hidden = total > 0;
  $('#lib-nothing').hidden = !(total > 0 && scores.length === 0);

  for (const s of scores) {
    const url = thumbUrl(s);
    const card = el('div', { class: 'card', role: 'button', tabindex: 0 },
      el('div', { class: 'card-thumb' }, url ? el('img', { src: url, alt: '' }) : el('div', { class: 'thumb-placeholder' }, '♪')),
      el('div', { class: 'card-info' },
        el('div', { class: 'card-title' }, s.fav ? el('span', { class: 'fav' }, '★ ') : null, s.title),
        el('div', { class: 'card-sub' }, s.composer || ' '),
        el('div', { class: 'card-meta' }, `${s.pageCount} ${pagesWord(s.pageCount)} · ${formatDate(s.updatedAt)}`)),
      el('button', { class: 'card-menu icon-btn', title: 'Действия', 'aria-label': 'Действия',
        onclick: (e) => { e.stopPropagation(); scoreMenu(s, e.currentTarget); } }, '⋯'));
    card.addEventListener('click', () => onOpenScore(s.id));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') onOpenScore(s.id); });
    grid.append(card);
    if (!s.thumb && s.pageCount) {
      touchScore(s.id, {}, { thumb: true }).then(() => {}).catch(() => {});
    }
  }
}

function closeMenus() { document.querySelectorAll('.popup-menu').forEach((m) => m.remove()); }

export function popupMenu(anchor, items) {
  closeMenus();
  const menu = el('div', { class: 'popup-menu' },
    items.map((it) => el('button', { class: it.danger ? 'danger' : '', onclick: () => { closeMenus(); it.action(); } }, it.label)));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)) + 'px';
  menu.style.top = (r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
  const h = (e) => {
    if (!menu.isConnected) { document.removeEventListener('pointerdown', h, true); return; }
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', h, true); }
  };
  setTimeout(() => document.addEventListener('pointerdown', h, true), 0);
}

function scoreMenu(s, anchor) {
  popupMenu(anchor, [
    { label: 'Открыть', action: () => onOpenScore(s.id) },
    { label: s.fav ? 'Убрать из избранного' : 'В избранное', action: async () => { await touchScore(s.id, { fav: !s.fav }); renderLibrary(); } },
    { label: 'Переименовать…', action: () => editInfo(s) },
    { label: 'Создать копию', action: () => duplicateScore(s) },
    { label: 'Печать / сохранить в PDF', action: () => printScore(s.id) },
    { label: 'Удалить…', danger: true, action: () => removeScore(s) },
  ]);
}

export async function editInfo(s) {
  const r = await modal({
    title: 'Информация о нотах', okText: 'Сохранить',
    fields: [
      { name: 'title', label: 'Название', value: s.title },
      { name: 'composer', label: 'Композитор / автор', value: s.composer || '' },
    ],
  });
  if (!r) return false;
  await touchScore(s.id, { title: r.title.trim() || 'Без названия', composer: r.composer.trim() });
  renderLibrary();
  return true;
}

async function duplicateScore(s) {
  const pages = await db.getPages(s.id);
  const copy = newScore(s.title + ' (копия)', s.composer);
  // Файлы-подложки копируем, чтобы удаление одной копии не ломало другую
  const fileMap = new Map();
  const files = [];
  for (const p of pages) {
    if (p.bg.fileId && !fileMap.has(p.bg.fileId)) {
      const f = await db.get('files', p.bg.fileId);
      const nid = db.uid();
      fileMap.set(p.bg.fileId, nid);
      files.push({ ...f, id: nid });
    }
  }
  const newPages = pages.map((p) => ({
    ...p, id: db.uid(), scoreId: copy.id,
    bg: p.bg.fileId ? { ...p.bg, fileId: fileMap.get(p.bg.fileId) } : { ...p.bg },
    items: JSON.parse(JSON.stringify(p.items || [])),
  }));
  await saveNewScore(copy, newPages, files);
  toast('Копия создана');
  renderLibrary();
}

async function removeScore(s) {
  const ok = await confirmDialog('Удалить ноты?', `«${s.title}» и все пометки будут удалены без возможности восстановления.`);
  if (!ok) return;
  const pages = await db.getPages(s.id);
  pages.forEach((p) => p.bg.fileId && forgetFile(p.bg.fileId));
  await db.deleteScore(s.id);
  toast('Удалено');
  renderLibrary();
}

// ---------- Печать (через системный диалог можно сохранить в PDF) ----------
export async function printScore(scoreId) {
  try {
    busy(true, 'Подготовка к печати…');
    const pages = await db.getPages(scoreId);
    const area = $('#print-area');
    area.replaceChildren();
    for (const p of pages) {
      const canvas = await renderPageToCanvas(p, 1654); // ~200 dpi для A4
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
      area.append(el('div', { class: 'print-page' }, el('img', { src: URL.createObjectURL(blob) })));
    }
    busy(false);
    await Promise.all([...area.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
    window.print();
    setTimeout(() => {
      area.querySelectorAll('img').forEach((img) => URL.revokeObjectURL(img.src));
      area.replaceChildren();
    }, 1500);
  } catch (e) {
    busy(false);
    toast('Не удалось подготовить печать');
    console.error(e);
  }
}

// ---------- Резервная копия ----------
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function exportBackup() {
  try {
    busy(true, 'Создание резервной копии…');
    const [scores, pages, files] = await Promise.all([db.getAll('scores'), db.getAll('pages'), db.getAll('files')]);
    if (!scores.length) { busy(false); toast('Библиотека пуста'); return; }
    const out = {
      app: 'notebook-notes', version: 1, exportedAt: new Date().toISOString(),
      scores: scores.map(({ thumb, ...rest }) => rest),
      pages,
      files: [],
    };
    for (const f of files) {
      out.files.push({ id: f.id, type: f.type, name: f.name, mime: f.blob.type, data: await blobToBase64(f.blob) });
    }
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const date = new Date().toISOString().slice(0, 10);
    const name = `notnyi-bloknot-${date}.json`;
    busy(false);
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPad|iPhone|Android/i.test(navigator.userAgent)) {
      try { await navigator.share({ files: [file], title: 'Резервная копия нот' }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    downloadBlob(blob, name);
  } catch (e) {
    busy(false);
    console.error(e);
    toast('Ошибка: ' + (e.message || e));
  }
}

async function importBackup() {
  const [file] = await pickFiles('application/json,.json', false);
  if (!file) return;
  try {
    busy(true, 'Восстановление…');
    const data = JSON.parse(await file.text());
    if (data.app !== 'notebook-notes') throw new Error('Это не резервная копия нотного блокнота');
    const entries = [];
    for (const f of data.files) entries.push(['files', { id: f.id, type: f.type, name: f.name, blob: base64ToBlob(f.data, f.mime) }]);
    for (const p of data.pages) entries.push(['pages', p]);
    for (const s of data.scores) entries.push(['scores', s]);
    await db.putMany(entries);
    busy(false);
    toast(`Восстановлено нот: ${data.scores.length}`);
    renderLibrary();
  } catch (e) {
    busy(false);
    console.error(e);
    toast('Ошибка: ' + (e.message || e));
  }
}
