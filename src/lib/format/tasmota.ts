// Tasmota RawData import and IRSend export, ported from IR::Format::Tasmota.
//
// decode() accepts the content of a Tasmota "RawData" field, either as the
// compact letter-compressed form ("+8570-4240+550-1580C-510+565-1565F-505Fh...")
// or as a plain comma-separated mark/space list ("926,844,958,..."). The
// timings are decoded to microsecond mark/space pairs, tried against every
// registered protocol, and the resulting IRCode keeps the raw timings so the
// signal can be re-exported losslessly.
//
// Because a Tasmota dump is not always well-formed JSON, the parser is
// pattern-based rather than JSON-based. A dump may contain any mix of:
//
//   - IrReceived/RESULT JSON objects, single-line or pretty-printed, in any
//     key order, with or without "Protocol"/"Bits"/"Data" fields;
//   - IRrecv console lines ("Protocol = NEC, Bits = 32, Data = 0x10EF00FF")
//     with arbitrary whitespace, optionally followed by RawData;
//   - bare "RawData = ..." lines, compact or comma form;
//   - "IRsend <freq>,<rawdata>" command lines;
//   - log noise and timestamps, which are ignored.
//
// Multiple signals may share one textarea, one line, or one JSON dump. Each
// record is decoded independently. When a record carries RawData timings,
// those win and are decoded through the registered protocols: Tasmota's own
// structured decode has known failure modes (trailing bytes whose final bits
// are 0 get swallowed into the stop/gap run, mid-bundle frames go
// unreported, decodable signals are sometimes labeled UNKNOWN), so its
// Protocol/Data fields are only a fallback for records without usable
// timings. "Data" is IRremoteESP8266's decoded `value` and "DataLSB" the
// per-byte bit reversal Tasmota computes from it. For the per-byte LSB-first
// protocols (NEC, JVC, SAMSUNG) DataLSB is the accumulated form decodeRaw
// reads, so the structured fallback prefers it; for whole-word MSB-first
// protocols (SAMSUNG36) Data itself is accumulated and DataLSB is a display
// artifact.
// Either field is routed through the protocol's byte-order entry point, so
// the decoded address/subaddress/command always matches the transmitted
// bytes.
//
// export() produces a Tasmota IRSend raw command:
//   IRSend <frequency>,<rawdata>
// with the compact form by default, or the comma list with style => 'comma'.
// With style => 'json' it instead produces the IrReceived-style JSON object
// ("Protocol"/"Bits"/"Data"), ready to paste back into a Tasmota console or
// another tool that speaks that shape.

import { IRCode, bitReverseBytes, dataHex, toHex } from '../code.js';
import type { BurstPair } from '../protocol.js';
import type { Converter } from '../converter.js';

export interface TasmotaExportOptions {
  style?: 'compact' | 'comma';
  frequency?: number;
}

// Each new timing value gets the next letter (A-Z); a repeated value is
// written as that letter, uppercase for a HIGH (mark) signal and lowercase
// for a LOW (space) signal. Magnitudes are multiples of 5 microseconds.
const round5 = (v: number) => Math.floor((v + 2.5) / 5) * 5;

