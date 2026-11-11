// Небольшие помощники интерфейса: всплывающие сообщения и диалоги.

export function $(sel, root = document) { return root.querySelector(sel); }

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer = null;
export function toast(message, ms = 2600) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// Универсальный модальный диалог. fields: [{name, label, type, value, options, min, max}]
export function modal({ title, message, fields = [], okText = 'OK', cancelText = 'Отмена', danger = false }) {
  return new Promise((resolve) => {
    const form = el('form', { class: 'modal-card', method: 'dialog' });
    form.append(el('h2', {}, title));
    if (message) form.append(el('p', { class: 'modal-msg' }, message));
    const inputs = {};
    for (const f of fields) {
      let input;
      if (f.type === 'select') {
        input = el('select', { name: f.name },
          f.options.map((o) => el('option', { value: o.value, selected: String(o.value) === String(f.value) }, o.label)));
      } else if (f.type === 'checkbox') {
        input = el('input', { type: 'checkbox', name: f.name, checked: !!f.value });
        form.append(el('label', { class: 'field check' }, input, el('span', {}, f.label)));
        inputs[f.name] = input;
        continue;
      } else if (f.type === 'textarea') {
        input = el('textarea', { name: f.name, rows: 3 });
        input.value = f.value ?? '';
      } else {
        input = el('input', {
          type: f.type || 'text', name: f.name, min: f.min, max: f.max, placeholder: f.placeholder || '',
          autocomplete: 'off',
        });
        input.value = f.value ?? '';
      }
      inputs[f.name] = input;
      form.append(el('label', { class: 'field' }, el('span', {}, f.label), input));
    }
    const dialog = el('dialog', { class: 'modal' }, form);
    const finish = (ok) => {
      if (!ok) { dialog.close(); dialog.remove(); resolve(null); return; }
      const result = {};
      for (const [name, input] of Object.entries(inputs)) {
        result[name] = input.type === 'checkbox' ? input.checked : input.value;
      }
      dialog.close();
      dialog.remove();
      resolve(fields.length ? result : true);
    };
    const actions = el('div', { class: 'modal-actions' });
    if (cancelText) actions.append(el('button', { type: 'button', class: 'btn', onclick: () => finish(false) }, cancelText));
    actions.append(el('button', { type: 'submit', class: danger ? 'btn danger' : 'btn primary' }, okText));
    form.append(actions);
    form.addEventListener('submit', (e) => { e.preventDefault(); finish(true); });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
    document.body.append(dialog);
    dialog.showModal();
    const first = form.querySelector('input:not([type=checkbox]),textarea');
    if (first) setTimeout(() => first.focus(), 50);
  });
}

export function confirmDialog(title, message, okText = 'Удалить') {
  return modal({ title, message, okText, danger: true });
}

// Выбор файлов через скрытый <input type=file>
export function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, multiple, style: 'display:none' });
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function busy(on, text = 'Загрузка…') {
  const b = $('#busy');
  $('#busy-text').textContent = text;
  b.hidden = !on;
}

// ---------- Файлы: сохранение и «Поделиться» ----------
export function isNative() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function safeFileName(name) {
  return (name || 'ноты').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'ноты';
}

// В Android-приложении — системное окно «Поделиться» (сохранить на Диск, в Файлы, отправить),
// на планшете в браузере — «Поделиться», если доступно, иначе обычное скачивание.
export async function saveFile(blob, name, title) {
  if (isNative()) {
    const { Filesystem, Share } = window.Capacitor.Plugins;
    const data = await blobToBase64(blob);
    const res = await Filesystem.writeFile({ path: name, data, directory: 'CACHE' });
    try {
      await Share.share({ title, dialogTitle: title, files: [res.uri] });
    } catch (e) {
      if (!/cancel/i.test(e && e.message)) throw e;
    }
    return;
  }
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && /iPad|iPhone|Android|Macintosh/i.test(navigator.userAgent) && 'ontouchend' in document
      && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  downloadBlob(blob, name);
}
