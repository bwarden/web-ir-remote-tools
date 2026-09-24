// Remote editor: the shared "current remote" panel. Shows the loaded device
// as an editable table of signals (name, protocol, address, subaddress,
// command), derives the data word and Pronto hex for each row, and exports
// the result as a HAIR wig download. Used by both the browse tab and the
// capture tab.

import { IRCode, bitReverseBytes, dataHex, toHex } from '../lib/code.js';
import { Converter } from '../lib/converter.js';
import { el, clear, copyButton, copyText, downloadText, fmtInt, intOrUndefined, slugify } from './util.js';
import { fetchIrdbDevice, parseDevicePath } from './store.js';

// wig top-level keys the editor represents itself; everything else on import
// is carried through as preserved metadata.
const KNOWN_TOP_KEYS = new Set(['format', 'name', 'brand', 'model', 'kind', 'signals', 'climate']);

// A local CSV can be either an IRDB button listing
// (functionname,protocol,device,subdevice,function) or one of the sample
// "IR Remote Control Codes - PROTO.csv" tables (Code/LSB/Product/...). The
// sample tables carry no protocol column — the protocol is in the file name —
// so the two formats are told apart by their header row.
function sniffCsvFormat(text: string): 'CSV' | 'CodesCSV' {
  const lines = text.split(/\r?\n/).filter((l) => /\S/.test(l));
  for (const line of lines.slice(0, 3)) {
    const heads = new Set(csvCells(line).map((h) => h.toLowerCase()));
    if (heads.has('protocol') || heads.has('functionname')) return 'CSV';
    if (heads.has('code') || heads.has('lsb') || heads.has('product') || heads.has('width')) {
      return 'CodesCSV';
    }
  }
  return 'CSV';
}

// The sample tables name their protocol in the file name
// ("IR Remote Control Codes - NEC.csv"); accept that and a bare protocol-name
// file name ("Samsung36.csv") alike.
function csvProtocolFromFilename(filename: string): string {
  const m = /IR Remote Control Codes - (.+)\.csv$/i.exec(filename);
  return (m ? m[1] : filename.replace(/\.csv$/i, '')).trim();
}

// Split a CSV line into header cells, tolerating the tab that a few IRDB
// files put between the first two header names.
function csvCells(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  for (const c of line) {
    if (c === ',' || c === '\t') {
      fields.push(field.trim().replace(/^"|"$/g, ''));
      field = '';
    } else {
      field += c;
    }
  }
  fields.push(field.trim().replace(/^"|"$/g, ''));
  return fields;
}

// One remote's worth of signals inside a code-table CSV, grouped by the
// device-type column (Product/Model, or a non-numeric Device column). `device`
// is '' for rows the table left unlabeled.
interface RemoteGroup {
  device: string;
  count: number;
  codes: IRCode[];
}

function groupByDevice(codes: IRCode[]): RemoteGroup[] {
  const byDevice = new Map<string, RemoteGroup>();
  for (const code of codes) {
    const device = (code.device ?? '').trim();
    let group = byDevice.get(device);
    if (!group) {
      group = { device, count: 0, codes: [] };
      byDevice.set(device, group);
    }
    group.count++;
    group.codes.push(code);
  }
  return [...byDevice.values()];
}

// These codes have not been proven on hardware. WigShop is for code verified
// to work, so exporting one here must pause on that warning rather than let
// an untested wig get uploaded silently.
export function confirmHardwareWarning(): boolean {
  return confirm(
    'This wig has not been tested against a real device. Do not upload it to HAIR\'s WigShop ' +
    'as-is. Import it into HAIR, test it on your actual hardware first, and only share it ' +
    'once you have verified every signal. Continue exporting anyway?',
  );
}

export interface RemoteDoc {
  meta: {
    name: string;
    brand: string;
    model: string;
    kind: string;
    // Top-level wig fields not otherwise represented in the editor (notes,
    // origin, wig_id, identifiers, supersedes, and any future unknown keys),
    // carried through import -> export per the format contract's
    // unknown-keys rule.
    extra?: Record<string, unknown>;
  };
  signals: IRCode[];
  sourcePath?: string;
}

