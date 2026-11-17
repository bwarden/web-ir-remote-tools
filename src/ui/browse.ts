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

  const advancedToggle = el('button', { type: 'button', class: 'small', text: 'Advanced: show full tables' });
  const advancedPanel = el('div', { hidden: true });

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

  function refreshBrandOptions(): void {
    const current = brandSelect.value;
    const brands = [...new Set(combined.map((e) => e.brand))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    clear(brandSelect);
    brandSelect.append(el('option', { value: '', text: 'All brands' }));
    for (const b of brands) brandSelect.append(el('option', { value: b, text: b }));
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
    const models = [...new Set(combined.filter((e) => e.brand === brand).map((e) => e.model))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    modelSelect.disabled = false;
    modelSelect.append(el('option', { value: '', text: 'All devices' }));
    for (const m of models) modelSelect.append(el('option', { value: m, text: m }));
  }

  function currentHits(): CombinedEntry[] {
    const brand = brandSelect.value;
    const model = modelSelect.value;
    return combined.filter((e) =>
      (!brand || e.brand === brand) && (!model || e.model === model));
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
    if (hits.length === 1) {
      const entry = hits[0];
      const row = el('div', { class: 'row' });
      const saveBtn = el('button', { type: 'button', class: 'primary', text: 'Save to Wig' });
      saveBtn.addEventListener('click', () => void saveEntry(entry));
      const openBtn = el('button', { type: 'button', class: 'small', text: 'Open for editing' });
      openBtn.addEventListener('click', () => void openEntry(entry));
      row.append(saveBtn, openBtn);
      results.append(
        el('p', { text: `${entry.brand} ${entry.model} (${entry.source}, ${entry.signals} signals)` }),
        row,
      );
      return;
    }
    const list = el('ul', { class: 'combined-results' });
    for (const entry of hits.slice(0, 100)) {
      const li = el('li');
      const saveBtn = el('button', { type: 'button', class: 'small primary', text: 'Save' });
      saveBtn.addEventListener('click', () => void saveEntry(entry));
      const openBtn = el('button', { type: 'button', class: 'small', text: 'Open' });
      openBtn.addEventListener('click', () => void openEntry(entry));
      li.append(
        el('span', { class: 'source-badge', text: entry.source }),
        el('span', { text: ` ${entry.brand} ${entry.model} ` }),
        el('span', { class: 'muted', text: `(${entry.signals} signals)` }),
        saveBtn,
        openBtn,
      );
      list.append(li);
    }
    if (hits.length > 100) {
      results.append(el('p', { class: 'muted', text: `Showing 100 of ${hits.length}. Narrow by device.` }));
    }
    results.append(list);
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

  const advancedSection = el('fieldset', {},
    el('legend', { text: 'Advanced' }),
    advancedToggle,
    advancedPanel,
  );

  const databaseInfoBox = el('fieldset', {},
    el('legend', { text: 'Database information' }),
    el('h3', { class: 'match-head', text: 'IRDB' }), irdbIndexStatus, irdbIndexSkip,
    el('h3', { class: 'match-head', text: 'LIRC' }), lircIndexStatus, lircIndexSkip,
  );

  section.append(browseControls, advancedSection);

  const databasePanel = el('div', { class: 'remote-panel' });
  databasePanel.append(databaseInfoBox);
  belowPanel.after(databasePanel);

  brandSelect.addEventListener('change', () => { refreshModelOptions(); applySelection(); });
  modelSelect.addEventListener('change', applySelection);

  advancedToggle.addEventListener('click', () => {
    advancedPanel.hidden = !advancedPanel.hidden;
    advancedToggle.textContent = advancedPanel.hidden ? 'Advanced: show full tables' : 'Advanced: hide';
  });

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
