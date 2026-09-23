// App entry point: tab router and shared state. The browse and capture tabs
// both render into their own <section> and share one RemoteController that
// renders the current remote into the persistent #remote-panel.

import { Converter } from '../lib/converter.js';
import { RemoteController } from './remote.js';
import { initBrowseTab } from './browse.js';
import { initCaptureTab } from './capture.js';

const converter = new Converter();

const remotePanel = document.getElementById('remote-panel') as HTMLElement;
const remote = new RemoteController(converter, remotePanel);

const browseSection = document.getElementById('tab-browse') as HTMLElement;
const captureSection = document.getElementById('tab-capture') as HTMLElement;

initBrowseTab(browseSection, converter, remote, remotePanel);
initCaptureTab(captureSection, converter, remote);

// Header file-open tools: loading a wig or CSV opens the remote editor, no
// matter which tab is active.
function wireFileOpen(btnId: string, inputId: string, open: (text: string, name: string) => void | Promise<void>): void {
  const btn = document.getElementById(btnId) as HTMLButtonElement;
  const input = document.getElementById(inputId) as HTMLInputElement;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      await open(await file.text(), file.name);
    } catch (e) {
      alert(`Could not load ${file.name}: ${(e as Error).message}`);
    }
    input.value = '';
  });
}

wireFileOpen('load-wig-btn', 'load-wig-input', (text) => remote.openWig(text));
wireFileOpen('load-csv-btn', 'load-csv-input', (text, name) => remote.openCsv(text, name));

const tabBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('#tabs .tab-btn'));
function activate(name: string): void {
  for (const btn of tabBtns) btn.classList.toggle('active', btn.dataset.tab === name);
  browseSection.hidden = name !== 'browse';
  captureSection.hidden = name !== 'capture';
}
for (const btn of tabBtns) {
  btn.addEventListener('click', () => activate(btn.dataset.tab ?? 'browse'));
}

activate('browse');
