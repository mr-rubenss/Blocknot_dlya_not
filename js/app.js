// Точка входа: переключение между библиотекой и редактором.
import { initLibrary, renderLibrary } from './library.js';
import { initEditor, openEditor, leaveEditor } from './editor.js';
import { requestPersistence } from './db.js';
import { $, toast } from './ui.js';

function showView(name) {
  $('#library').hidden = name !== 'library';
  $('#editor').hidden = name !== 'editor';
  document.body.dataset.view = name;
}

async function route() {
  const m = location.hash.match(/^#\/score\/(.+)$/);
  if (m) {
    showView('editor');
    const ok = await openEditor(decodeURIComponent(m[1]));
    if (!ok) { toast('Ноты не найдены'); location.hash = ''; }
  } else {
    await leaveEditor();
    showView('library');
    renderLibrary();
  }
}

initLibrary({ openScore: (id) => { location.hash = '#/score/' + encodeURIComponent(id); } });
initEditor({ exit: () => { location.hash = ''; } });
window.addEventListener('hashchange', route);
route();
requestPersistence();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW:', e));
}

// Запрет системного масштабирования двойным тапом/щипком на iOS
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
