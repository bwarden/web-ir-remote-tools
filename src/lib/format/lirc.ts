// LIRC remote definition format (.lircd.conf) import and export, ported from
// Protocol::IR::Format::LIRC.
//
// The LIRC format describes IR remotes in two encoding modes:
//
//   Protocol-based (SPACE_ENC): A remote header defines timing parameters
//   (header, one, zero, pre_data, post_data), and the codes section maps
//   button names to hex values. The signal is reconstructed from the
//   protocol rules.
//
//   Raw codes (RAW_CODES): Direct pulse/space microsecond values for
//   each button.
//
// decode() handles both import modes. export() produces protocol-based LIRC
// for known protocols (NEC, Samsung, JVC) and falls back to raw codes for
// everything else.

import { IRCode, bitReverseBytes } from '../code.js';
import type { BurstPair } from '../protocol.js';
import type { Converter } from '../converter.js';

// --- LIRC timing templates for known protocols ---------------------------

interface LircTemplate {
  bits: number;
  flags: string;
  header: [number, number];
  one: [number, number];
  zero: [number, number];
  ptrail: number;
  repeat: [number, number];
  pre_data_bits: number;
  pre_data: number;
  post_data_bits: number;
  post_data: number;
  gap: number;
  toggle_bit_mask: number;
  min_repeat: number;
}

const LIRC_TEMPLATES: Record<string, LircTemplate> = {
  NEC: {
    bits: 32,
    flags: 'SPACE_ENC|CONST_LENGTH',
    header: [9000, 4500],
    one: [560, 1690],
    zero: [560, 560],
    ptrail: 560,
    repeat: [9000, 2250],
    pre_data_bits: 0,
    pre_data: 0,
    post_data_bits: 0,
    post_data: 0,
    gap: 108000,
    toggle_bit_mask: 0,
    min_repeat: 1,
  },
  SAMSUNG: {
    bits: 32,
    flags: 'SPACE_ENC|CONST_LENGTH',
    header: [4500, 4500],
    one: [560, 1690],
    zero: [560, 560],
    ptrail: 560,
    repeat: [4500, 1690],
    pre_data_bits: 0,
    pre_data: 0,
    post_data_bits: 0,
    post_data: 0,
    gap: 108000,
    toggle_bit_mask: 0,
    min_repeat: 1,
  },
  JVC: {
    bits: 16,
    flags: 'SPACE_ENC|CONST_LENGTH',
    header: [8440, 4220],
    one: [526, 1276],
    zero: [526, 526],
    ptrail: 526,
    repeat: [8440, 2110],
    pre_data_bits: 0,
    pre_data: 0,
    post_data_bits: 0,
    post_data: 0,
    gap: 108000,
    toggle_bit_mask: 0,
    min_repeat: 1,
  },
};

// --- Parsed remote block ------------------------------------------------

interface LircRemote {
  name: string;
  bits: number;
  flags: string;
  eps: number;
  aeps: number;
  header: number[];
  one: number[];
  zero: number[];
  ptrail: number;
  repeat: number[];
  pre_data_bits: number;
  pre_data: number;
  post_data_bits: number;
  post_data: number;
  gap: number;
  toggle_bit_mask: number;
  min_repeat: number;
  frequency: number;
  codes: Array<[string, string]>;  // [button_name, hex_value]
  raw_codes: Array<[string, number[]]>; // [button_name, values]
}

// --- Import (decode) -----------------------------------------------------