// The two views Tasmota and the sample code tables report for a frame. The
// display form ("Data", the "Code" column) is code.data itself for whole-word
// MSB-first protocols (SAMSUNG36) and the per-byte bit reversal of it for the
// per-byte LSB-first protocols (NEC, JVC, SAMSUNG), where code.data is the
// accumulated form ("DataLSB", the "LSB" column). Protocols with no
// byte-order distinction (lsbIsAccumulated undefined) have no LSB view.
function dataForms(
  code: IRCode,
  lsbIsAccumulated: boolean | undefined,
): { data: string; dataLsb: string } {
  if (code.data === undefined) return { data: '', dataLsb: '' };
  const value = code.data;
  const display = dataHex(value);
  if (lsbIsAccumulated === undefined || typeof value !== 'number') {
    // Protocols with no byte-order distinction (MWM) have no LSB view; the
    // bit-reversal only ever applies to number-valued frames (<= 48 bits).
    return { data: display, dataLsb: '' };
  }
  const reversed = dataHex(bitReverseBytes(value, code.bits || 32));
  if (lsbIsAccumulated) return { data: reversed, dataLsb: display };
  return { data: display, dataLsb: reversed };
}

export class RemoteController {
  private converter: Converter;
  private container: HTMLElement;
  private doc: RemoteDoc | null = null;
  private showProntoAll = false;
  private sortCol: string | null = null;
  private sortDir: 'asc' | 'desc' = 'asc';

  constructor(converter: Converter, container: HTMLElement) {
    this.converter = converter;
    this.container = container;
  }

  load(doc: RemoteDoc): void {
    this.doc = doc;
    this.showProntoAll = false;
    this.sortCol = null;
    this.sortDir = 'asc';
    this.render();
  }

  get hasDoc(): boolean {
    return this.doc !== null;
  }

  get docName(): string {
    return this.doc?.meta.name || '';
  }

  // Append decoded signals to the current remote, creating a new remote when
  // none is open. Aliases are deduplicated against the signals already there,
  // since a wig requires unique signal aliases.
  appendSignals(codes: IRCode[]): void {
    if (!this.doc) {
      this.load({
        meta: { name: 'Captured signals', brand: '', model: '', kind: '' },
        signals: [],
      });
    }
    const doc = this.doc!;
    const existing = new Set(doc.signals.map((s) => s.alias));
    for (const c of codes) {
      const code = new IRCode(c);
      if (existing.has(code.alias)) {
        let n = 2;
        let base = code.alias;
        while (existing.has(`${base}_${n}`)) n++;
        code.alias = `${base}_${n}`;
      }
      existing.add(code.alias);
      doc.signals.push(code);
    }
    this.render();
  }

  // Fetch and open an IRDB device by repository path, shared by the browse
  // and capture tabs.
  async loadDevice(path: string): Promise<void> {
    const text = await fetchIrdbDevice(path);
    const signals = this.converter.importFormat('CSV', text);
    if (!signals.length) throw new Error('No supported signals in this file');
    const meta = parseDevicePath(path);
    this.load({
      meta: {
        name: `${meta.brand} ${meta.model}`.trim(),
        brand: meta.brand,
        model: meta.model,
        kind: meta.kind ?? '',
      },
      signals,
      sourcePath: path,
    });
  }

  // Load pre-decoded IRCode[] directly (used by LIRC browse).
  loadFromCodes(codes: IRCode[], name: string): void {
    if (!codes.length) throw new Error('No supported signals in this remote');
    this.load({
      meta: {
        name,
        brand: '',
        model: name,
        kind: '',
      },
      signals: codes,
    });
  }

  close(): void {
    this.doc = null;
    this.container.hidden = true;
    clear(this.container);
  }

  private recalc(code: IRCode): void {
    const proto = this.converter.getProtocol(code.protocol);
    if (!proto) return;
    const fresh = proto.decodeParams({
      address: code.address,
      subaddress: code.subaddress === -1 ? undefined : code.subaddress,
      command: code.command,
    });
    code.bits = fresh.bits;
    code.data = fresh.data;
    code.subaddress = fresh.subaddress;
  }

