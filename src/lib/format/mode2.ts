// Mode2 pulse/space capture import and export, the native format of the LIRC
// `mode2` tool and the MQTT IR test rig's receiver topic ("hear back timings").
//
// A mode2 capture is one timing per line: "pulse 417" and "space 1251", in
// microseconds, strictly alternating. Consecutive messages are separated by an
// inter-message space far wider than any in-frame timing; the log splits on a
// space of 10000 us or more (lirc's default gap), keeping the separator in the
// message so the final space is part of the decoded signal.
//
// decode() reads the whole capture, splits it into messages, decodes each
// through every registered protocol decoder, and returns one IRCode per
// message with its raw timings kept, so a re-export is lossless. Messages with
// no mark at all (the doubled-gap dead air between two separators) are dropped;
// signals no protocol recognizes are kept as UNKNOWN rather than discarded,
// because a capture is a record of what was on the air, not a filter.
//
// export() writes one message as alternating pulse/space lines, ensuring the
// message ends on a space wide enough (>= 10000 us) that re-importing the file
// splits messages back at the same boundaries.

import { IRCode, dataHex } from '../code.js';
import type { BurstPair } from '../protocol.js';
import type { Converter } from '../converter.js';

// lirc's default inter-message gap: any space this wide separates messages.
const SPLIT = 10000;
// The gap written at the end of an exported message that does not already end
// on a wide space. Far above any in-frame timing and well past SPLIT.
const EXPORT_GAP = 100000;

// Split a flat signed timing list into messages on spaces of SPLIT us or
// more, keeping the separator in the message that precedes it.
function splitMessages(flat: number[]): number[][] {
  const msgs: number[][] = [];
  let cur: number[] = [];
  for (const v of flat) {
    cur.push(v);
    if (v < 0 && -v >= SPLIT) {
      msgs.push(cur);
      cur = [];
    }
  }
  if (cur.length) msgs.push(cur);
  return msgs;
}

// Decode one message's flat signed timings (positive marks, negative spaces)
// into an IRCode by trying every registered protocol decoder. The code keeps
// the raw timings so it re-exports losslessly; a signal no protocol recognizes
// is tagged UNKNOWN.
function decodeMessage(values: number[], converter: Converter): IRCode {
  const pairs: BurstPair[] = [];
  for (let i = 0; i < values.length; i += 2) {
    pairs.push([Math.abs(values[i]), Math.abs(values[i + 1] ?? 0)]);
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
  if (code.protocol !== 'UNKNOWN') code.alias = dataHex(code.data ?? 0);
  return code;
}

// Derive a flat signed timing list for a fresh IRCode by round-tripping
// through the registered protocol encoder's Pronto output.
function timingsFromCode(irCode: IRCode, converter: Converter): number[] {
  const pronto = converter.exportCode(irCode, 'Pronto').trim();
  const tokens = pronto.split(/\s+/);
  if (tokens.length < 4) {
    throw new Error('Cannot derive Mode2 timings from protocol encoder output');
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

export class Mode2Format {
  decode(input: string | string[], converter: Converter): IRCode[] {
    if (input === undefined || input === null) {
      throw new Error('No Mode2 capture provided');
    }

    const text = Array.isArray(input) ? input.join('\n') : String(input);
    const flat: number[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(pulse|space)\s+(\d+)/i.exec(line);
      if (!m) continue;
      flat.push((m[1].toLowerCase() === 'pulse' ? 1 : -1) * Number(m[2]));
    }
    if (!flat.length) throw new Error('No Mode2 timings found');

    const codes: IRCode[] = [];
    for (const msg of splitMessages(flat)) {
      // The dead air between two separators (a doubled gap) has no mark.
      if (!msg.some((v) => v > 0)) continue;
      codes.push(decodeMessage(msg, converter));
    }
    return codes;
  }

  export(codes: IRCode | IRCode[], converter: Converter): string {
    const list = Array.isArray(codes) ? codes : [codes];
    const lines: string[] = [];
    for (const code of list) {
      const timings = (code.timings ?? timingsFromCode(code, converter)).slice();
      const last = timings[timings.length - 1];
      if (last > 0) {
        // Ends on a mark: append an inter-message gap.
        timings.push(-EXPORT_GAP);
      } else if (-last < SPLIT) {
        // Ends on a space too short to split on: widen it into the gap.
        timings[timings.length - 1] = -EXPORT_GAP;
      }
      for (const v of timings) {
        lines.push(`${v > 0 ? 'pulse' : 'space'} ${Math.round(Math.abs(v))}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}