function parseRemotes(text: string): LircRemote[] {
  const remotes: LircRemote[] = [];
  let remote: Partial<LircRemote> = {};
  let state: 'idle' | 'remote' | 'codes' | 'raw_codes' = 'idle';

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();

    // Skip blank lines and comments
    if (line === '' || line.startsWith('#')) continue;

    if (state === 'idle') {
      if (/^begin\s+remote$/i.test(line)) {
        remote = {};
        state = 'remote';
      }
    } else if (state === 'remote') {
      if (/^end\s+remote$/i.test(line)) {
        if (remote.name) remotes.push(remote as LircRemote);
        remote = {};
        state = 'idle';
      } else if (/^begin\s+codes$/i.test(line)) {
        state = 'codes';
        remote.codes = [];
      } else if (/^begin\s+raw_codes$/i.test(line)) {
        state = 'raw_codes';
        remote.raw_codes = [];
      } else {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx === -1) continue;
        const key = line.slice(0, spaceIdx);
        const val = line.slice(spaceIdx + 1).trim();

        switch (key) {
          case 'name':
            remote.name = val;
            break;
          case 'bits':
            remote.bits = Number(val);
            break;
          case 'flags':
            remote.flags = val;
            break;
          case 'eps':
            remote.eps = Number(val);
            break;
          case 'aeps':
            remote.aeps = Number(val);
            break;
          case 'header':
            remote.header = val.split(/\s+/).map(Number).slice(0, 2);
            break;
          case 'one':
            remote.one = val.split(/\s+/).map(Number).slice(0, 2);
            break;
          case 'zero':
            remote.zero = val.split(/\s+/).map(Number).slice(0, 2);
            break;
          case 'ptrail':
            remote.ptrail = Number(val);
            break;
          case 'repeat':
            remote.repeat = val.split(/\s+/).map(Number).slice(0, 2);
            break;
          case 'pre_data_bits':
            remote.pre_data_bits = Number(val);
            break;
          case 'pre_data':
            remote.pre_data = parseLircNumber(val);
            break;
          case 'post_data_bits':
            remote.post_data_bits = Number(val);
            break;
          case 'post_data':
            remote.post_data = parseLircNumber(val);
            break;
          case 'gap':
            remote.gap = Number(val);
            break;
          case 'toggle_bit_mask':
            remote.toggle_bit_mask = parseLircNumber(val);
            break;
          case 'toggle_bit':
            remote.toggle_bit_mask = parseLircNumber(val);
            break;
          case 'min_repeat':
            remote.min_repeat = Number(val);
            break;
          case 'frequency':
            remote.frequency = Number(val);
            break;
        }
      }
    } else if (state === 'codes') {
      if (/^end\s+codes$/i.test(line)) {
        state = 'remote';
      } else {
        // Strip inline comments before matching
        const clean = line.replace(/\s*#.*$/, '');
        const m = /^(\S+)\s+(0[xX][0-9A-Fa-f]+|\d+)\s*$/.exec(clean);
        if (m && remote.codes) {
          remote.codes.push([m[1], m[2]]);
        }
      }
    } else if (state === 'raw_codes') {
      if (/^end\s+raw_codes$/i.test(line)) {
        state = 'remote';
      } else {
        const nameM = /^name\s+(\S+)/.exec(line);
        if (nameM && remote.raw_codes) {
          remote.raw_codes.push([nameM[1], []]);
        } else if (/^[\d\s]+$/.test(line) && remote.raw_codes && remote.raw_codes.length > 0) {
          const vals = line.split(/\s+/).map(Number);
          remote.raw_codes[remote.raw_codes.length - 1][1].push(...vals);
        }
      }
    }
  }

  return remotes;
}

function parseLircNumber(val: string): number {
  if (/^0x/i.test(val)) return parseInt(val, 16);
  return Number(val);
}

// --- Protocol inference ---------------------------------------------------

function inferProtocol(remote: Partial<LircRemote>): string | undefined {
  const header = remote.header ?? [];
  const one = remote.one ?? [];
  const zero = remote.zero ?? [];

  // NEC: ~9000/4500 header, ~560/1690 one-bit
  if (
    header.length === 2 && header[0] >= 8500 && header[0] <= 10000 &&
    header[1] >= 3500 && header[1] <= 5500 &&
    one.length === 2 && one[0] >= 400 && one[0] <= 700 &&
    one[1] >= 1560 && one[1] <= 2000 &&
    zero.length === 2 && zero[0] >= 400 && zero[0] <= 700 &&
    zero[1] >= 300 && zero[1] <= 800
  ) {
    return 'NEC';
  }

  // Samsung: ~4500/4500 header, ~560/1690 one-bit
  if (
    header.length === 2 && header[0] >= 3500 && header[0] <= 5500 &&
    header[1] >= 3500 && header[1] <= 5500 &&
    one.length === 2 && one[0] >= 400 && one[0] <= 700 &&
    one[1] >= 1400 && one[1] <= 2000 &&
    zero.length === 2 && zero[0] >= 400 && zero[0] <= 700 &&
    zero[1] >= 300 && zero[1] <= 800
  ) {
    return 'SAMSUNG';
  }

  // JVC: ~8440/4220 header, ~526/1276 one-bit (wider tolerance)
  if (
    header.length === 2 && header[0] >= 7000 && header[0] <= 10000 &&
    header[1] >= 3000 && header[1] <= 5500 &&
    one.length === 2 && one[0] >= 400 && one[0] <= 700 &&
    one[1] >= 1000 && one[1] <= 1560 &&
    zero.length === 2 && zero[0] >= 400 && zero[0] <= 700 &&
    zero[1] >= 300 && zero[1] <= 800
  ) {
    return 'JVC';
  }

  return undefined;
}