  private render(): void {
    if (!this.doc) return;
    clear(this.container);
    const doc = this.doc;
    this.container.hidden = false;

    // Header.
    const closeBtn = el('button', { type: 'button', text: 'Close' });
    closeBtn.addEventListener('click', () => this.close());
    const head = el('div', { class: 'remote-head' },
      el('h2', { text: doc.meta.name || 'Untitled remote' }),
      el('div', { class: 'remote-actions' }, closeBtn),
    );

    const source = doc.sourcePath
      ? el('p', { class: 'remote-source', text: `Loaded from ${doc.sourcePath}` })
      : null;

    // wig metadata fields.
    const metaGrid = el('div', { class: 'meta-grid' });
    type EditableMeta = Exclude<keyof RemoteDoc['meta'], 'extra'>;
    const metaLabels: [string, EditableMeta][] = [
      ['Name', 'name'],
      ['Brand', 'brand'],
      ['Model', 'model'],
      ['Kind', 'kind'],
    ];
    for (const [label, key] of metaLabels) {
      const input = el('input', { type: 'text', value: doc.meta[key] ?? '' });
      input.addEventListener('input', () => {
        doc.meta[key] = input.value;
        this.renderHead();
      });
      metaGrid.append(el('label', { class: 'input-row' }, el('span', { text: label }), input));
    }

    // Signals table.
    const table = this.renderTable();

    // Toolbar.
    const addBtn = el('button', { type: 'button', class: 'primary', text: 'Add signal' });
    addBtn.addEventListener('click', () => this.addSignal());

    const prontoToggle = el('button', {
      type: 'button',
      text: this.showProntoAll ? 'Hide all Pronto hex' : 'Show all Pronto hex',
    });
    prontoToggle.addEventListener('click', () => {
      this.showProntoAll = !this.showProntoAll;
      this.render();
    });

    const loadWigBtn = el('button', { type: 'button', text: 'Load wig file…' });
    const wigFileInput = el('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' });
    loadWigBtn.addEventListener('click', () => wigFileInput.click());
    wigFileInput.addEventListener('change', async () => {
      const file = wigFileInput.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        this.openWig(text);
      } catch (e) {
        alert(`Could not load wig: ${(e as Error).message}`);
      }
      wigFileInput.value = '';
    });

    const downloadBtn = el('button', { type: 'button', class: 'primary', text: 'Download wig' });
    downloadBtn.addEventListener('click', () => {
      if (!confirmHardwareWarning()) return;
      this.downloadWig();
    });

    const copyBtn = el('button', { type: 'button', text: 'Copy wig JSON' });
    copyBtn.addEventListener('click', () => {
      if (!confirmHardwareWarning()) return;
      copyText(this.wigText())
        .then(() => alert('wig JSON copied to clipboard.'))
        .catch((e) => alert(`Could not copy: ${(e as Error).message}`));
    });

    const csvBtn = el('button', { type: 'button', text: 'Export IRDB CSV' });
    csvBtn.addEventListener('click', () => this.downloadCsv());

    const exportToolbar = el('div', { class: 'toolbar' },
      downloadBtn, copyBtn, csvBtn, loadWigBtn, wigFileInput,
    );

    const sheet = el('div', { class: 'signal-table-wrap' }, table);

    this.container.append(
      head,
      ...(source ? [source] : []),
      metaGrid,
      el('div', { class: 'toolbar' }, addBtn, prontoToggle),
      sheet,
      exportToolbar,
    );
  }

  private renderHead(): void {
    if (!this.doc) return;
    const h = this.container.querySelector('.remote-head h2');
    if (h) h.textContent = this.doc.meta.name || 'Untitled remote';
  }

  private renderTable(): HTMLElement {
    const doc = this.doc!;
    const sortable = (label: string, col: string): HTMLElement => {
      const cell = el('th', { class: 'sortable', title: 'Click to sort' });
      const span = el('span', { text: label + (this.sortCol === col ? (this.sortDir === 'asc' ? ' ▲' : ' ▼') : '') });
      cell.append(span);
      cell.addEventListener('click', () => this.toggleSort(col));
      return cell;
    };
    const thead = el('thead', {}, el('tr', {},
      el('th', { text: '#' }),
      sortable('Name', 'name'),
      sortable('Protocol', 'protocol'),
      sortable('Address', 'address'),
      sortable('Subaddress', 'subaddress'),
      sortable('Command', 'command'),
      sortable('Data', 'data'),
      sortable('DataLSB', 'dataLsb'),
      el('th', { text: 'Pronto hex' }),
      el('th', { text: '' }),
    ));

    const tbody = el('tbody');
    const protoNames = this.converter.getProtocols().map((p) => p.name);
    let dragIdx: number | null = null;
    let dropTarget: HTMLTableRowElement | null = null;

    // A command sort reveals the gaps between neighbouring function numbers;
    // a muted row marks a run of missing values so a command list can be read
    // at a glance and filled in. Other numeric columns (address, data) have
    // huge, irrelevant gaps and do not show them.
    let prevVal: number | bigint | undefined;
    const isNumericSort = this.sortCol === 'command';

    doc.signals.forEach((code, i) => {
      const val = this.sortValue(code);
      if (isNumericSort && typeof prevVal === 'number' && typeof val === 'number') {
        const gap = this.sortDir === 'asc' ? val - prevVal : prevVal - val;
        if (gap > 1) {
          const lo = this.sortDir === 'asc' ? prevVal + 1 : val + 1;
          const hi = this.sortDir === 'asc' ? val - 1 : prevVal - 1;
          tbody.append(el('tr', { class: 'gap-row' },
            el('td', {
              colspan: '10',
              class: 'gap-cell',
              text: `${gap} missing: ${lo}${hi !== lo ? '–' + hi : ''}`,
            }),
          ));
        }
      }
      prevVal = val;

      const row = el('tr', { draggable: true, title: 'Drag to reorder' });
      row.addEventListener('dragstart', () => {
        dragIdx = i;
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        if (dropTarget) dropTarget.classList.remove('drag-over');
        dropTarget = null;
        dragIdx = null;
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (dragIdx === null || dragIdx === i) return;
        if (dropTarget && dropTarget !== row) dropTarget.classList.remove('drag-over');
        dropTarget = row;
        row.classList.add('drag-over');
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragIdx === null || dragIdx === i) return;
        const [moved] = doc.signals.splice(dragIdx, 1);
        doc.signals.splice(i, 0, moved);
        dragIdx = null;
        if (dropTarget) dropTarget.classList.remove('drag-over');
        dropTarget = null;
        this.render();
      });

      const num = el('td', { class: 'muted', text: String(i + 1) });

      const aliasInput = el('input', { type: 'text', class: 'cell-edit', value: code.alias ?? '' });
      aliasInput.addEventListener('input', () => { code.alias = aliasInput.value; });

      const protoSelect = el('select', { class: 'cell-edit' });
      for (const name of protoNames) {
        const opt = el('option', { value: name, text: name });
        if (name === code.protocol) opt.selected = true;
        protoSelect.append(opt);
      }

      const addrInput = el('input', { type: 'text', class: 'cell-edit', value: fmtInt(code.address) });
      const subInput = el('input', { type: 'text', class: 'cell-edit', value: fmtInt(code.subaddress) });
      const cmdInput = el('input', { type: 'text', class: 'cell-edit', value: fmtInt(code.command) });

      const dataCell = el('td', { class: 'datum' });
      const dataLsbCell = el('td', { class: 'datum' });
      const prontoCell = el('td');

      const recalcRow = () => {
        const addr = intOrUndefined(addrInput.value);
        const cmd = intOrUndefined(cmdInput.value);
        if (addr === undefined || cmd === undefined) {
          code.data = undefined;
          code.bits = 0;
        } else {
          code.address = addr;
          code.command = cmd;
          const sub = intOrUndefined(subInput.value);
          code.subaddress = sub === undefined ? -1 : sub;
          this.recalc(code);
        }
        this.renderData(dataCell, dataLsbCell, prontoCell, code);
      };

      protoSelect.addEventListener('change', () => { code.protocol = protoSelect.value; recalcRow(); });
      addrInput.addEventListener('input', recalcRow);
      subInput.addEventListener('input', recalcRow);
      cmdInput.addEventListener('input', recalcRow);

      const delBtn = el('button', { type: 'button', class: 'small danger', text: 'Remove' });
      delBtn.addEventListener('click', () => {
        doc.signals.splice(i, 1);
        this.render();
      });

      row.append(
        num,
        el('td', {}, aliasInput),
        el('td', {}, protoSelect),
        el('td', {}, addrInput),
        el('td', {}, subInput),
        el('td', {}, cmdInput),
        dataCell,
        dataLsbCell,
        prontoCell,
        el('td', {}, delBtn),
      );

      this.renderData(dataCell, dataLsbCell, prontoCell, code);
      tbody.append(row);
    });

    return el('table', {}, thead, tbody);
  }

  private renderData(dataCell: HTMLElement, dataLsbCell: HTMLElement, prontoCell: HTMLElement, code: IRCode): void {
    const proto = this.converter.getProtocol(code.protocol);
    const lsbIsAccumulated = typeof proto?.decodeByteOrder === 'function'
      ? (proto.lsbIsAccumulated ?? true)
      : undefined;
    const forms = dataForms(code, lsbIsAccumulated);
    dataCell.textContent = forms.data || '—';
    dataLsbCell.textContent = forms.dataLsb || '—';

    clear(prontoCell);
    let pronto: string | null = null;
    try {
      pronto = this.converter.exportCode(code, 'Pronto');
    } catch {
      pronto = null;
    }
    if (!pronto) {
      prontoCell.textContent = '—';
      return;
    }
    const details = el('details', { class: 'pronto' });
    if (this.showProntoAll) details.open = true;
    details.append(
      el('summary', { text: 'show' }),
      el('div', { class: 'pronto-body' },
        copyButton(pronto),
        el('code', { class: 'pronto-hex', text: pronto }),
      ),
    );
    prontoCell.append(details);
  }

  // Column sort. Clicking a column header sorts the table by it (ascending,
  // then descending, then back to the manual order); the sorted order is the
  // document's order, so add/remove/reorder and the wig export all follow it.
  private toggleSort(col: string): void {
    if (this.sortCol === col) {
      if (this.sortDir === 'asc') {
        this.sortDir = 'desc';
        this.sortSignals();
      } else {
        this.sortCol = null;
        this.sortDir = 'asc';
      }
    } else {
      this.sortCol = col;
      this.sortDir = 'asc';
      this.sortSignals();
    }
    this.render();
  }

  private sortSignals(): void {
    const doc = this.doc;
    if (!doc || !this.sortCol) return;
    const dir = this.sortDir === 'asc' ? 1 : -1;
    doc.signals.sort((a, b) => {
      const cmp = this.compareSignals(a, b);
      return cmp === 0 ? 0 : cmp * dir;
    });
  }

  private compareSignals(a: IRCode, b: IRCode): number {
    switch (this.sortCol) {
      case 'name':
        return (a.alias ?? '').toLowerCase().localeCompare((b.alias ?? '').toLowerCase());
      case 'protocol':
        return a.protocol.localeCompare(b.protocol);
      case 'address':
        return this.numCompare(a.address, b.address);
      case 'subaddress':
        return this.numCompare(this.subValue(a), this.subValue(b));
      case 'command':
        return this.numCompare(a.command, b.command);
      case 'data':
      case 'dataLsb':
        return this.numCompare(a.data, b.data);
      default:
        return 0;
    }
  }

  // The numeric value a row sorts (and gap-checks) by. Subaddress -1 is the
  // "unspecified" sentinel and does not participate in gap analysis.
  private sortValue(code: IRCode): number | bigint | undefined {
    switch (this.sortCol) {
      case 'address': return code.address;
      case 'subaddress': return this.subValue(code);
      case 'command': return code.command;
      case 'data':
      case 'dataLsb': return code.data;
      default: return undefined;
    }
  }

  private subValue(code: IRCode): number | undefined {
    return code.subaddress === -1 ? undefined : code.subaddress;
  }

  private numCompare(a: number | bigint | undefined, b: number | bigint | undefined): number {
    if (a === b) return 0;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    // A bigint and a number cannot be compared directly; widen mixed values.
    if (typeof a === 'bigint' || typeof b === 'bigint') {
      return BigInt(a) < BigInt(b) ? -1 : 1;
    }
    return a < b ? -1 : 1;
  }

  private addSignal(): void {
    if (!this.doc) return;
    const next = this.doc.signals.length + 1;
    const code = new IRCode({
      protocol: 'NEC',
      bits: 32,
      address: 0,
      subaddress: -1,
      command: 0,
      alias: `KEY_${next}`,
    });
    this.recalc(code);
    this.doc.signals.push(code);
    this.render();
  }

  private wigOpts(doc: RemoteDoc): { name: string; brand?: string; model?: string; kind?: string; extra?: Record<string, unknown> } {
    const opts: { name: string; brand?: string; model?: string; kind?: string; extra?: Record<string, unknown> } = {
      name: doc.meta.name || 'Untitled',
    };
    if (doc.meta.brand) opts.brand = doc.meta.brand;
    // Codes imported from a code table carry their device-type name (e.g.
    // "JVC RM-SMXKA6J") as their device; use it as the wig model when the
    // editor has no explicit model of its own.
    const device = doc.signals.map((s) => s.device).find(Boolean);
    if (doc.meta.model || device) opts.model = doc.meta.model || device;
    if (doc.meta.kind) opts.kind = doc.meta.kind;
    if (doc.meta.extra) opts.extra = { ...doc.meta.extra };
    return opts;
  }

  private wigText(): string {
    return this.converter.exportCodes('wig', this.doc!.signals, this.wigOpts(this.doc!));
  }

  // Download a wig for a given remote doc without opening it in the editor.
  // Used by the browse tab so a device can be exported straight from its
  // search result row, without the editor scrolling into view.
  downloadWigFor(doc: RemoteDoc): void {
    const base = doc.meta.name || `${doc.meta.brand || ''} ${doc.meta.model || ''}`.trim() || 'remote';
    downloadText(`${slugify(base)}.wig.json`, 'application/json', this.converter.exportCodes('wig', doc.signals, this.wigOpts(doc)));
  }

  private downloadWig(): void {
    this.downloadWigFor(this.doc!);
  }

  // The IRDB button listing, in the repository's own column order
  // (functionname,protocol,device,subdevice,function).
  private csvText(): string {
    const doc = this.doc!;
    return this.converter.exportCodes('CSV', doc.signals);
  }

  private downloadCsv(): void {
    const doc = this.doc!;
    const device = doc.signals.map((s) => s.device).find(Boolean);
    const brand = doc.meta.brand || 'Brand';
    const kind = doc.meta.model || device || 'Device';
    const first = doc.signals[0];
    const addr = first ? first.address : 0;
    const sub = first && first.subaddress !== -1 ? first.subaddress : -1;
    const suggested = `${brand}/${kind}/${addr},${sub}.csv`;
    const filename = `${slugify(brand)}-${slugify(kind)}-${addr},${sub}.csv`;
    downloadText(filename, 'text/csv', this.csvText());

    alert(
      `CSV downloaded as ${filename}\n\n` +
      `To contribute this remote to IRDB, rename the file to match the ` +
      `repository convention and open a pull request:\n\n` +
      `  ${suggested}\n\n` +
      `See github.com/probonopd/irdb#contributing for details.`,
    );
  }

  // Open a wig file as a fresh remote (replacing any remote already in the
  // editor). All wig metadata is taken from the file itself; nothing from the
  // previous document survives.
  openWig(text: string): void {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const meta: RemoteDoc['meta'] = { name: '', brand: '', model: '', kind: '' };
    if (typeof parsed.name === 'string') meta.name = parsed.name;
    if (typeof parsed.brand === 'string') meta.brand = parsed.brand;
    if (typeof parsed.model === 'string') meta.model = parsed.model;
    if (typeof parsed.kind === 'string') meta.kind = parsed.kind;
    // Everything else (notes, origin, wig_id, identifiers, supersedes, and
    // unknown keys) is preserved for the next export. The editor's known
    // fields are excluded so the current edits always win.
    const extra: Record<string, unknown> = {};
    for (const key of Object.keys(parsed)) {
      if (KNOWN_TOP_KEYS.has(key)) continue;
      extra[key] = parsed[key];
    }
    meta.extra = Object.keys(extra).length ? extra : undefined;
    const signals = this.converter.importFormat('wig', text);
    this.load({ meta, signals });
  }

  // Open a local CSV as a fresh remote, choosing between the two CSV formats
  // the app reads by their headers: the IRDB button listing and the sample
  // "IR Remote Control Codes" tables. The sample tables carry no protocol
  // column — the file name names it — so when the file name does not name a
  // known protocol, the user is asked to pick one. Cancelling the prompt
  // leaves the editor untouched.
  async openCsv(text: string, filename: string): Promise<void> {
    let signals: IRCode[];
    let name: string;
    if (sniffCsvFormat(text) === 'CodesCSV') {
      const protocol = await this.csvProtocol(filename);
      if (!protocol) return;
      const all = this.converter.importFormat('CodesCSV', { protocol, text });
      // A code table can hold several remotes, one per device-type column
      // value. When more than one remote is present, let the user pick which
      // one to open instead of dumping every device into the editor.
      const groups = groupByDevice(all);
      if (groups.length > 1) {
        const choice = await this.chooseRemote(filename, protocol, groups);
        if (!choice) return;
        signals = choice.codes;
        name = choice.device || protocol;
      } else {
        signals = all;
        name = groups[0]?.device || protocol;
      }
    } else {
      signals = this.converter.importFormat('CSV', text);
      name = filename.replace(/\.csv$/i, '').trim() || 'Remote';
    }
    if (!signals.length) throw new Error('No supported signals in this file');
    this.load({ meta: { name, brand: '', model: '', kind: '' }, signals });
  }

  // The protocol of a sample table: from its file name when that names a
  // registered protocol ("IR Remote Control Codes - NEC.csv", "Samsung36.csv");
  // otherwise ask the user to pick one of the registered protocols. Returns
  // null when the user cancels.
  private async csvProtocol(filename: string): Promise<string | null> {
    const candidate = csvProtocolFromFilename(filename).toUpperCase();
    const known = new Set(this.converter.getProtocols().map((p) => p.name.toUpperCase()));
    if (candidate && known.has(candidate)) return candidate;
    return this.chooseProtocol(filename);
  }

  // Ask the user which protocol a sample table encodes, via a dialog listing
  // the registered protocols. The tables have no protocol column, so when the
  // file name does not name a registered one the protocol has to come from
  // the user.
  private chooseProtocol(filename: string): Promise<string | null> {
    const names = this.converter.getProtocols().map((p) => p.name);
    const select = el('select', {});
    for (const name of names) select.append(el('option', { value: name, text: name }));
    const okBtn = el('button', { type: 'button', class: 'primary', text: 'OK' });
    const cancelBtn = el('button', { type: 'button', text: 'Cancel' });
    const dialog = el('dialog', {},
      el('p', {
        text: `"${filename}" looks like a sample code table, but its protocol could not be determined. Pick the protocol this file encodes.`,
      }),
      select,
      el('div', { class: 'row', style: 'margin-top: 12px' }, okBtn, cancelBtn),
    );
    document.body.append(dialog);
    dialog.showModal();
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: string | null): void => {
        if (done) return;
        done = true;
        dialog.remove();
        resolve(value);
      };
      okBtn.addEventListener('click', () => finish(select.value));
      cancelBtn.addEventListener('click', () => finish(null));
      dialog.addEventListener('cancel', () => finish(null));
      dialog.addEventListener('close', () => finish(null));
    });
  }

  // A code table that holds more than one device-type column value gets a
  // dialog listing the parsed remotes (device name + signal count); clicking
  // one opens just that remote. Returns null when the user cancels.
  private chooseRemote(
    filename: string,
    protocol: string,
    groups: RemoteGroup[],
  ): Promise<RemoteGroup | null> {
    const total = groups.reduce((sum, g) => sum + g.count, 0);
    const list = el('div', { class: 'remote-choice-list' });
    const cancelBtn = el('button', { type: 'button', text: 'Cancel' });
    const dialog = el('dialog', {},
      el('p', {
        text: `"${filename}" (${protocol}) parsed ${total} signals across ${groups.length} remotes. Pick a remote to open.`,
      }),
      list,
      el('div', { class: 'row', style: 'margin-top: 12px' }, cancelBtn),
    );
    document.body.append(dialog);
    dialog.showModal();
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: RemoteGroup | null): void => {
        if (done) return;
        done = true;
        dialog.remove();
        resolve(value);
      };
      for (const group of groups) {
        const row = el('button', { type: 'button', class: 'remote-choice' },
          el('span', { class: 'remote-choice-name', text: group.device || '(no device)' }),
          el('span', { class: 'remote-choice-count', text: `${group.count} signal${group.count === 1 ? '' : 's'}` }),
        );
        row.addEventListener('click', () => finish(group));
        list.append(row);
      }
      cancelBtn.addEventListener('click', () => finish(null));
      dialog.addEventListener('cancel', () => finish(null));
      dialog.addEventListener('close', () => finish(null));
    });
  }
}
