import { mkdirSync, copyFileSync, cpSync, existsSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
mkdirSync('dist/src', { recursive: true });
if (existsSync('index.html')) copyFileSync('index.html', 'dist/index.html');
// tsc mirrors the source tree under dist/, and index.html links the
// stylesheet as src/style.css, so the CSS must land there too.
copyFileSync('src/style.css', 'dist/src/style.css');
mkdirSync('dist/test/fixtures', { recursive: true });
cpSync('test/fixtures', 'dist/test/fixtures', { recursive: true });
console.log('Copied static assets into dist/');