// --- Decode protocol-based codes ------------------------------------------

function decodeProtocolCodes(remote: LircRemote, converter: Converter): IRCode[] {
  const codes: IRCode[] = [];
  const remoteName = remote.name ?? 'unknown';
  const bits = remote.bits ?? 0;
  const preDataBits = remote.pre_data_bits ?? 0;
  const preData = remote.pre_data ?? 0;
  const postDataBits = remote.post_data_bits ?? 0;
  const postData = remote.post_data ?? 0;

    const proto = inferProtocol(remote);

    // LIRC `SPACE_ENC` remotes store each transmitted word (pre_data,
    // post_data, and the code value) in the wire's accumulated byte order,
    // whose per-byte LSB-first reading the reduction below unwraps. A remote
    // flagged REVERSE stores each word bit-mirrored within its own declared
    // width instead — the same signal, written backwards. Restoring the wire
    // order first makes both encodings converge on one code: Vizio VX37L
    // (REVERSE, pre_data 0xFB04 + Power 0xF708) and LCD_TV (no REVERSE,
    // pre_data 0x20DF + Power 0x10EF) are the same NEC signal, the second
    // being the 16-bit mirror of the first.
    const hadPrePost = preDataBits > 0 || postDataBits > 0;
    const reversed = hadPrePost && /(^|\|)REVERSE(\||$)/i.test(remote.flags ?? '');
    const mirrorWord = (word: number, width: number): number => {
      if (width <= 0) return word;
      let out = 0;
      for (let i = 0; i < width; i++) {
        out += (Math.floor(word / 2 ** i) % 2) * 2 ** (width - 1 - i);
      }
      return out >>> 0;
    };

    for (const [buttonName, hexVal] of remote.codes ?? []) {
      let value = parseInt(hexVal, 16);

    // Mask to the declared bit width — LIRC files sometimes represent
    // 16-bit values as 48-bit hex (zero-padded), but only the low bits matter.
    if (bits > 0 && bits < 64) {
      const mask = bits >= 32 ? 0xFFFFFFFF : (1 << bits) - 1;
      value &= mask;
    }

    // Construct the full data word from pre_data, value, post_data.
    // Use unsigned arithmetic (>>> 0) to avoid signed 32-bit overflow when
    // shifting high bits into the sign position (e.g. Samsung pre_data).
    let fullData = reversed ? mirrorWord(value, bits) : value;
    if (preDataBits > 0) {
      const pre = reversed ? mirrorWord(preData, preDataBits) : preData;
      fullData = ((pre << bits) | fullData) >>> 0;
    }
    if (postDataBits > 0) {
      const post = reversed ? mirrorWord(postData, postDataBits) : postData;
      fullData = ((fullData << postDataBits) | post) >>> 0;
    }

    const totalBits = bits + preDataBits + postDataBits;

    // Route through the protocol's decodeRaw when available so the protocol
    // can store data in whatever internal form it uses (e.g. Samsung's
    // encodeData transforms display → accumulated, while NEC stores as-is).
    const protoHandler = proto ? converter.getProtocol(proto) : undefined;
    let code: IRCode;
    if (protoHandler) {
      // A code composed from pre_data/post_data carries the wire's accumulated
      // byte order (e.g. Vizio Power 0x20DF10EF from pre_data 0x20DF + value
      // 0x10EF) and must be reduced to the display form via decodeByteOrder —
      // exactly as WIG and CodesCSV NEC do — to land on 0x04FB08F7 (address 4,
      // subaddress -1, command 8) instead of decodeRaw's accumulated form
      // (address 32, command 16). A plain codes-section value is already in its
      // final form, so it keeps the raw decodeRaw path.
      if (hadPrePost && typeof protoHandler.decodeByteOrder === 'function') {
        code = protoHandler.decodeByteOrder(fullData, false);
      } else if (typeof protoHandler.decodeRaw === 'function') {
        code = protoHandler.decodeRaw(fullData);
      } else {
        code = new IRCode({ protocol: proto ?? 'UNKNOWN', bits: totalBits, data: fullData });
      }
      code.protocol = proto!;
    } else {
      code = new IRCode({ protocol: proto ?? 'UNKNOWN', bits: totalBits, data: fullData });
    }
    code.alias = buttonName;
    codes.push(code);
  }

  return codes;
}

