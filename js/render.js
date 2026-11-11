// Отрисовка фона страниц (нотный стан, PDF, изображение) и рукописных пометок.
import * as db from './db.js';

let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdfjs/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

const pdfDocs = new Map(); // fileId -> Promise<PDFDocumentProxy>
const images = new Map(); // fileId -> Promise<ImageBitmap|HTMLImageElement>

export async function openPdf(data) {
  const lib = await loadPdfJs();
  return lib.getDocument({
    data,
    standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
    isEvalSupported: false,
  }).promise;
}

function getPdfDoc(fileId) {
  if (!pdfDocs.has(fileId)) {
    pdfDocs.set(fileId, (async () => {
      const file = await db.get('files', fileId);
      const buf = await file.blob.arrayBuffer();
      return openPdf(new Uint8Array(buf));
    })());
  }
  return pdfDocs.get(fileId);
}

export function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть изображение')); };
    img.src = url;
  });
}

function getImage(fileId) {
  if (!images.has(fileId)) {
    images.set(fileId, db.get('files', fileId).then((f) => loadImageFromBlob(f.blob)));
  }
  return images.get(fileId);
}

export function forgetFile(fileId) {
  const p = pdfDocs.get(fileId);
  if (p) p.then((d) => d.destroy()).catch(() => {});
  pdfDocs.delete(fileId);
  images.delete(fileId);
}

// ---------- Нотный стан ----------
export function drawStaffPaper(ctx, w, h, bg) {
  ctx.fillStyle = '#fffdf8';
  ctx.fillRect(0, 0, w, h);
  const staves = bg.staves || 10;
  if (!staves) return;
  const marginX = w * 0.07;
  const top = w * 0.09;
  const bottom = w * 0.07;
  const usable = h - top - bottom;
  const gap = usable / staves; // высота блока под один стан
  const lineGap = Math.min(gap / 9, w * 0.0125); // расстояние между линейками
  ctx.strokeStyle = '#3a3a3a';
  ctx.lineWidth = Math.max(1, w * 0.0011);
  for (let s = 0; s < staves; s++) {
    const staffHeight = lineGap * 4;
    const y0 = top + s * gap + (gap - staffHeight) / 2;
    ctx.beginPath();
    for (let l = 0; l < 5; l++) {
      const y = Math.round(y0 + l * lineGap) + 0.5;
      ctx.moveTo(marginX, y);
      ctx.lineTo(w - marginX, y);
    }
    if (bg.grand && s % 2 === 0 && s + 1 < staves) {
      // соединительная линия фортепианной системы
      const y1 = top + (s + 1) * gap + (gap - staffHeight) / 2 + staffHeight;
      ctx.moveTo(marginX, y0);
      ctx.lineTo(marginX, y1);
    } else {
      ctx.moveTo(marginX, y0);
      ctx.lineTo(marginX, y0 + staffHeight);
    }
    ctx.moveTo(w - marginX, y0);
    ctx.lineTo(w - marginX, y0 + staffHeight);
    ctx.stroke();
  }
}

// Рисует фон страницы в ctx размером w×h пикселей.
export async function drawBackground(ctx, w, h, page) {
  const bg = page.bg;
  if (bg.type === 'pdf') {
    const doc = await getPdfDoc(bg.fileId);
    const pdfPage = await doc.getPage(bg.pageNum);
    const base = pdfPage.getViewport({ scale: 1 });
    const viewport = pdfPage.getViewport({ scale: w / base.width });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
  } else if (bg.type === 'image') {
    const img = await getImage(bg.fileId);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
  } else {
    drawStaffPaper(ctx, w, h, bg);
  }
}

// ---------- Пометки ----------
// Координаты хранятся в долях ширины страницы: x, y ∈ [0..1], [0..aspect].
// Толщина линии тоже в долях ширины (w = 0.002 ≈ 2px на странице шириной 1000px).

function widthAt(item, p) {
  if (item.tool === 'hl') return item.w;
  return item.w * (0.35 + 0.95 * p);
}

export function drawStroke(ctx, item, scale) {
  const pts = item.pts;
  const n = pts.length / 3;
  if (n === 0) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = item.c;
  ctx.fillStyle = item.c;
  if (item.tool === 'hl') {
    ctx.globalAlpha = 0.35;
    ctx.globalCompositeOperation = 'multiply';
    ctx.lineWidth = item.w * scale;
    ctx.beginPath();
    ctx.moveTo(pts[0] * scale, pts[1] * scale);
    if (n === 1) ctx.lineTo(pts[0] * scale + 0.1, pts[1] * scale);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i * 3] * scale, pts[i * 3 + 1] * scale);
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(pts[0] * scale, pts[1] * scale, (widthAt(item, pts[2]) * scale) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  // Сглаживание: квадратичные кривые через середины отрезков, толщина по нажиму.
  let px = pts[0] * scale;
  let py = pts[1] * scale;
  for (let i = 1; i < n; i++) {
    const x = pts[i * 3] * scale;
    const y = pts[i * 3 + 1] * scale;
    const p = (pts[(i - 1) * 3 + 2] + pts[i * 3 + 2]) / 2;
    const mx = i < n - 1 ? (x + pts[(i + 1) * 3] * scale) / 2 : x;
    const my = i < n - 1 ? (y + pts[(i + 1) * 3 + 1] * scale) / 2 : y;
    ctx.lineWidth = Math.max(0.6, widthAt(item, p) * scale);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.quadraticCurveTo(x, y, mx, my);
    ctx.stroke();
    px = mx;
    py = my;
  }
  ctx.restore();
}

export const FONTS = {
  serif: '"Times New Roman", Georgia, serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  music: '"Bravura Text", "Noto Music", "Segoe UI Symbol", "Apple Symbols", "Times New Roman", serif',
};

export function textFont(item, scale) {
  const style = item.italic ? 'italic ' : '';
  const weight = item.bold ? 'bold ' : '';
  return `${style}${weight}${item.s * scale}px ${FONTS[item.font] || FONTS.serif}`;
}

export function drawText(ctx, item, scale) {
  ctx.save();
  ctx.fillStyle = item.c;
  ctx.font = textFont(item, scale);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const lines = item.txt.split('\n');
  const lh = item.s * scale * 1.2;
  lines.forEach((line, i) => {
    ctx.fillText(line, item.x * scale, item.y * scale + (i - (lines.length - 1) / 2) * lh);
  });
  ctx.restore();
}

export function textBounds(ctx, item) {
  // Габариты текста в координатах страницы (доли ширины).
  ctx.save();
  ctx.font = textFont(item, 1000);
  const lines = item.txt.split('\n');
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) / 1000;
  ctx.restore();
  const height = item.s * 1.2 * lines.length;
  return { x0: item.x - width / 2, x1: item.x + width / 2, y0: item.y - height / 2, y1: item.y + height / 2 };
}

export function drawItem(ctx, item, scale) {
  if (item.t === 'text') drawText(ctx, item, scale);
  else drawStroke(ctx, item, scale);
}

export function drawItems(ctx, items, scale) {
  for (const it of items) drawItem(ctx, it, scale);
}

// Полная страница (фон + пометки) на отдельный canvas — для миниатюр и печати.
export async function renderPageToCanvas(page, widthPx) {
  const h = Math.round(widthPx * page.aspect);
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  await drawBackground(ctx, widthPx, h, page);
  drawItems(ctx, page.items || [], widthPx);
  return canvas;
}