// The Tasmota compact encoding assigns letters (A-Z) to the first 26 distinct
// timing magnitudes in order of first appearance. A repeated value is written
// as its letter, uppercase for a mark and lowercase for a space. Values beyond
// the 26-letter table are written numerically every time they occur.
function decodeCompact(text: string): number[] {
  const values: number[] = [];
  const letterFor = new Map<number, string>(); // magnitude -> letter
  const rev = new Map<string, number>(); // letter -> magnitude
  let count = 0;
  const re = /([+\-]\d+|[A-Za-z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tok = m[1];
    const num = /^([+\-])(\d+)$/.exec(tok);
    if (num) {
      const mag = Number(num[2]);
      if (!letterFor.has(mag) && count < 26) {
        const letter = String.fromCharCode(65 + count++);
        letterFor.set(mag, letter);
        rev.set(letter, mag);
      }
      values.push((num[1] === '+' ? 1 : -1) * mag);
    } else {
      const up = tok.toUpperCase();
      if (!rev.has(up)) {
        throw new Error(`Tasmota compact format references undefined timing letter '${tok}'`);
      }
      const mag = rev.get(up)!;
      values.push(/^[A-Z]/.test(tok) ? mag : -mag);
    }
  }
  if (!values.length) throw new Error('Tasmota compact format contains no timing data');
  return values;
}

function encodeCompact(values: number[]): string {
  const out: string[] = [];
  const letterFor = new Map<number, string>();
  let next = 0;
  for (const v of values) {
    const sign = v < 0 ? '-' : '+';
    const mag = round5(Math.abs(v));
    if (!letterFor.has(mag)) {
      if (next < 26) letterFor.set(mag, String.fromCharCode(65 + next++));
      out.push(sign + mag);
    } else {
      const letter = letterFor.get(mag)!;
      out.push(sign === '+' ? letter.toUpperCase() : letter.toLowerCase());
    }
  }
  return out.join('');
}

// Normalize the various RawData forms into a flat list of signed timings,
// positive for marks and negative for spaces. Tolerates the surrounding
// "RawData = ..." / "IRsend <freq>,..." prefixes and JSON quotes that a user
// may paste along with the value.
function toSignedValues(input: number[] | string): number[] {
  if (input === undefined || input === null) {
    throw new Error('No Tasmota RawData provided');
  }

  if (Array.isArray(input)) {
    return input.map((v, i) => (i % 2 === 0 ? 1 : -1) * (Number(v) || 0));
  }

  let text = String(input).trim();
  // Accept a full "IRsend <freq>,<rawdata>" command line as well.
  text = text.replace(/^IRsend\s+\d+,/i, '');
  // Accept a bare "RawData = ..." / "RawData: ..." line.
  text = text.replace(/^RawData\s*[=:]\s*"?/i, '');
  text = text.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    text = text.slice(1, -1);
  }

  if (text.includes(',')) {
    return text.split(',').map((tok, i) => (i % 2 === 0 ? 1 : -1) * (Number(tok.trim()) || 0));
  }
  if (/[A-Za-z+\-]/.test(text)) return decodeCompact(text);
  throw new Error('Unrecognized Tasmota RawData input');
}

// Pattern-match a Protocol value and a Data value out of a signal record,
// tolerating both the JSON form ("Protocol":"NEC", ..., "Data":"0x...") and
// the loose console form (Protocol = NEC, Bits = 32, Data = 0x...), in any
// key order, with arbitrary whitespace and line breaks. Bits is not required:
// the protocol's own bit count is authoritative. When the record also carries
// a "DataLSB" field, that token is returned too.
//
// Tasmota reports two views of the same frame. "Data" is IRremoteESP8266's
// decoded `value`; "DataLSB" is the per-byte bit reversal Tasmota computes
// from it (e.g. Data=0x10EF00FF vs DataLSB=0x08F700FF for NEC, Data=0xC2CC
// vs DataLSB=0x4333 for a JVC VCR button, Data=0xE0E040BF vs DataLSB=
// 0x070702FD for SAMSUNG). For those per-byte LSB-first protocols the
// reversal is the accumulated form decodeRaw reads; for whole-word MSB-first
// SAMSUNG36 it is a display artifact and Data itself is the accumulated form
// (e.g. Data=0x400ED02F vs DataLSB=0x02700BF4). A code's identity is its
// decoded address/subaddress/command, not any packed byte order, so each
// field is routed through the protocol's byte-order-aware importer, with the
// protocol's lsbIsAccumulated declaration picking which field wins. Returns
// null when the record is not structured.
function parseStructured(text: string): { proto: string; data: string; dataLsb?: string } | null {
  // Protocol names may lead with digits and contain hyphens (48-NEC2,
  // JVC-48, SAMSUNG36).
  const protoM = /\bProtocol"?\s*[=:]\s*"?([A-Za-z0-9][A-Za-z0-9_+-]*)"?/i.exec(text);
  if (!protoM) return null;
  // \bData matches the standalone "Data" field but not the "Data" inside
  // "RawData" or "DataLSB", which have no word boundary before it.
  const dataM = /\bData"?\s*[=:]\s*"?((?:0[xX])?[0-9A-Fa-f]+)"?/i.exec(text);
  if (!dataM) return null;
  const lsbM = /\bDataLSB"?\s*[=:]\s*"?((?:0[xX])?[0-9A-Fa-f]+)"?/i.exec(text);
  return { proto: protoM[1], data: dataM[1], dataLsb: lsbM ? lsbM[1] : undefined };
}

// Split a Tasmota console dump into logical signal records. Tasmota emits one
// record per signal: an IrReceived/RESULT JSON object (single-line or
// pretty-printed across several lines), an IRrecv console line, an IRsend
// command line, or plain log noise. Multiple JSON objects may even share one
// line ("...}{...}"). Records are split on balanced braces so pretty-printed
// JSON stays together, and on newlines outside braces so plain log lines stay
// separate.
function splitRecords(text: string): string[] {
  const records: string[] = [];
  let buf = '';
  let depth = 0;
  let inString = false;
  const flush = () => {
    const s = buf.trim();
    if (s) records.push(s);
    buf = '';
  };
  for (const ch of text) {
    if (inString) {
      buf += ch;
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      buf += ch;
      continue;
    }
    if (ch === '{') {
      depth++;
      buf += ch;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) depth--;
      buf += ch;
      if (depth === 0) flush();
      continue;
    }
    if (ch === '\n') {
      if (depth > 0) buf += ' ';
      else flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return records;
}

// The button-name substitute used when a capture has no known key name: the
// code's "Data" hex value, width-matched to its bit count so it reads like
// Tasmota's Data field (0x030C for a 16-bit JVC frame, 0x10EF00FF for a
// 32-bit NEC frame, 0x03011000 for a 40-bit word). Never truncates to 32
// bits.
function dataAlias(code: IRCode): string {
  if (code.data === undefined) return '';
  return dataHex(code.data);
}

// Decode a raw timing value (compact, comma, or an IRsend command line) into
// an IRCode by trying every registered protocol decoder. The code keeps the
// raw signed timings so it re-exports losslessly; a signal no protocol
// recognizes is tagged UNKNOWN.
function decodeTimings(input: string | number[], converter: Converter): IRCode {
  const values = toSignedValues(input);

  const pairs: BurstPair[] = [];
  for (let i = 0; i < values.length; i += 2) {
    const mark = Math.abs(values[i]);
    const space = Math.abs(values[i + 1] ?? 0);
    pairs.push([mark, space]);
  }

  let code: IRCode | null = null;
  for (const proto of converter.getProtocols()) {
    const dec = proto as { decodeTiming?: (p: BurstPair[]) => IRCode | null };
    if (typeof dec.decodeTiming === 'function') {
      const decoded = dec.decodeTiming(pairs);
      if (decoded) {
        code = decoded;
        break;
      }
    }
  }
  code = code ?? new IRCode();
  code.timings = values;
  if (code.protocol !== 'UNKNOWN') code.alias = dataAlias(code);
  return code;
}

// Decode RawData timings, preferring whole-blob decoding. When that fails
// (material beyond a frame's end can defeat every protocol: a repeat header
// after the ~40 ms inter-frame gap, a truncated next frame), retry each
// gap-separated segment on its own.
function decodeTimingsSegmented(input: string | number[], converter: Converter): IRCode {
  const code = decodeTimings(input, converter);
  if (code.protocol !== 'UNKNOWN') return code;

  const values = Array.isArray(input) ? input : toSignedValues(input);
  let start = 0;
  for (let i = 2; i < values.length; i += 2) {
    if (Math.abs(values[i - 1]) >= 15000 && i < values.length - 1) {
      const segCode = decodeTimings(values.slice(start, i), converter);
      if (segCode.protocol !== 'UNKNOWN') {
        segCode.timings = code.timings;
        return segCode;
      }
      start = i;
    }
  }
  return code;
}

// Decode one signal record of a dump. When a record carries RawData timings,
// they are decoded through the registered protocols first and win: Tasmota's
// own structured decode has known failure modes (trailing bytes whose final
// bits are 0 get swallowed into the stop/gap run, frames mid-bundle go
// unreported, and decodable signals are sometimes labeled UNKNOWN). The
// structured (Protocol/Data) fields are only a fallback for records without
// usable timings. Signals no registered protocol recognizes are dropped
// (null).
function decodeRecord(record: string, converter: Converter): IRCode | null {
  // An IRsend command line, with or without a leading timestamp. The payload
  // after "IRsend <freq>," is the raw timing data.
  const irsendM = /\bIRsend\s+\d+\s*,(.+)$/i.exec(record);
  if (irsendM) {
    const code = decodeTimings(irsendM[1], converter);
    return code.protocol === 'UNKNOWN' ? null : code;
  }

  const rawM = /\bRawData"?\s*[=:]\s*"?([^"}\r\n]+)"?/i.exec(record);
  if (rawM) {
    const code = decodeTimingsSegmented(rawM[1], converter);
    if (code.protocol !== 'UNKNOWN') return code;
  }

  const structured = parseStructured(record);
  if (structured) {
    const { proto, data, dataLsb } = structured;
    try {
      // Tasmota's "Data" is IRremoteESP8266's decoded `value` and "DataLSB"
      // is the per-byte bit reversal Tasmota computes from it. For the
      // protocols that transmit each byte LSB-first (NEC, JVC, SAMSUNG) that
      // reversal is the accumulated form decodeRaw reads, so DataLSB wins;
      // for whole-word MSB-first protocols (SAMSUNG36) Data itself is the
      // accumulated form, so it wins.
      const lsbIsAccumulated = converter.getProtocol(proto)?.lsbIsAccumulated ?? true;
      const code = lsbIsAccumulated
        ? dataLsb !== undefined
          ? converter.importLsb(proto, dataLsb)
          : converter.importMsb(proto, data)
        : converter.importMsb(proto, data);
      if (!code.alias) code.alias = dataAlias(code);
      return code;
    } catch {
      // Unregistered protocol and no usable RawData: drop the record.
    }
  }
  return null;
}

// Derive a flat signed timing list for a fresh IRCode by round-tripping
// through the registered protocol encoder's Pronto output.
function timingsFromCode(irCode: IRCode, converter: Converter): number[] {
  const pronto = converter.exportCode(irCode, 'Pronto').trim();
  const tokens = pronto.split(/\s+/);
  if (tokens.length < 4) {
    throw new Error('Cannot derive Tasmota timings from protocol encoder output');
  }

  const freqWord = parseInt(tokens[1], 16);
  const carrier = freqWord > 0 ? Math.trunc(1000000.0 / (freqWord * 0.241246)) : 38000;
  const period = 1000000.0 / carrier;

  const pairCount = parseInt(tokens[2], 16) + parseInt(tokens[3], 16);
  const flat: number[] = [];
  for (let i = 0; i < pairCount; i++) {
    const idx = 4 + i * 2;
    const mark = parseInt(tokens[idx], 16) * period;
    const space = parseInt(tokens[idx + 1], 16) * period;
    flat.push(Math.round(mark), -Math.round(space));
  }
  return flat;
}

export class TasmotaFormat {
  decode(input: string | number[], converter: Converter): IRCode[] {
    if (input === undefined || input === null) {
      throw new Error('No Tasmota RawData provided');
    }

    // A multi-signal dump (a Tasmota console log of IRrecv lines, possibly
    // timestamp-prefixed, or several JSON objects that may even share one
    // line) splits into one signal per record.
    if (typeof input === 'string' && /([\r\n]|\}\s*\{)/.test(input)) {
      return this.decodeDump(input, converter);
    }

    if (typeof input === 'string') {
      // A protocol-structured record ("Protocol = NEC, Bits = 32, Data =
      // 0x...", JSON or loose form) or a RawData timing line, single record.
      // Precedence matches decodeRecord: timings win, structured fields are
      // the fallback for records whose timings do not decode.
      const rawM = /\bRawData"?\s*[=:]\s*"?([^"}\r\n]+)"?/i.exec(input);
      if (rawM) {
        const code = decodeTimingsSegmented(rawM[1], converter);
        if (code.protocol !== 'UNKNOWN') return [code];
      }
      const structured = parseStructured(input);
      if (structured) {
        const { proto, data, dataLsb } = structured;
        try {
          // Tasmota's "Data" is IRremoteESP8266's decoded `value` and
          // "DataLSB" is the per-byte bit reversal Tasmota computes from it.
          // For the protocols that transmit each byte LSB-first (NEC, JVC,
          // SAMSUNG) that reversal is the accumulated form decodeRaw reads,
          // so DataLSB wins; for whole-word MSB-first protocols (SAMSUNG36)
          // Data itself is the accumulated form, so it wins.
          const lsbIsAccumulated = converter.getProtocol(proto)?.lsbIsAccumulated ?? true;
          const code = lsbIsAccumulated
            ? dataLsb !== undefined
              ? converter.importLsb(proto, dataLsb)
              : converter.importMsb(proto, data)
            : converter.importMsb(proto, data);
          if (!code.alias) code.alias = dataAlias(code);
          return [code];
        } catch {
          // Unregistered protocol: fall through to the RawData timings.
        }
      }
      if (rawM) return [decodeTimings(rawM[1], converter)];
    }

    return [decodeTimings(input, converter)];
  }

  // Split a Tasmota console dump into its individual signals and decode each.
  // A dump may mix protocol-structured records ("Protocol = NEC, Bits = 32,
  // Data = 0x..."), RawData timing lines (compact or comma), and
  // "IRsend <freq>,<rawdata>" command lines, each one signal, in JSON or loose
  // form, in any order. Timestamps and other log noise are ignored. Signals
  // that fail to decode to a registered protocol are dropped.
  decodeDump(input: string | string[], converter: Converter): IRCode[] {
    if (input === undefined || input === null) {
      throw new Error('No Tasmota dump provided');
    }

    const text = Array.isArray(input) ? input.join('\n') : input;
    const codes: IRCode[] = [];
    for (const record of splitRecords(text)) {
      try {
        const code = decodeRecord(record, converter);
        if (code) codes.push(code);
      } catch {
        continue;
      }
    }
    return codes;
  }

  export(
    codes: IRCode | IRCode[],
    converter: Converter,
    opts: TasmotaExportOptions = {},
  ): string {
    const list = Array.isArray(codes) ? codes : [codes];
    if (list.length !== 1) throw new Error('Tasmota IRSend can only export a single signal');
    const irCode = list[0];

    const style = String(opts.style ?? 'compact').toLowerCase();
    if (style !== 'compact' && style !== 'comma' && style !== 'json') {
      throw new Error(`Unsupported Tasmota export style: ${style}`);
    }

    if (style === 'json') {
      const obj: Record<string, string | number> = {
        Protocol: irCode.protocol,
        Bits: irCode.bits,
      };
      const data = dataAlias(irCode);
      if (data) {
        // Tasmota reports both views of a frame: "Data" is the display form
        // and "DataLSB" the accumulated form for the per-byte LSB-first
        // protocols (NEC, JVC, SAMSUNG). Whole-word MSB-first protocols
        // (SAMSUNG36) are the other way around: Data is itself the
        // accumulated form and DataLSB the per-byte reversal artifact.
        // Emit the pair in the protocol's declared order so a pasted-back
        // capture decodes to the same address/subaddress/command whatever
        // importer reads it.
        if (
          typeof converter.getProtocol(irCode.protocol)?.decodeByteOrder === 'function' &&
          typeof irCode.data === 'number'
        ) {
          const reversed = dataHex(bitReverseBytes(irCode.data, irCode.bits));
          const lsbIsAccumulated = converter.getProtocol(irCode.protocol)?.lsbIsAccumulated ?? true;
          if (lsbIsAccumulated) {
            obj.Data = reversed;
            obj.DataLSB = data;
          } else {
            obj.Data = data;
            obj.DataLSB = reversed;
          }
        } else {
          obj.Data = data;
        }
      }
      return JSON.stringify(obj);
    }

    const timings = irCode.timings ?? timingsFromCode(irCode, converter);
    const freq = opts.frequency !== undefined ? Number(opts.frequency) : 0;
    let data: string;
    if (style === 'compact') {
      data = encodeCompact(timings);
    } else {
      data = timings.map((v) => Math.round(Math.abs(v))).join(',');
    }
    return `IRSend ${freq},${data}`;
  }
}
