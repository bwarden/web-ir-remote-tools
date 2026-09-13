// Find by capture: decode pasted Tasmota captures (full IrReceived JSON,
// compact RawData, or a protocol/data line), Pronto Hex strings, a single
// hex value with a protocol, or protocol/address/(subaddress)/function
// parameters. Decodes accumulate in a session: every signal is matched
// against the IRDB and LIRC indexes, the matching device sets are
// intersected so a remote can be pinned down from several captures, and
// the session can be appended to the shared remote editor.

import { Converter } from '../lib/converter.js';
import { IRCode, dataHex } from '../lib/code.js';
import { RemoteController } from './remote.js';
import {
  loadIrdbIndex,
  loadLircIndex,
  exactKey,
  looseKey,
  type IrdbIndex,
  type LircIndex,
  type IndexEntry,
} from './store.js';
import { el, clear, copyButton, copyText, intOrUndefined, protocolNames } from './util.js';

function codeDataHex(code: IRCode): string {
  if (code.data === undefined) return '';
  return dataHex(code.data);
}

interface CodeMatch {
  code: IRCode;
  irdbExact: IndexEntry[];
  irdbLoose: IndexEntry[];
  lircExact: IndexEntry[];
  lircLoose: IndexEntry[];
}

export function initCaptureTab(
  section: HTMLElement,
  converter: Converter,
  remote: RemoteController,
): void {
  clear(section);

  const result = el('div');
  const sessionBox = el('div');
  const matchBox = el('div');
  const status = el('div', { class: 'status' });
  const protos = protocolNames(converter);

  const session: IRCode[] = [];

  function protoSelect(): HTMLSelectElement {
    const sel = el('select', {});
    for (const name of protos) {
      const opt = el('option', { value: name, text: name });
      if (name === 'NEC') opt.selected = true;
      sel.append(opt);
    }
    return sel;
  }

  function showError(msg: string): void {
    status.className = 'status error';
    status.textContent = msg;
  }

  function showNote(msg: string): void {
    status.className = 'status';
    status.textContent = msg;
  }

  // --- mode 1: capture paste --------------------------------------------------
  const tasmotaTextarea = el('textarea', { rows: 4, placeholder: 'Paste a Tasmota console dump, compact RawData, or Pronto Hex string. Every {"IrReceived":{...}} JSON object, bare RawData, or raw Pronto Hex (0000 006D ...) is decoded. Each command found joins the session and the IRDB lookup.' });
  const tasmotaBtn = el('button', { type: 'button', class: 'primary', text: 'Decode' });
  const clearBtn = el('button', { type: 'button', text: 'Clear' });
  clearBtn.addEventListener('click', () => { tasmotaTextarea.value = ''; });
  tasmotaBtn.addEventListener('click', () => {
    try {
      handleDecoded(decodeCapture(tasmotaTextarea.value));
      tasmotaTextarea.value = '';
    } catch (e) {
      showError((e as Error).message);
    }
  });

  // Sample data links — Samsung TV remote (AA59-00666A) signals that
  // match both the IRDB and LIRC indexes.
  const SAMPLE_TASMOTA =
    'tele/tasmota/600605/RESULT {"IrReceived":{"Protocol":"SAMSUNG","Bits":32,"Data":"0xE0E040BF","DataLSB":"0x70702FD","Repeat":0,"RawData":"+4545-4440+600-1635CdC-1640C-520C-515Cf+605-510CfC-1630CdCjCgCfCfCfCgCf+595dCgHiHgCgCgCfCeHiCdCdCdCdCdCdC-46715AbCdCdCdKfCgCfCfCfCeCdCeCfKfCfCfCfCfKeCfCfCfKfCfCfCeCfCdCeKeKeKeCeClAbCdCeCdCfCgCfCfKfCeCeCeKfCfKfCfCfKfKeKfKfCfK-525+590fKfKeKfKeKeKeKeKeKeK","RawDataInfo":[203,203,0]}}\n' +
    'tele/tasmota/600605/RESULT {"IrReceived":{"Protocol":"SAMSUNG","Bits":32,"Data":"0xE0E0F00F","DataLSB":"0x7070FF0","Repeat":0,"RawData":"+4575-4435+600-1635CdCdC-515C-520Ce+630-490CfCdCdCdCeCfCeCe+625hCdCdCdCdCeCe+605eCeCeIhCfCeJ-1630C-1640CdCdC-46710+4550bI-1610CdCdCeCfCfCfCeCdCdCdCfCfCfCeCeCdCdCdCdCeCfCeCfCfCfCfCfCdClCdCdC","RawDataInfo":[135,135,0]}}\n' +
    'tele/tasmota/600605/RESULT {"IrReceived":{"Protocol":"SAMSUNG","Bits":32,"Data":"0xE0E0E01F","DataLSB":"0x70707F8","Repeat":0,"RawData":"+4545-4435+600-1635CdCdC-520C-515CeCeCfCdCdCd+625-490CfGhCfCfCdCdC-1640CfCeCeCfCe+595eCfCeCdCdCdCdCdC-46710+4550bCdG-1610CdCfCfCeCfCfCdCdCdCeCeJeCfCeCdCdCdCeCeCeCfJeCeCeCeCdCdCiCdCdC","RawDataInfo":[135,135,0]}}';

  const SAMPLE_RAWDATA =
    '+4545-4440+600-1635CdC-1640C-520C-515Cf+605-510CfC-1630CdCjCgCfCfCfCgCf+595dCgHiHgCgCgCfCeHiCdCdCdCdCdCdC-46715AbCdCdCdKfCgCfCfCfCeCdCeCfKfCfCfCfCfKeCfCfCfKfCfCfCeCfCdCeKeKeKeCeClAbCdCeCdCfCgCfCfKfCeCeCeKfCfKfCfCfKfKeKfKfCfK-525+590fKfKeKfKeKeKeKeKeKeK';

  const SAMPLE_PRONTO =
    '0000 006D 0022 0000 00A8 00AD 0012 0043 0013 0043 0013 0041 0013 0018 0013 0018 0013 0018 0013 0017 0014 0017 0014 0041 0012 0043 0013 0043 0013 0017 0014 0017 0014 0017 0014 0017 0013 0018 0013 0017 0014 0041 0013 0018 0013 0017 0013 0018 0013 0018 0014 0017 0012 0018 0013 0043 0014 0017 0013 0041 0014 0041 0013 0041 0014 0041 0013 0041 0014 0041 0014 017C';

  function sampleLink(label: string, text: string): HTMLElement {
    const a = el('a', { href: '#', text: label });
    a.addEventListener('click', (e) => { e.preventDefault(); tasmotaTextarea.value = text; });
    return a;
  }

  const tasmotaBox = el('fieldset', { class: 'capture-mode' },
    el('legend', { text: 'Paste a capture' }),
    tasmotaTextarea,
    el('div', { class: 'capture-actions' },
      tasmotaBtn,
      clearBtn,
    ),
    el('div', { class: 'sample-links' },
      el('span', { class: 'muted', text: 'Try it:' }),
      sampleLink('Tasmota console dump (Power, Mute, vol+)', SAMPLE_TASMOTA),
      sampleLink('RawData (Power)', SAMPLE_RAWDATA),
      sampleLink('Pronto Hex (Power)', SAMPLE_PRONTO),
    ),
  );

  // --- mode 2: protocol + hex -------------------------------------------------
  // A transmitted frame is reported in two byte orders: the accumulated
  // value (Tasmota DataLSB / the "LSB" column of the sample code tables) and
  // the display value (Tasmota Data / the "Code"/"MSB" column). They are
  // per-byte bit reversals of each other, so the field must be labeled with
  // the byte order the pasted value came from.
  const hexProto = protoSelect();
  const hexLsbInput = el('input', { type: 'text', placeholder: 'DataLSB, e.g. 0x04FB09F6' });
  const hexMsbInput = el('input', { type: 'text', placeholder: 'Data, e.g. 0x20DF906F' });
  const hexBtn = el('button', { type: 'button', class: 'primary', text: 'Decode' });
  hexBtn.addEventListener('click', () => {
    try {
      const lsb = hexLsbInput.value.trim();
      const msb = hexMsbInput.value.trim();
      if (!lsb && !msb) {
        throw new Error('Enter a hex value in the Data (LSB) or Data (MSB) field');
      }
      const code = lsb
        ? converter.importLsb(hexProto.value, lsb)
        : converter.importMsb(hexProto.value, msb);
      handleDecoded([code]);
      hexLsbInput.value = '';
      hexMsbInput.value = '';
      if (lsb && msb) showNote('Both fields were filled; the Data (LSB) value was used.');
    } catch (e) {
      showError((e as Error).message);
    }
  });

  const hexBox = el('fieldset', { class: 'capture-mode' },
    el('legend', { text: 'Protocol and hex data (LSB or MSB)' }),
    el('p', { class: 'muted', text: 'Data (LSB) is the accumulated value — Tasmota DataLSB, the "LSB" column. Data (MSB) is the display value — Tasmota Data, the "Code" column. Fill the field matching the value you have.' }),
    el('div', { class: 'row' },
      el('label', { class: 'input-row' }, el('span', { text: 'Protocol' }), hexProto),
      el('label', { class: 'input-row' }, el('span', { text: 'Data (LSB)' }), hexLsbInput),
      el('label', { class: 'input-row' }, el('span', { text: 'Data (MSB)' }), hexMsbInput),
      hexBtn,
    ),
  );

  // --- mode 3: protocol/address/(subaddress)/function ------------------------
  const paramProto = protoSelect();
  const paramAddr = el('input', { type: 'text', placeholder: 'e.g. 4 or 0x10' });
  const paramSub = el('input', { type: 'text', placeholder: 'optional' });
  const paramCmd = el('input', { type: 'text', placeholder: 'e.g. 8' });
  const paramBtn = el('button', { type: 'button', class: 'primary', text: 'Decode' });
  paramBtn.addEventListener('click', () => {
    try {
      const addr = intOrUndefined(paramAddr.value);
      const cmd = intOrUndefined(paramCmd.value);
      if (addr === undefined || cmd === undefined) throw new Error('Address and function are required');
      const sub = intOrUndefined(paramSub.value);
      handleDecoded([
        converter.importCode(paramProto.value, { address: addr, subaddress: sub, command: cmd }),
      ]);
      paramAddr.value = '';
      paramSub.value = '';
      paramCmd.value = '';
    } catch (e) {
      showError((e as Error).message);
    }
  });

  const paramBox = el('fieldset', { class: 'capture-mode' },
    el('legend', { text: 'Protocol / address / subaddress / function' }),
    el('div', { class: 'row' },
      el('label', { class: 'input-row' }, el('span', { text: 'Protocol' }), paramProto),
      el('label', { class: 'input-row' }, el('span', { text: 'Address' }), paramAddr),
      el('label', { class: 'input-row' }, el('span', { text: 'Subaddress' }), paramSub),
      el('label', { class: 'input-row' }, el('span', { text: 'Function' }), paramCmd),
      paramBtn,
    ),
  );

  // Decode a pasted Tasmota dump. The tolerant parser extracts every record
  // it can find: IrReceived JSON objects buried among surrounding log text,
  // bare {"Protocol":...,"Data":...} JSON objects, and compact RawData
  // strings. One blob holding several captures therefore yields several
  // commands, and each one joins the session as a separate signal for the
  // IRDB lookup filter.
  // Detect a raw Pronto Hex string: starts with "0000" followed by hex
  // tokens separated by whitespace (e.g. "0000 006D 0022 0000 ...").
  function isProntoHex(text: string): boolean {
    return /^\s*0000\s+[0-9A-Fa-f]{4}\s+[0-9A-Fa-f]{4}\s+[0-9A-Fa-f]{4}\b/.test(text);
  }

  function decodeCapture(text: string): IRCode[] {
    const t = String(text ?? '').trim();
    if (!t) throw new Error('Paste a capture first');
    let codes: IRCode[];
    try {
      if (isProntoHex(t)) {
        codes = converter.importFormat('Pronto', t);
      } else {
        codes = converter.importFormat('Tasmota', t);
      }
    } catch (e) {
      throw new Error(`Could not decode capture: ${(e as Error).message}`);
    }
    if (!codes.length) {
      throw new Error('No IrReceived JSON objects or compact RawData found in the paste.');
    }
    return codes;
  }

  // --- decoded result + session ---------------------------------------------
  const summary = el('div', { class: 'capture-summary' });

  // A command's identity is its protocol and decoded data (or, when the data
  // word is missing, its address/subaddress/function) — the same values IRDB
  // matches on. Re-decoding the same command must not add a session copy.
  function codeKey(code: IRCode): string {
    if (code.data !== undefined) return `${code.protocol}\u0000${code.data}`;
    return `${code.protocol}\u0000${code.address}\u0000${code.subaddress}\u0000${code.command}`;
  }

  function handleDecoded(codes: IRCode[]): void {
    showNote('');
    if (!codes.length) return;
    const seen = new Set(session.map(codeKey));
    let skipped = 0;
    for (const code of codes) {
      const key = codeKey(code);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      session.push(new IRCode(code));
    }
    renderLatest(codes, skipped);
    renderSession();
    matchAll();
  }

  function renderLatest(codes: IRCode[], skipped: number): void {
    clear(summary);
    clear(result);
    summary.textContent = '';

    if (codes.length === 1) {
      renderSingleDecode(codes[0]);
      if (skipped) {
        result.append(el('p', {
          class: 'muted',
          text: `${skipped} duplicate${skipped === 1 ? '' : 's'} skipped — already in the session.`,
        }));
      }
      return;
    }

    const list = el('div', { class: 'capture-summary' });
    codes.forEach((c, i) => {
      list.append(el('span', {},
        el('b', { text: `#${i + 1} ` }),
        el('span', { class: 'datum', text: `${c.protocol} ${codeDataHex(c) || `${c.address}/${c.command}`}` }),
      ));
    });
    const added = codes.length - skipped;
    result.append(el('fieldset', {},
      el('legend', { text: `Decoded ${codes.length} commands` }),
      list,
      el('p', {
        class: 'muted',
        text: skipped
          ? `${added} new command${added === 1 ? '' : 's'} added to the session; ${skipped} duplicate${skipped === 1 ? '' : 's'} skipped.`
          : 'Every decoded command was added to the session, and the IRDB lookup now narrows against all of them together.',
      }),
    ));
  }

  function renderSingleDecode(code: IRCode): void {
    const fields: [string, string][] = [
      ['Protocol', code.protocol],
      ['Bits', String(code.bits)],
      ['Address', String(code.address)],
      ['Subaddress', code.subaddress === -1 ? '-1' : String(code.subaddress)],
      ['Function', String(code.command)],
      ['Data', codeDataHex(code) || '—'],
    ];
    for (const [label, value] of fields) {
      summary.append(el('span', {}, el('b', { text: `${label}: ` }), el('span', { class: 'datum', text: value })));
    }

    const actionBox = el('div', { class: 'capture-actions' });

    const addBtn = el('button', {
      type: 'button',
      class: 'primary',
      text: remote.hasDoc ? `Add to ${remote.docName}` : 'Add to remote',
    });
    addBtn.addEventListener('click', () => {
      remote.appendSignals([code]);
      renderSession();
      showNote('Added to the remote.');
    });
    actionBox.append(addBtn);

    let pronto: string | null = null;
    try {
      pronto = converter.exportCode(code, 'Pronto');
    } catch {
      pronto = null;
    }
    if (pronto) {
      const details = el('details', { class: 'pronto' },
        el('summary', { text: 'show Pronto hex' }),
        el('div', { class: 'pronto-body' },
          copyButton(pronto),
          el('code', { class: 'pronto-hex', text: pronto }),
        ),
      );
      actionBox.append(details);
    }

    let tasmota: string | null = null;
    try {
      tasmota = converter.exportCode(code, 'Tasmota');
    } catch {
      tasmota = null;
    }
    if (tasmota) {
      const copy = el('button', { type: 'button', text: 'Copy IRSend raw' });
      copy.addEventListener('click', () => {
        copyText(tasmota!)
          .then(() => showNote('IRSend command copied to clipboard.'))
          .catch(() => showNote('Could not copy to clipboard.'));
      });
      actionBox.append(copy);
    }

    let tasmotaJson: string | null = null;
    try {
      tasmotaJson = converter.exportCode(code, 'Tasmota', { style: 'json' });
    } catch {
      tasmotaJson = null;
    }
    if (tasmotaJson) {
      const copy = el('button', { type: 'button', text: 'Copy IRSend JSON' });
      copy.addEventListener('click', () => {
        copyText(tasmotaJson!)
          .then(() => showNote('JSON capture copied to clipboard.'))
          .catch(() => showNote('Could not copy to clipboard.'));
      });
      actionBox.append(copy);
    }

    result.append(el('fieldset', {},
      el('legend', { text: 'Decoded command' }),
      summary,
      actionBox,
    ));
  }

  function renderSession(): void {
    clear(sessionBox);
    if (!session.length) return;

    const list = el('ul', { class: 'session-list' });
    session.forEach((code, i) => {
      const addOne = el('button', { type: 'button', text: 'Add to remote' });
      addOne.addEventListener('click', () => {
        remote.appendSignals([code]);
        showNote('Added to the remote.');
      });
      const removeOne = el('button', { type: 'button', class: 'danger', text: 'Remove' });
      removeOne.addEventListener('click', () => {
        session.splice(i, 1);
        renderSession();
        matchAll();
      });
      // Each signal keeps its capture position; a name typed into the box
      // labels the button that was pressed to record it, in the order the
      // remote's buttons were pressed. Enter jumps to the next signal so the
      // list can be walked top to bottom.
      const nameInput = el('input', {
        type: 'text',
        class: 'session-name',
        value: code.alias ?? '',
        placeholder: 'Name this signal',
      });
      nameInput.addEventListener('input', () => { code.alias = nameInput.value; });
      nameInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const next = nameInput.closest('li')?.nextElementSibling
          ?.querySelector('.session-name') as HTMLInputElement | null;
        if (next) {
          next.focus();
          next.select();
        }
      });
      list.append(
        el('li', {},
          el('span', { class: 'muted', text: `#${i + 1} ` }),
          nameInput,
          el('span', { class: 'muted', text: ` — ${code.protocol}, ${codeDataHex(code) || `${code.address}/${code.command}`}` }),
          addOne,
          removeOne,
        ),
      );
    });

    const appendAll = el('button', {
      type: 'button',
      class: 'primary',
      text: remote.hasDoc ? `Append all to ${remote.docName}` : 'Create remote from session',
    });
    appendAll.addEventListener('click', () => {
      remote.appendSignals(session);
      showNote('Added to the remote.');
    });

    const clearAll = el('button', { type: 'button', text: 'Clear session' });
    clearAll.addEventListener('click', () => {
      session.length = 0;
      clear(sessionBox);
      clear(matchBox);
      showNote('Session cleared.');
    });

    sessionBox.append(
      el('fieldset', {},
        el('legend', { text: `Capture session (${session.length})` }),
        el('p', { class: 'muted', text: 'Signals stay in the order they were captured. Name each one in the box beside it, in sequence (Enter jumps to the next), to label the buttons as you pressed them on the remote.' }),
        list,
        el('div', { class: 'capture-actions' }, appendAll, clearAll),
      ),
    );
  }

  // --- IRDB + LIRC matching --------------------------------------------------
  let irdbIdx: IrdbIndex | undefined;
  let lircIdx: LircIndex | undefined;
  let indexLoaded = false;
  let matchSeq = 0;

  async function matchAll(): Promise<void> {
    const seq = ++matchSeq;
    clear(matchBox);
    if (!session.length) return;

    if (!indexLoaded) {
      showNote('Loading the search indexes\u2026');
      [irdbIdx, lircIdx] = await Promise.all([loadIrdbIndex(), loadLircIndex()]);
      indexLoaded = true;
      showNote('');
    }
    if (seq !== matchSeq) return;

    const matches: CodeMatch[] = session.map((code) => {
      const irdbExact = dedupe(irdbIdx?.exact[exactKey(code)] ?? []);
      const irdbLoose = dedupe(irdbIdx?.loose[looseKey(code)] ?? []).filter((e) => !irdbExact.some((x) => x.path === e.path && x.alias === e.alias));
      const lircExact = dedupe(lircIdx?.exact[exactKey(code)] ?? []);
      const lircLoose = dedupe(lircIdx?.loose[looseKey(code)] ?? []).filter((e) => !lircExact.some((x) => x.path === e.path && x.alias === e.alias));
      return { code, irdbExact, irdbLoose, lircExact, lircLoose };
    });

    const totalHits = matches.reduce((s, m) => s + m.irdbExact.length + m.irdbLoose.length + m.lircExact.length + m.lircLoose.length, 0);
    if (!totalHits && !irdbIdx && !lircIdx) {
      matchBox.append(
        el('fieldset', {},
          el('legend', { text: 'Find this remote' }),
          el('p', { class: 'muted', text: 'The search indexes could not be loaded. Check your connection and decode again.' }),
        ),
      );
      return;
    }

    // Render IRDB matches
    const irdbMatches = matches.map((m) => ({ code: m.code, exact: m.irdbExact, loose: m.irdbLoose }));
    const irdbTotal = irdbMatches.reduce((s, m) => s + m.exact.length + m.loose.length, 0);
    if (irdbTotal > 0 || irdbIdx) {
      const wrap = el('fieldset', {}, el('legend', { text: 'Find this remote in IRDB' }));
      if (irdbTotal > 0) {
        if (session.length === 1) {
          renderIrdbSingle(wrap, irdbMatches[0], irdbIdx!);
        } else {
          renderIrdbIntersection(wrap, irdbMatches, irdbIdx!);
        }
      } else {
        wrap.append(el('p', { class: 'muted', text: 'No IRDB device matches these codes.' }));
      }
      matchBox.append(wrap);
    }

    // Render LIRC matches
    const lircMatches = matches.map((m) => ({ code: m.code, exact: m.lircExact, loose: m.lircLoose }));
    const lircTotal = lircMatches.reduce((s, m) => s + m.exact.length + m.loose.length, 0);
    if (lircTotal > 0 || lircIdx) {
      const wrap = el('fieldset', {}, el('legend', { text: 'Find this remote in LIRC' }));
      if (lircTotal > 0) {
        if (session.length === 1) {
          renderLircSingle(wrap, lircMatches[0], lircIdx!);
        } else {
          renderLircIntersection(wrap, lircMatches, lircIdx!);
        }
      } else {
        wrap.append(el('p', { class: 'muted', text: 'No LIRC remote matches these codes.' }));
      }
      matchBox.append(wrap);
    }
  }

  // Some individual codes are so common (e.g. NEC address 0, function 9 is
  // shared by 118 devices) that dozens of unrelated devices in IRDB respond to
  // them. Transmitting such a code can operate several units at once, so the
  // match results for it are called into question up front. The warning is
  // keyed on the exact protocol/address/command code, not the address alone:
  // a big brand may reuse one address across device types with different
  // command sets, so a shared address by itself is not the risk.
  function renderOverlapWarnings(wrap: HTMLElement, codes: IRCode[], idx: { overlap: Record<string, number> }): void {
    const seen = new Set<string>();
    for (const code of codes) {
      const key = looseKey(code);
      if (seen.has(key)) continue;
      seen.add(key);
      const devices = idx.overlap[key];
      if (!devices) continue;
      wrap.append(el('p', {
        class: 'warning',
        text: `Common code — ${code.protocol} address ${code.address}, function ${code.command} is shared by ${devices} different devices in IRDB. Big brands reuse popular codes across product lines, so this exact signal can overlap with several different devices and transmit to unintended equipment (e.g. a fan or HDMI switch responding to a TV command). Verify which device actually reacts before trusting the match list.`,
      }));
    }
  }

  // --- IRDB rendering --------------------------------------------------------

  function renderIrdbSingle(wrap: HTMLElement, m: { code: IRCode; exact: IndexEntry[]; loose: IndexEntry[] }, idx: IrdbIndex): void {
    renderOverlapWarnings(wrap, [m.code], idx);
    if (!m.exact.length && !m.loose.length) {
      wrap.append(el('p', { class: 'muted', text: 'No IRDB device matches this code. You can still add it to a remote above.' }));
      return;
    }
    if (m.exact.length) {
      wrap.append(el('h3', { class: 'match-head', text: `Exact matches (${m.exact.length})` }));
      wrap.append(renderIrdbMatches(m.exact, idx));
    }
    if (m.loose.length) {
      wrap.append(el('h3', { class: 'match-head', text: `Possible matches \u2014 same address/function, subaddress differs (${m.loose.length})` }));
      wrap.append(renderIrdbMatches(m.loose, idx));
    }
  }

  function renderIrdbIntersection(wrap: HTMLElement, matches: { code: IRCode; exact: IndexEntry[]; loose: IndexEntry[] }[], idx: IrdbIndex): void {
    renderOverlapWarnings(wrap, matches.map((m) => m.code), idx);
    const perCode = matches.map((m) => {
      const paths = new Set([...m.exact, ...m.loose].map((e) => e.path));
      return { ...m, paths };
    });

    const dead = matches.filter((m) => m.exact.length + m.loose.length === 0);
    for (const d of dead) {
      const label = d.code.alias || `signal #${matches.indexOf(d) + 1}`;
      wrap.append(el('p', { class: 'muted', text: `"${label}" has no IRDB match, so no device can be identified from the session.` }));
    }

    const countLine = perCode.map((m, i) => {
      const label = m.code.alias || `signal #${i + 1}`;
      const n = m.exact.length + m.loose.length;
      return `${label}: ${n} potential match${n === 1 ? '' : 'es'}`;
    });
    wrap.append(el('p', { class: 'muted', text: `Potential IRDB matches \u2014 ${countLine.join(' \u00b7 ')}` }));

    const common = new Set<string>();
    for (const path of perCode[0].paths) {
      if (perCode.every((m) => m.paths.has(path))) common.add(path);
    }

    if (!common.size) {
      wrap.append(el('p', { class: 'muted', text: `No single IRDB device matches all ${matches.length} captured signals. Remove a signal from the session or capture more.` }));
      return;
    }

    const byPath = new Map(idx.devices.map((d) => [d.path, d]));
    const ul = el('ul', { class: 'match-list' });
    for (const path of common) {
      const dev = byPath.get(path);
      const title = dev ? `${dev.brand} ${dev.model}` : path;
      const detail = matches.map((m, i) => {
        const e = m.exact.find((x) => x.path === path) ?? m.loose.find((x) => x.path === path)!;
        const exact = m.exact.includes(e);
        return `#${i + 1} \u2192 "${e.alias}" (${exact ? 'exact' : 'loose'})`;
      }).join(', ');

      const openBtn = el('button', { type: 'button', class: 'primary', text: 'Open remote' });
      openBtn.addEventListener('click', async () => {
        try {
          openBtn.disabled = true;
          openBtn.textContent = 'Loading\u2026';
          await remote.loadDevice(path);
        } catch (e) {
          showError(`Could not load ${path}: ${(e as Error).message}`);
        } finally {
          openBtn.disabled = false;
          openBtn.textContent = 'Open remote';
        }
      });

      ul.append(
        el('li', {},
          el('div', { class: 'match-title', text: title }),
          el('div', { class: 'match-sub', text: detail }),
          openBtn,
        ),
      );
    }
    wrap.append(el('p', { class: 'muted', text: `Devices matching all ${matches.length} captured signals:` }));
    wrap.append(ul);
  }

  function renderIrdbMatches(entries: IndexEntry[], idx: IrdbIndex): HTMLElement {
    const ul = el('ul', { class: 'match-list' });
    const byPath = new Map(idx.devices.map((d) => [d.path, d]));
    for (const entry of entries) {
      const dev = byPath.get(entry.path);
      const title = dev ? `${dev.brand} ${dev.model}` : entry.path;
      const sub = dev ? `Subaddress ${dev.subaddress} \u2014 button "${entry.alias}"` : `Button "${entry.alias}"`;
      const loadBtn = el('button', { type: 'button', class: 'primary', text: 'Open remote' });
      loadBtn.addEventListener('click', async () => {
        try {
          loadBtn.disabled = true;
          loadBtn.textContent = 'Loading\u2026';
          await remote.loadDevice(entry.path);
        } catch (e) {
          showError(`Could not load ${entry.path}: ${(e as Error).message}`);
        } finally {
          loadBtn.disabled = false;
          loadBtn.textContent = 'Open remote';
        }
      });
      ul.append(
        el('li', {},
          el('div', { class: 'match-title', text: title }),
          el('div', { class: 'match-sub', text: sub }),
          loadBtn,
        ),
      );
    }
    return ul;
  }

  // --- LIRC rendering --------------------------------------------------------

  function renderLircSingle(wrap: HTMLElement, m: { code: IRCode; exact: IndexEntry[]; loose: IndexEntry[] }, idx: LircIndex): void {
    renderOverlapWarnings(wrap, [m.code], idx);
    if (!m.exact.length && !m.loose.length) {
      wrap.append(el('p', { class: 'muted', text: 'No LIRC remote matches this code. You can still add it to a remote above.' }));
      return;
    }
    if (m.exact.length) {
      wrap.append(el('h3', { class: 'match-head', text: `Exact matches (${m.exact.length})` }));
      wrap.append(renderLircMatches(m.exact, idx));
    }
    if (m.loose.length) {
      wrap.append(el('h3', { class: 'match-head', text: `Possible matches \u2014 same address/function, subaddress differs (${m.loose.length})` }));
      wrap.append(renderLircMatches(m.loose, idx));
    }
  }

  function renderLircIntersection(wrap: HTMLElement, matches: { code: IRCode; exact: IndexEntry[]; loose: IndexEntry[] }[], idx: LircIndex): void {
    renderOverlapWarnings(wrap, matches.map((m) => m.code), idx);
    const perCode = matches.map((m) => {
      const paths = new Set([...m.exact, ...m.loose].map((e) => e.path));
      return { ...m, paths };
    });

    const dead = matches.filter((m) => m.exact.length + m.loose.length === 0);
    for (const d of dead) {
      const label = d.code.alias || `signal #${matches.indexOf(d) + 1}`;
      wrap.append(el('p', { class: 'muted', text: `"${label}" has no LIRC match.` }));
    }

    const countLine = perCode.map((m, i) => {
      const label = m.code.alias || `signal #${i + 1}`;
      const n = m.exact.length + m.loose.length;
      return `${label}: ${n} potential match${n === 1 ? '' : 'es'}`;
    });
    wrap.append(el('p', { class: 'muted', text: `Potential LIRC matches \u2014 ${countLine.join(' \u00b7 ')}` }));

    const common = new Set<string>();
    for (const path of perCode[0].paths) {
      if (perCode.every((m) => m.paths.has(path))) common.add(path);
    }

    if (!common.size) {
      wrap.append(el('p', { class: 'muted', text: `No single LIRC remote matches all ${matches.length} captured signals.` }));
      return;
    }

    const byPath = new Map(idx.devices.map((d) => [d.path, d]));
    const ul = el('ul', { class: 'match-list' });
    for (const path of common) {
      const dev = byPath.get(path);
      const title = dev ? `${dev.brand} ${dev.remote}` : path;
      const detail = matches.map((m, i) => {
        const e = m.exact.find((x) => x.path === path) ?? m.loose.find((x) => x.path === path)!;
        const exact = m.exact.includes(e);
        return `#${i + 1} \u2192 "${e.alias}" (${exact ? 'exact' : 'loose'})`;
      }).join(', ');

      const openBtn = el('button', { type: 'button', class: 'primary', text: 'Open remote' });
      openBtn.addEventListener('click', async () => {
        try {
          openBtn.disabled = true;
          openBtn.textContent = 'Loading\u2026';
          const { fetchLircDevice } = await import('./store.js');
          const text = await fetchLircDevice(path);
          const { Converter: Conv } = await import('../lib/converter.js');
          const conv = new Conv();
          const codes = conv.importFormat('LIRC', text);
          await remote.loadFromCodes(codes, title);
        } catch (e) {
          showError(`Could not load ${path}: ${(e as Error).message}`);
        } finally {
          openBtn.disabled = false;
          openBtn.textContent = 'Open remote';
        }
      });

      ul.append(
        el('li', {},
          el('div', { class: 'match-title', text: title }),
          el('div', { class: 'match-sub', text: detail }),
          openBtn,
        ),
      );
    }
    wrap.append(el('p', { class: 'muted', text: `Remotes matching all ${matches.length} captured signals:` }));
    wrap.append(ul);
  }

  function renderLircMatches(entries: IndexEntry[], idx: LircIndex): HTMLElement {
    const ul = el('ul', { class: 'match-list' });
    const byPath = new Map(idx.devices.map((d) => [d.path, d]));
    for (const entry of entries) {
      const dev = byPath.get(entry.path);
      const title = dev ? `${dev.brand} ${dev.remote}` : entry.path;
      const sub = dev ? `Model ${dev.model} \u2014 button "${entry.alias}"` : `Button "${entry.alias}"`;
      const loadBtn = el('button', { type: 'button', class: 'primary', text: 'Open remote' });
      loadBtn.addEventListener('click', async () => {
        try {
          loadBtn.disabled = true;
          loadBtn.textContent = 'Loading\u2026';
          const { fetchLircDevice } = await import('./store.js');
          const text = await fetchLircDevice(entry.path);
          const { Converter: Conv } = await import('../lib/converter.js');
          const conv = new Conv();
          const codes = conv.importFormat('LIRC', text);
          await remote.loadFromCodes(codes, title);
        } catch (e) {
          showError(`Could not load ${entry.path}: ${(e as Error).message}`);
        } finally {
          loadBtn.disabled = false;
          loadBtn.textContent = 'Open remote';
        }
      });
      ul.append(
        el('li', {},
          el('div', { class: 'match-title', text: title }),
          el('div', { class: 'match-sub', text: sub }),
          loadBtn,
        ),
      );
    }
    return ul;
  }

  function dedupe(entries: IndexEntry[]): IndexEntry[] {
    const seen = new Set<string>();
    return entries.filter((e) => {
      const k = `${e.path}\u0000${e.alias}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  section.append(
    el('p', { class: 'muted', text: 'Decode one or more captured commands \u2014 Tasmota console dumps, Pronto Hex strings, protocol+hex values, or protocol/address/function parameters. The IRDB and LIRC search indexes intersect the matches so a remote can be pinned down from several captures. Session signals keep their capture order \u2014 name each one in sequence to label the buttons you pressed. Decoded signals can be appended to the remote editor and exported as a HAIR wig.' }),
    tasmotaBox,
    hexBox,
    paramBox,
    status,
    result,
    sessionBox,
    matchBox,
  );
}
