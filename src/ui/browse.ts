// Browse IRDB and LIRC through a single combined picker: one Brand dropdown
// and one Device dropdown driven by both indexes concatenated (each entry
// tagged with its source), with a single Save to Wig action. The detailed
// per-database tables and capture-match index reports live behind the
// Advanced toggle / database-information block below.

import { Converter } from '../lib/converter.js';
import {
  fetchDeviceList,
  fetchIrdbDevice,
  fetchLircDevice,
  fetchLircDeviceList,
  loadIrdbIndex,
  loadLircIndex,
  parseDevicePath,
  type IrdbDevice,
  type IrdbSkipReport,
  type LircDevice,
  type LircSkipReport,
} from './store.js';
import { RemoteController, confirmHardwareWarning, type RemoteDoc } from './remote.js';
import { el, clear } from './util.js';

interface CombinedEntry {
  source: 'IRDB' | 'LIRC';
  brand: string;
  model: string;
  path: string;
  signals: number;
  irdb?: IrdbDevice;
  lirc?: LircDevice;
}

export function initBrowseTab(
  section: HTMLElement,
  converter: Converter,
  remote: RemoteController,
  belowPanel: HTMLElement,
): void {
  clear(section);

  const status = el('div', { class: 'status' });
  const results = el('div');

  const brandSelect = el('select', {}, el('option', { value: '', text: 'All brands' }));
  const modelSelect = el('select', { disabled: true }, el('option', { value: '', text: 'All devices' }));
  const countLabel = el('span', { class: 'muted' });



  let irdbDevices: IrdbDevice[] = [];
  let lircDevices: LircDevice[] = [];
  let combined: CombinedEntry[] = [];

  function rebuildCombined(): void {
    const entries: CombinedEntry[] = [];
    for (const d of irdbDevices) {
      entries.push({ source: 'IRDB', brand: d.brand, model: d.model, path: d.path, signals: d.signals, irdb: d });
    }
    for (const d of lircDevices) {
      const brand = d.brand || d.manufacturer;
      const model = d.model || d.remote;
      entries.push({ source: 'LIRC', brand, model, path: d.path, signals: d.signals, lirc: d });
    }
    combined = entries;
  }

  function brandKey(s: string): string { return s.trim().toLowerCase(); }
  function modelKey(s: string): string { return s.trim().toLowerCase(); }

  function refreshBrandOptions(): void {
    const current = brandSelect.value;
    const display = new Map<string, string>();
    for (const e of combined) {
      const k = brandKey(e.brand);
      if (!display.has(k)) display.set(k, e.brand);
    }
    const keys = [...display.keys()].sort((a, b) => a.localeCompare(b));
    clear(brandSelect);
    brandSelect.append(el('option', { value: '', text: 'All brands' }));
    for (const k of keys) brandSelect.append(el('option', { value: k, text: display.get(k)! }));
    brandSelect.value = current;
  }

  function refreshModelOptions(): void {
    const brand = brandSelect.value;
    clear(modelSelect);
    if (!brand) {
      modelSelect.disabled = true;
      modelSelect.append(el('option', { value: '', text: 'All devices' }));
      return;
    }
    const display = new Map<string, string>();
    for (const e of combined) {
      if (brandKey(e.brand) !== brand) continue;
      const k = modelKey(e.model);
      if (!display.has(k)) display.set(k, e.model);
    }
    const keys = [...display.keys()].sort((a, b) => a.localeCompare(b));
    modelSelect.disabled = false;
    modelSelect.append(el('option', { value: '', text: 'All devices' }));
    for (const k of keys) modelSelect.append(el('option', { value: k, text: display.get(k)! }));
  }

  function currentHits(): CombinedEntry[] {
    const brand = brandSelect.value;
    const model = modelSelect.value;
    return combined.filter((e) =>
      (!brand || brandKey(e.brand) === brand) && (!model || modelKey(e.model) === model));
  }

  function applySelection(): void {
    const brand = brandSelect.value;
    const model = modelSelect.value;
    if (!brand && !model) {
      countLabel.textContent = `${combined.length} devices across both databases`;
      clear(results);
      return;
    }
    const hits = currentHits();
    countLabel.textContent = `${hits.length} match${hits.length === 1 ? '' : 'es'}`;
    renderResults(hits);
  }

  async function buildIrdbDoc(dev: IrdbDevice): Promise<RemoteDoc> {
    const text = await fetchIrdbDevice(dev.path);
    const signals = converter.importFormat('CSV', text);
    if (!signals.length) throw new Error('No supported signals in this file');
    const meta = parseDevicePath(dev.path);
    return {
      meta: {
        name: `${meta.brand} ${meta.model}`.trim(),
        brand: meta.brand,
        model: meta.model,
        kind: meta.kind ?? '',
      },
      signals,
      sourcePath: dev.path,
    };
  }

  async function buildLircDoc(dev: LircDevice): Promise<RemoteDoc> {
    const text = await fetchLircDevice(dev.path);
    const codes = converter.importFormat('LIRC', text);
    if (!codes.length) throw new Error('No supported signals in this device');
    return {
      meta: { name: dev.remote, brand: dev.brand || dev.manufacturer, model: dev.remote, kind: '' },
      signals: codes,
    };
  }

  async function saveEntry(entry: CombinedEntry): Promise<void> {
    if (!confirmHardwareWarning()) return;
    try {
      status.className = 'status';
      status.textContent = `Preparing ${entry.brand} ${entry.model}\u2026`;
      if (entry.irdb) {
        await remote.downloadWigFor(await buildIrdbDoc(entry.irdb));
      } else if (entry.lirc) {
        await remote.downloadWigFor(await buildLircDoc(entry.lirc));
      }
      status.textContent = '';
    } catch (e) {
      status.className = 'status error';
      status.textContent = `Could not download: ${(e as Error).message}`;
    }
  }

  async function openEntry(entry: CombinedEntry): Promise<void> {
    try {
      status.className = 'status';
      status.textContent = `Loading ${entry.brand} ${entry.model}\u2026`;
      if (entry.irdb) {
        await remote.load(await buildIrdbDoc(entry.irdb));
      } else if (entry.lirc) {
        await remote.load(await buildLircDoc(entry.lirc));
      }
      status.textContent = '';
    } catch (e) {
      status.className = 'status error';
      status.textContent = `Could not load: ${(e as Error).message}`;
    }
  }

  function renderResults(hits: CombinedEntry[]): void {
    clear(results);
    if (!hits.length) {
      results.append(el('p', { class: 'muted', text: 'No matching devices.' }));
      return;
    }
    const shown = hits.slice(0, 500);
    const thead = el('thead', {}, el('tr', {},
      el('th', { text: 'Source' }),
      el('th', { text: 'Brand' }),
      el('th', { text: 'Device' }),
      el('th', { text: 'Signals' }),
      el('th', { text: '' }),
    ));
    const tbody = el('tbody');
    for (const entry of shown) {
      const tr = el('tr');
      const saveBtn = el('button', { type: 'button', class: 'small primary', text: 'Save to Wig' });
      saveBtn.addEventListener('click', () => void saveEntry(entry));
      const openBtn = el('button', { type: 'button', class: 'small', text: 'Open' });
      openBtn.addEventListener('click', () => void openEntry(entry));
      tr.append(
        el('td', { text: entry.source }),
        el('td', { class: 'brand', text: entry.brand }),
        el('td', { text: entry.model }),
        el('td', { text: entry.signals > 0 ? String(entry.signals) : '\u2014' }),
        el('td', { class: 'open-cell' }, saveBtn, openBtn),
      );
      tbody.append(tr);
    }
    results.append(el('table', { class: 'result-table' }, thead, tbody));
    if (shown.length < hits.length) {
      results.append(el('p', { class: 'muted', text: `Showing ${shown.length} of ${hits.length}. Narrow by device.` }));
    }
  }

  // --- index status (unchanged, kept below) -------------------------------

  const irdbIndexStatus = el('span', { class: 'progress-label' });
  const irdbIndexSkip = el('details', { class: 'skip-report' });
  const lircIndexStatus = el('span', { class: 'progress-label' });
  const lircIndexSkip = el('details', { class: 'skip-report' });

  function irdbSkipReportText(skipped: IrdbSkipReport, misses: number, total: number): HTMLElement[] {
    const reasons: HTMLElement[] = [];
    if (skipped.parseErrors) reasons.push(el('p', { class: 'muted', text: `${skipped.parseErrors} file${skipped.parseErrors === 1 ? '' : 's'} could not be parsed.` }));
    if (skipped.noSupportedRows) {
      reasons.push(el('p', { class: 'muted', text: `${skipped.noSupportedRows} file${skipped.noSupportedRows === 1 ? '' : 's'} parsed but produced no decodable rows.` }));
      const _attr = Object.values(skipped.singleProtocol).reduce((a, b) => a + b, 0) + skipped.mixedProtocols;
      const _unattr = skipped.noSupportedRows - _attr;
      if (_attr > 0) reasons.push(el('p', { class: 'muted', text: `Attributed to a single unsupported protocol: ${Object.entries(skipped.singleProtocol).sort((a,b)=>b[1]-a[1]).map(([p,n])=>`${p} (${n})`).join(', ')}${skipped.mixedProtocols ? `, plus ${skipped.mixedProtocols} mixed-protocol file${skipped.mixedProtocols===1?'':'s'}` : ''}.` }));
      if (_unattr > 0) reasons.push(el('p', { class: 'muted', text: `${_unattr} file${_unattr===1?'':'s'} had no recognizable protocol token (raw-code or driver-based remotes such as zotac/imon).` }));
    }
    if (!reasons.length) reasons.push(el('p', { class: 'muted', text: 'Nothing was skipped; every IRDB file indexed cleanly.' }));
    reasons.push(el('p', { class: 'muted', text: `That is ${misses} of the ${total} files in the repository at index time.` }));
    return reasons;
  }

  async function refreshIrdbIndexStatus(): Promise<void> {
    const idx = await loadIrdbIndex();
    if (!idx) { irdbIndexStatus.textContent = 'Search index unavailable.'; return; }
    const when = new Date(idx.builtAt).toLocaleString();
    const rev = idx.version.slice(0, 7);
    irdbIndexStatus.textContent = `${idx.devices.length} devices indexed (IRDB @${rev}), ${idx.misses} files skipped, built ${when}`;
    clear(irdbIndexSkip);
    irdbIndexSkip.append(el('summary', { text: `${idx.misses} skipped files \u2014 why` }), ...irdbSkipReportText(idx.skipped, idx.misses, idx.devices.length + idx.misses));
  }

  async function refreshLircIndexStatus(): Promise<void> {
    const idx = await loadLircIndex();
    if (!idx) { lircIndexStatus.textContent = 'LIRC index not available.'; return; }
    const when = new Date(idx.builtAt).toLocaleString();
    const rev = idx.version.slice(0, 7);
    lircIndexStatus.textContent = `${idx.devices.length} devices indexed (LIRC @${rev}), ${idx.misses} files skipped, built ${when}`;
    clear(lircIndexSkip);
    lircIndexSkip.append(el('summary', { text: `${idx.misses} skipped files \u2014 why` }));
  }

  // --- assemble -----------------------------------------------------------

  const browseControls = el('fieldset', {},
    el('legend', { text: 'Browse devices' }),
    el('p', { class: 'muted', text: 'One picker across both databases. Pick a brand and device; if it exists in both, a short list lets you choose which copy to save.' }),
    el('div', { class: 'row' },
      el('label', { class: 'input-row' }, el('span', { text: 'Brand' }), brandSelect),
      el('label', { class: 'input-row' }, el('span', { text: 'Device' }), modelSelect),
      countLabel,
    ),
    status,
    results,
  );

  const databaseInfoBox = el('fieldset', {},
    el('legend', { text: 'Database information' }),
    el('h3', { class: 'match-head', text: 'IRDB' }), irdbIndexStatus, irdbIndexSkip,
    el('h3', { class: 'match-head', text: 'LIRC' }), lircIndexStatus, lircIndexSkip,
  );

  section.append(browseControls);

  const databasePanel = el('div', { class: 'remote-panel' });
  databasePanel.append(databaseInfoBox);
  belowPanel.after(databasePanel);

  brandSelect.addEventListener('change', () => { refreshModelOptions(); applySelection(); });
  modelSelect.addEventListener('change', applySelection);

  // Load both indexes, then rebuild the combined picker.
  status.textContent = 'Loading device indexes\u2026';
  Promise.allSettled([fetchDeviceList(), fetchLircDeviceList()]).then((res) => {
    if (res[0].status === 'fulfilled') {
      irdbDevices = res[0].value.devices;
    } else {
      status.className = 'status error';
      status.textContent = `IRDB index failed: ${(res[0].reason as Error).message}`;
    }
    if (res[1].status === 'fulfilled') {
      lircDevices = res[1].value.devices;
    } else {
      status.className = 'status error';
      status.textContent = `LIRC index failed: ${(res[1].reason as Error).message}`;
    }
    rebuildCombined();
    refreshBrandOptions();
    refreshModelOptions();
    applySelection();
    if (status.className !== 'status error') status.textContent = '';
  });

  void refreshIrdbIndexStatus();
  void refreshLircIndexStatus();
}