// --- Decode raw codes -----------------------------------------------------

function decodeRawCodes(remote: LircRemote, converter: Converter): IRCode[] {
  const codes: IRCode[] = [];

  for (const [buttonName, values] of remote.raw_codes ?? []) {
    // Convert alternating pulse/space values to BurstPairs
    const pairs: BurstPair[] = [];
    for (let i = 0; i < values.length; i += 2) {
      pairs.push([values[i], values[i + 1] ?? 0]);
    }

    // Try timing-based decode through registered protocols
    let code: IRCode | null = null;
    for (const proto of converter.getProtocols()) {
      if (typeof proto.decodeTiming === 'function') {
        const decoded = proto.decodeTiming(pairs);
        if (decoded) {
          code = decoded;
          break;
        }
      }
    }
    code = code ?? new IRCode();

    // Store raw timings for lossless re-export (positive marks, negative spaces)
    const timings: number[] = [];
    for (let i = 0; i < values.length; i++) {
      timings.push((i % 2 === 0 ? 1 : -1) * values[i]);
    }
    code.timings = timings;
    code.alias = buttonName;
    codes.push(code);
  }

  return codes;
}

// --- Export ---------------------------------------------------------------

function dataHexForBits(val: number, bits: number): string {
  const bytes = Math.ceil(bits / 8);
  const hex = (val >>> 0).toString(16).toUpperCase().padStart(bytes * 2, '0');
  return '0x' + hex;
}

function lircCodeValue(code: IRCode, template: LircTemplate, converter: Converter): string {
  const data = code.data;
  if (data === undefined) return '0x00';

  const bits = template.bits ?? 32;
  const mask = bits >= 32 ? 0xFFFFFFFF : (1 << bits) - 1;

  // LIRC codes use the protocol's display/hex form. For most per-byte LSB-first
  // protocols (NEC, JVC, Samsung20), code.data already IS the display form because
  // decodeRaw stores the input as-is. Samsung is the exception: decodeRaw
  // transforms via encodeData, so code.data is the accumulated form and needs
  // byte-reversal to recover the display form.
  let val: number;
  if (typeof data === 'bigint') {
    val = Number(data & BigInt(mask));
  } else {
    const proto = converter.getProtocol(code.protocol);
    let raw = data;
    // Detect whether decodeRaw transforms the value: if calling decodeRaw on
    // the stored data produces a different value, the data is accumulated and
    // needs byte-reversal to reach the display form.
    if (typeof proto?.decodeRaw === 'function') {
      const probe = proto.decodeRaw(data);
      if (probe.data !== undefined && probe.data !== data) {
        raw = bitReverseBytes(data, bits);
      }
    }
    val = raw & mask;
  }

  return dataHexForBits(val, bits);
}

