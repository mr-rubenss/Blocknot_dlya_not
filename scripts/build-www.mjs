// Собирает веб-часть приложения в папку www/ для упаковки в Android-приложение.
import { cpSync, rmSync, mkdirSync } from 'node:fs';

const items = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons', 'vendor'];
rmSync('www', { recursive: true, force: true });
mkdirSync('www');
for (const it of items) cpSync(it, `www/${it}`, { recursive: true });
console.log('www/ готова');
