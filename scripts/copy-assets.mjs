import { mkdirSync, copyFileSync, cpSync } from 'node:fs';
import './write-version.mjs';

// write-version.mjs (run above) writes dist/index.html with the build-stamped
// version line, so index.html is not copied here or the stamp would be lost.
mkdirSync('dist', { recursive: true });
mkdirSync('dist/src', { recursive: true });
// tsc mirrors the source tree under dist/, and index.html links the
// stylesheet as src/style.css, so the CSS must land there too.
copyFileSync('src/style.css', 'dist/src/style.css');
mkdirSync('dist/test/fixtures', { recursive: true });
cpSync('test/fixtures', 'dist/test/fixtures', { recursive: true });
mkdirSync('dist/samples', { recursive: true });
cpSync('samples', 'dist/samples', { recursive: true });
console.log('Copied static assets into dist/');