function exportProtocolRemote(
  remoteName: string,
  template: LircTemplate,
  codes: IRCode[],
  converter: Converter,
): string {
  let out = '';

  out += 'begin remote\n\n';
  out += `  name  ${remoteName}\n`;
  out += `  bits            ${template.bits}\n`;
  out += `  flags           ${template.flags}\n`;
  out += '  eps             30\n';
  out += '  aeps            100\n\n';
  out += `  header          ${template.header[0]}  ${template.header[1]}\n`;
  out += `  one             ${template.one[0]}  ${template.one[1]}\n`;
  out += `  zero            ${template.zero[0]}  ${template.zero[1]}\n`;
  out += `  ptrail          ${template.ptrail}\n`;
  out += `  repeat          ${template.repeat[0]}  ${template.repeat[1]}\n`;

  if (template.pre_data_bits > 0) {
    out += `  pre_data_bits   ${template.pre_data_bits}\n`;
    out += `  pre_data        0x${template.pre_data.toString(16).toUpperCase()}\n`;
  }
  if (template.post_data_bits > 0) {
    out += `  post_data_bits  ${template.post_data_bits}\n`;
    out += `  post_data       0x${template.post_data.toString(16).toUpperCase()}\n`;
  }

  out += `  gap             ${template.gap}\n`;
  out += `  toggle_bit_mask 0x${template.toggle_bit_mask.toString(16).toUpperCase()}\n`;
  out += `  min_repeat      ${template.min_repeat}\n`;

  out += '\n      begin codes\n';
  for (const code of codes) {
    const name = code.alias || 'UNKNOWN';
    const val = lircCodeValue(code, template, converter);
    out += `          ${name.padEnd(20)} ${val}\n`;
  }
  out += '      end codes\n\n';
  out += 'end remote\n\n';

  return out;
}

function exportRawRemote(
  remoteName: string,
  codes: IRCode[],
  converter: Converter,
): string {
  let out = '';

  out += 'begin remote\n\n';
  out += `  name  ${remoteName}\n`;
  out += '  flags RAW_CODES|CONST_LENGTH\n';
  out += '  eps            25\n';
  out += '  aeps          100\n\n';
  out += '  ptrail          0\n';
  out += '  repeat     0     0\n';
  out += '  gap    100000\n\n';
  out += '      begin raw_codes\n\n';

  for (const code of codes) {
    const name = code.alias || 'UNKNOWN';
    let timings = code.timings;

    // Try to generate timings via Pronto round-trip when not stored
    if (!timings || !timings.length) {
      try {
        const pronto = converter.exportCode(code, 'Pronto').trim();
        if (pronto && !pronto.startsWith('0000 0000')) {
          const imported = converter.importFormat('Pronto', pronto);
          if (imported.length && imported[0].timings) {
            timings = imported[0].timings;
          }
        }
      } catch {
        // skip
      }
    }

    if (timings && timings.length) {
      out += `          name ${name}\n`;
      const vals = timings.map((v) => Math.round(Math.abs(v)));
      // Format in groups of 8
      for (let i = 0; i < vals.length; i += 8) {
        const chunk = vals.slice(i, i + 8);
        out += '              ' + chunk.join('  ') + '\n';
      }
      out += '\n';
    }
  }

  out += '      end raw_codes\n\n';
  out += 'end remote\n\n';

  return out;
}

// --- Format class ---------------------------------------------------------

export interface LircExportOptions {
  name?: string;
}

export class LircFormat {
  decode(input: string, converter: Converter): IRCode[] {
    if (input === undefined || input === null) {
      throw new Error('No LIRC input provided');
    }

    const text = String(input).trim();
    if (!text) throw new Error('LIRC input is empty');

    const remotes = parseRemotes(text);
    if (!remotes.length) throw new Error("No 'begin remote' blocks found in LIRC input");

    const codes: IRCode[] = [];
    for (const remote of remotes) {
      const flags = remote.flags ?? '';
      const isRaw = /RAW_CODES/i.test(flags);

      if (isRaw) {
        codes.push(...decodeRawCodes(remote, converter));
      } else {
        codes.push(...decodeProtocolCodes(remote, converter));
      }
    }

    return codes;
  }

  export(codes: IRCode | IRCode[], converter: Converter, opts: LircExportOptions = {}): string {
    const list = Array.isArray(codes) ? codes : [codes];
    if (!list.length) throw new Error('No codes to export');

    const remoteName = opts.name ?? 'exported';
    let output = '';

    // Group codes by protocol for multi-button remotes
    const byProto = new Map<string, IRCode[]>();
    for (const code of list) {
      const proto = code.protocol ?? 'UNKNOWN';
      const arr = byProto.get(proto) ?? [];
      arr.push(code);
      byProto.set(proto, arr);
    }

    for (const [proto, protoCodes] of [...byProto.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const template = LIRC_TEMPLATES[proto.toUpperCase()];
      if (template) {
        output += exportProtocolRemote(remoteName, template, protoCodes, converter);
      } else {
        output += exportRawRemote(remoteName, protoCodes, converter);
      }
    }

    return output;
  }
}
