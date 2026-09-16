// Browse IRDB and LIRC: pick a brand/model (IRDB) or manufacturer/remote
// (LIRC) from the device list and open a device as an editable remote.
// Also reports the status of the capture-match indexes.

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

export function initBrowseTab(
  section: HTMLElement,
  converter: Converter,
  remote: RemoteController,
): void {
  clear(section);

  // --- IRDB browse ----------------------------------------------------------

  const irdbStatus = el('div', { class: 'status' });
  const irdbResults = el('div');

  const brandSelect = el('select', {}, el('option', { value: '', text: 'All brands' }));
  const modelSelect = el('select', { disabled: true }, el('option', { value: '', text: 'All models' }));
  const irdbCountLabel = el('span', { class: 'muted' });

  let irdbDevices: IrdbDevice[] = [];

  function refreshBrandOptions(): void {
    const current = brandSelect.value;
    const brands = [...new Set(irdbDevices.map((d) => d.brand))]
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
      modelSelect.append(el('option', { value: '', text: 'All models' }));
      return;
    }
    const models = [...new Set(irdbDevices.filter((d) => d.brand === brand).map((d) => d.model))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    modelSelect.disabled = false;
    modelSelect.append(el('option', { value: '', text: 'All models' }));
    for (const m of models) modelSelect.append(el('option', { value: m, text: m }));
  }

  function applyIrdbSelection(): void {
    const brand = brandSelect.value;
    const model = modelSelect.value;
    if (!brand && !model) {
      irdbCountLabel.textContent = `${irdbDevices.length} devices in the index`;
      showIrdbIdle();
      return;
    }
    const hits = irdbDevices.filter((dev) =>
      (!brand || dev.brand === brand) && (!model || dev.model === model));
    irdbCountLabel.textContent = `${hits.length} device${hits.length === 1 ? '' : 's'}`;
    renderIrdbResults(hits);
  }

  function showIrdbIdle(): void {
    clear(irdbResults);
    irdbResults.append(
      el('p', { class: 'muted', text: 'Select a brand (and optionally a model) to list devices. Results only appear once there is something to match.' }),
    );
  }

  function renderIrdbResults(hits: IrdbDevice[]): void {
    clear(irdbResults);
    const shown = hits.slice(0, 500);
    irdbResults.append(
      el('p', { class: 'fetch-note', text: 'These devices are not bundled with the app. Each row fetches its signals live from the IRDB CDN when you open it.' }),
    );
    if (shown.length < hits.length) {
      irdbResults.append(el('p', { class: 'muted', text: `Showing ${shown.length} of ${hits.length} devices. Pick a brand and model to narrow the list.` }));
    }
    if (!shown.length) {
      irdbResults.append(el('p', { class: 'muted', text: 'No matching devices.' }));
      return;
    }

    const thead = el('thead', {}, el('tr', {},
      el('th', { text: 'Brand' }),
      el('th', { text: 'Model' }),
      el('th', { text: 'Address' }),
      el('th', { text: 'Subaddress' }),
      el('th', { text: 'Signals' }),
      el('th', { text: '' }),
    ));
    const tbody = el('tbody');
    for (const dev of shown) {
      const tr = el('tr', { 'data-path': dev.path });
      const openBtn = el('button', { type: 'button', class: 'small primary', text: 'Fetch and open from IRDB' });
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void openIrdbDevice(dev);
      });
      const downloadBtn = el('button', { type: 'button', class: 'small', text: 'Download WIG' });
      downloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void downloadIrdbDevice(dev);
      });
      tr.append(
        el('td', { class: 'brand', text: dev.brand }),
        el('td', { text: dev.model }),
        el('td', { text: dev.address }),
        el('td', { text: dev.subaddress }),
        el('td', { text: dev.signals > 0 ? String(dev.signals) : '\u2014' }),
        el('td', { class: 'open-cell' }, openBtn, downloadBtn),
      );
      tr.addEventListener('click', () => openIrdbDevice(dev));
      tbody.append(tr);
    }
    irdbResults.append(el('table', { class: 'result-table' }, thead, tbody));
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

  async function openIrdbDevice(dev: IrdbDevice): Promise<void> {
    try {
      irdbStatus.className = 'status';
      irdbStatus.textContent = `Loading ${dev.brand} ${dev.model}\u2026`;
      await remote.load(await buildIrdbDoc(dev));
      irdbStatus.textContent = '';
    } catch (e) {
      irdbStatus.className = 'status error';
      irdbStatus.textContent = `Could not load ${dev.path}: ${(e as Error).message}`;
    }
  }

  async function downloadIrdbDevice(dev: IrdbDevice): Promise<void> {
    if (!confirmHardwareWarning()) return;
    try {
      irdbStatus.className = 'status';
      irdbStatus.textContent = `Preparing ${dev.brand} ${dev.model}\u2026`;
      remote.downloadWigFor(await buildIrdbDoc(dev));
      irdbStatus.textContent = '';
    } catch (e) {
      irdbStatus.className = 'status error';
      irdbStatus.textContent = `Could not download ${dev.path}: ${(e as Error).message}`;
    }
  }

  irdbStatus.textContent = 'Loading the IRDB device index\u2026';
  fetchDeviceList()
    .then((list) => {
      irdbDevices = list.devices;
      irdbStatus.textContent = '';
      refreshBrandOptions();
      refreshModelOptions();
      applyIrdbSelection();
    })
    .catch((e) => {
      irdbStatus.className = 'status error';
      irdbStatus.textContent = `Could not load the IRDB index: ${(e as Error).message}`;
    });

  // --- LIRC browse ----------------------------------------------------------

  const lircStatus = el('div', { class: 'status' });
  const lircResults = el('div');

  const mfgSelect = el('select', {}, el('option', { value: '', text: 'All manufacturers' }));
  const remoteSelect = el('select', { disabled: true }, el('option', { value: '', text: 'All devices' }));
  const lircCountLabel = el('span', { class: 'muted' });

  let lircDevices: LircDevice[] = [];

  function refreshMfgOptions(): void {
    const current = mfgSelect.value;
    const mfgs = [...new Set(lircDevices.map((d) => d.manufacturer))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    clear(mfgSelect);
    mfgSelect.append(el('option', { value: '', text: 'All manufacturers' }));
    for (const m of mfgs) mfgSelect.append(el('option', { value: m, text: m }));
    mfgSelect.value = current;
  }

  function refreshRemoteOptions(): void {
    const mfg = mfgSelect.value;
    clear(remoteSelect);
    if (!mfg) {
      remoteSelect.disabled = true;
      remoteSelect.append(el('option', { value: '', text: 'All devices' }));
      return;
    }
    const remotes = [...new Set(lircDevices.filter((d) => d.manufacturer === mfg).map((d) => d.remote))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    remoteSelect.disabled = false;
    remoteSelect.append(el('option', { value: '', text: 'All devices' }));
    for (const r of remotes) remoteSelect.append(el('option', { value: r, text: r }));
  }

  function applyLircSelection(): void {
    const mfg = mfgSelect.value;
    const remote = remoteSelect.value;
    if (!mfg && !remote) {
      lircCountLabel.textContent = `${lircDevices.length} devices in the index`;
      showLircIdle();
      return;
    }
    const hits = lircDevices.filter((dev) =>
      (!mfg || dev.manufacturer === mfg) && (!remote || dev.remote === remote));
    lircCountLabel.textContent = `${hits.length} device${hits.length === 1 ? '' : 's'}`;
    renderLircResults(hits);
  }

  function showLircIdle(): void {
    clear(lircResults);
    lircResults.append(
      el('p', { class: 'muted', text: 'Select a manufacturer (and optionally a device) to list LIRC devices. Results only appear once there is something to match.' }),
    );
  }

  function renderLircResults(hits: LircDevice[]): void {
    clear(lircResults);
    const shown = hits.slice(0, 500);
    lircResults.append(
      el('p', { class: 'fetch-note', text: 'These devices are fetched on demand from the lirc-remotes repository.' }),
    );
    if (shown.length < hits.length) {
      lircResults.append(el('p', { class: 'muted', text: `Showing ${shown.length} of ${hits.length} devices. Pick a manufacturer to narrow the list.` }));
    }
    if (!shown.length) {
      lircResults.append(el('p', { class: 'muted', text: 'No matching devices.' }));
      return;
    }

    const thead = el('thead', {}, el('tr', {},
      el('th', { text: 'Brand' }),
      el('th', { text: 'Device' }),
      el('th', { text: 'Model' }),
      el('th', { text: 'Signals' }),
      el('th', { text: '' }),
    ));
    const tbody = el('tbody');
    for (const dev of shown) {
      const tr = el('tr', { 'data-path': dev.path });
      const openBtn = el('button', { type: 'button', class: 'small primary', text: 'Fetch and open from LIRC' });
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void openLircDevice(dev);
      });
      const downloadBtn = el('button', { type: 'button', class: 'small', text: 'Download WIG' });
      downloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void downloadLircDevice(dev);
      });
      tr.append(
        el('td', { class: 'brand', text: dev.brand }),
        el('td', { text: dev.remote }),
        el('td', { text: dev.model }),
        el('td', { text: dev.signals > 0 ? String(dev.signals) : '\u2014' }),
        el('td', { class: 'open-cell' }, openBtn, downloadBtn),
      );
      tr.addEventListener('click', () => openLircDevice(dev));
      tbody.append(tr);
    }
    lircResults.append(el('table', { class: 'result-table' }, thead, tbody));
  }

  async function buildLircDoc(dev: LircDevice): Promise<RemoteDoc> {
    const text = await fetchLircDevice(dev.path);
    const codes = converter.importFormat('LIRC', text);
    if (!codes.length) throw new Error('No supported signals in this device');
    return {
      meta: { name: dev.remote, brand: '', model: dev.remote, kind: '' },
      signals: codes,
    };
  }

  async function openLircDevice(dev: LircDevice): Promise<void> {
    try {
      lircStatus.className = 'status';
      lircStatus.textContent = `Loading ${dev.brand} ${dev.remote}\u2026`;
      await remote.load(await buildLircDoc(dev));
      lircStatus.textContent = '';
    } catch (e) {
      lircStatus.className = 'status error';
      lircStatus.textContent = `Could not load ${dev.path}: ${(e as Error).message}`;
    }
  }

  async function downloadLircDevice(dev: LircDevice): Promise<void> {
    if (!confirmHardwareWarning()) return;
    try {
      lircStatus.className = 'status';
      lircStatus.textContent = `Preparing ${dev.brand} ${dev.remote}\u2026`;
      remote.downloadWigFor(await buildLircDoc(dev));
      lircStatus.textContent = '';
    } catch (e) {
      lircStatus.className = 'status error';
      lircStatus.textContent = `Could not download ${dev.path}: ${(e as Error).message}`;
    }
  }

  lircStatus.textContent = 'Loading the LIRC device index\u2026';
  fetchLircDeviceList()
    .then((list) => {
      lircDevices = list.devices;
      lircStatus.textContent = '';
      refreshMfgOptions();
      refreshRemoteOptions();
      applyLircSelection();
    })
    .catch((e) => {
      lircStatus.className = 'status';
      lircStatus.textContent = `LIRC index not available: ${(e as Error).message}`;
    });

  // --- index status ---------------------------------------------------------

  const irdbIndexStatus = el('span', { class: 'progress-label' });
  const irdbIndexSkip = el('details', { class: 'skip-report' });

  function irdbSkipReportText(skipped: IrdbSkipReport, misses: number, total: number): HTMLElement[] {
    const reasons: HTMLElement[] = [];
    if (skipped.parseErrors) {
      reasons.push(el('p', { class: 'muted', text: `${skipped.parseErrors} file${skipped.parseErrors === 1 ? '' : 's'} could not be parsed.` }));
    }
    if (skipped.noSupportedRows) {
      reasons.push(el('p', {
        class: 'muted',
        text: `${skipped.noSupportedRows} file${skipped.noSupportedRows === 1 ? '' : 's'} parsed but produced no decodable rows: every row used a protocol this build does not support. Only the NEC family (incl. 48-NEC), JVC (incl. JVC-48), Samsung, SAMSUNG20, and SAMSUNG36 are indexed; IRDB spans dozens of other protocols (RC5, Sony, Panasonic, DISH, \u2026).`,
      }));
      const protocols = Object.entries(skipped.singleProtocol).sort((a, b) => b[1] - a[1]);
      if (protocols.length) {
        const shown = protocols.slice(0, 8).map(([p, n]) => `${p} (${n} files)`).join(', ');
        const rest = protocols.length - 8;
        reasons.push(el('p', {
          class: 'muted',
          text: `Most common unsupported protocols: ${shown}${rest > 0 ? `, and ${rest} more` : ''}.`,
        }));
      }
      if (skipped.mixedProtocols) {
        reasons.push(el('p', { class: 'muted', text: `${skipped.mixedProtocols} file${skipped.mixedProtocols === 1 ? '' : 's'} mixed several unsupported protocols.` }));
      }
    }
    if (!reasons.length) {
      reasons.push(el('p', { class: 'muted', text: 'Nothing was skipped; every IRDB file indexed cleanly.' }));
    }
    reasons.push(el('p', { class: 'muted', text: `That is ${misses} of the ${total} files in the repository at index time \u2014 the missing device types are simply not covered by this build's protocol set.` }));
    return reasons;
  }

  async function refreshIrdbIndexStatus(): Promise<void> {
    const idx = await loadIrdbIndex();
    if (!idx) {
      irdbIndexStatus.textContent = 'Search index unavailable.';
      return;
    }
    const when = new Date(idx.builtAt).toLocaleString();
    const rev = idx.version.slice(0, 7);
    const commitAge = idx.commitDate ? ` (committed ${new Date(idx.commitDate).toLocaleDateString()})` : '';
    irdbIndexStatus.textContent =
      `${idx.devices.length} devices indexed (IRDB @${rev}${commitAge}), ${idx.misses} files skipped, built ${when}`;
    clear(irdbIndexSkip);
    irdbIndexSkip.append(
      el('summary', { text: `${idx.misses} skipped files \u2014 why` }),
      ...irdbSkipReportText(idx.skipped, idx.misses, idx.devices.length + idx.misses),
    );
  }

  const lircIndexStatus = el('span', { class: 'progress-label' });
  const lircIndexSkip = el('details', { class: 'skip-report' });

  async function refreshLircIndexStatus(): Promise<void> {
    const idx = await loadLircIndex();
    if (!idx) {
      lircIndexStatus.textContent = 'LIRC index not available.';
      return;
    }
    const when = new Date(idx.builtAt).toLocaleString();
    const rev = idx.version.slice(0, 7);
    const commitAge = idx.commitDate ? ` (committed ${new Date(idx.commitDate).toLocaleDateString()})` : '';
    lircIndexStatus.textContent =
      `${idx.devices.length} devices indexed (LIRC @${rev}${commitAge}), ${idx.misses} files skipped, built ${when}`;
    clear(lircIndexSkip);
    lircIndexSkip.append(
      el('summary', { text: `${idx.misses} skipped files \u2014 why` }),
      ...irdbSkipReportText(idx.skipped, idx.misses, idx.devices.length + idx.misses),
    );
  }

  // --- assemble sections ----------------------------------------------------

  const browseControls = el('fieldset', {},
    el('legend', { text: 'Browse devices' }),
    el('h3', { class: 'match-head', text: 'IRDB' }),
    el('div', { class: 'row' },
      el('label', { class: 'input-row' }, el('span', { text: 'Brand' }), brandSelect),
      el('label', { class: 'input-row' }, el('span', { text: 'Model' }), modelSelect),
      irdbCountLabel,
    ),
    irdbStatus,
    el('h3', { class: 'match-head', text: 'LIRC' }),
    el('div', { class: 'row' },
      el('label', { class: 'input-row' }, el('span', { text: 'Manufacturer' }), mfgSelect),
      el('label', { class: 'input-row' }, el('span', { text: 'Device' }), remoteSelect),
      lircCountLabel,
    ),
    lircStatus,
    el('p', { class: 'muted', text: 'Click a device to open it for editing, or download its wig directly.' }),
  );

  const databaseInfoBox = el('fieldset', {},
    el('legend', { text: 'Database information' }),
    el('p', { class: 'muted', text: 'The device indexes this page browses and matches captures against. They are generated when the site is built and downloaded as single files.' }),
    el('h3', { class: 'match-head', text: 'IRDB' }),
    irdbIndexStatus,
    irdbIndexSkip,
    el('p', { class: 'attribution', text: 'Remote codes from irdb by Simon Peter and contributors, used under permission. The database is community-maintained — add missing devices via a GitHub pull request at github.com/probonopd/irdb#contributing.' }),
    el('h3', { class: 'match-head', text: 'LIRC' }),
    lircIndexStatus,
    lircIndexSkip,
    el('p', { class: 'attribution', text: 'Remote codes from the lirc-remotes mirror (github.com/probonopd/lirc-remotes).' }),
  );

  const resultsBox = el('div', {}, irdbResults, lircResults);

  section.append(browseControls, resultsBox, databaseInfoBox);

  brandSelect.addEventListener('change', () => {
    refreshModelOptions();
    applyIrdbSelection();
  });
  modelSelect.addEventListener('change', applyIrdbSelection);
  mfgSelect.addEventListener('change', () => {
    refreshRemoteOptions();
    applyLircSelection();
  });
  remoteSelect.addEventListener('change', applyLircSelection);
  void refreshIrdbIndexStatus();
  void refreshLircIndexStatus();
}
