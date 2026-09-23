// HAIR wig (wireless infrared group) JSON import and export, ported from
// IR::Format::WIG, aligned with the format contract at
// https://github.com/DAB-LABS/HAIR/blob/main/docs/wig-format.md.
//
// The wig format is the portable IR code set format used by the HAIR Home
// Assistant integration (https://github.com/DAB-LABS/HAIR): one JSON file,
// one remote, raw Pronto hex as the payload. We emit hair-wig/3, the current
// recipe major: every signal carries an explicit ditto_count and
// bypass_protocol. On import, signals are decoded fresh through the
// registered protocols (the file never carries decoded fields) and each
// signal's transmit recipe is kept on the resulting IRCode.

import { IRCode } from '../code.js';
import type { Converter } from '../converter.js';
import { GcFormat } from './gc.js';

export const WIG_FORMAT_VERSION = 'hair-wig/3';

// Dittos are the NEC repeat frame specifically. The format contract says a
// non-NEC signal always reads 0, a raw (bypass) signal has no ditto grammar
// so it also reads 0, and the range is 0..20.
const NEC_FAMILY = new Set(['NEC', 'NEC2', 'NECX1', 'NECX2']);
const DITTO_MAX = 20;

// The format contract's size cap: 16 MB, raised from 1 MB for matrix wigs.
const MAX_BYTES = 16 * 1024 * 1024;

function clampDittoCount(code: IRCode): number {
  if (code.bypassProtocol) return 0;
  if (!NEC_FAMILY.has(code.protocol)) return 0;
  const d = code.dittoCount ?? 0;
  return Math.min(DITTO_MAX, Math.max(0, Math.trunc(d)));
}

// A button name for a signal that has none. IRDB rows sometimes carry an
// empty function name (e.g. ",JVC,3,-1,17"), so a code can reach export with
// an empty alias. The wig contract requires every signal to have a non-empty
// alias, so name a genuinely new unnamed command after its command number.
function unknownAlias(code: IRCode): string {
  const tag =
    code.command !== undefined ? String(code.command)
    : code.address !== undefined ? String(code.address)
    : '';
  return tag ? `UNKNOWN ${tag}` : 'UNKNOWN';
}

// The contract squashes kind to lowercase letters and digits (no separators),
// so "Sound Bar" and "sound-bar" both store as "soundbar".
function squashKind(kind: string): string {
  return (kind ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export interface WigOptions {
  name?: string;
  brand?: string;
  model?: string;
  kind?: string;
  notes?: string;
  origin?: string;
  wigId?: string;
  format?: string;
  // Additional top-level keys preserved verbatim. Unknown keys are tolerated
  // and kept by the format contract: a reader ignores what it does not know,
  // and an editor that re-saves a wig keeps them. This map carries them.
  extra?: Record<string, unknown>;
}

// A random UUID v4. Prefer the Web Crypto API when present (browser and
// modern Node); fall back to Math.random so the library also runs in Node
// versions without a global crypto object.
function newUuid(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant bits
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class WigFormat {
  // Generate a wig from one IRCode or an arrayref of them. Keys are emitted
  // in sorted order to match the Perl library's canonical JSON encoding.
  export(codes: IRCode | IRCode[], converter: Converter, opts: WigOptions = {}): string {
    const list = Array.isArray(codes) ? codes : [codes];

    const prontos = list.map((code) => converter.exportCode(code, 'Pronto'));

    // An unnamed signal that repeats a command already present under a real
    // button name is a duplicate, not a button: drop it. Unnamed commands
    // that are genuinely new are named UNKNOWN <command>. IRDB files carry
    // both forms, e.g. a blank row next to "TV" for the same command.
    const namedProntos = new Set<string>();
    list.forEach((code, i) => {
      if (code.alias) namedProntos.add(prontos[i]);
    });

    // Existing names reserve their aliases; named duplicates are kept as they
    // are. Only the synthesized UNKNOWN <command> names are made unique, so
    // they never collide with a real button or with each other.
    const used = new Set(list.map((code) => code.alias).filter(Boolean));
    const signals: Array<{ alias: string; pronto: string; ditto_count: number; bypass_protocol: boolean }> = [];
    list.forEach((code, i) => {
      if (code.alias) {
        signals.push({
          alias: code.alias,
          pronto: prontos[i],
          ditto_count: clampDittoCount(code),
          bypass_protocol: code.bypassProtocol ? true : false,
        });
        return;
      }
      if (namedProntos.has(prontos[i])) return;
      let alias = unknownAlias(code);
      if (used.has(alias)) {
        let n = 2;
        const base = alias;
        while (used.has(`${base}_${n}`)) n++;
        alias = `${base}_${n}`;
      }
      used.add(alias);
      signals.push({
        alias,
        pronto: prontos[i],
        ditto_count: clampDittoCount(code),
        bypass_protocol: code.bypassProtocol ? true : false,
      });
    });

    const wig: Record<string, unknown> = {
      format: opts.format ?? WIG_FORMAT_VERSION,
      name: opts.name ?? 'Untitled',
      wig_id: opts.wigId ?? newUuid(),
      origin: opts.origin ?? 'converted:ir-remote-tools',
      signals,
    };
    for (const key of ['brand', 'model', 'notes'] as const) {
      if (opts[key] !== undefined) wig[key] = opts[key];
    }
    const kind = squashKind(opts.kind ?? '');
    if (kind) wig.kind = kind;

    // Preserved keys land last so they win over the defaults above (a file
    // that came in with its own wig_id, origin, or notes keeps them).
    for (const [key, value] of Object.entries(opts.extra ?? {})) {
      // "commands" is the Global Caché payload the wig entry point swaps on
      // (a document with a commands list and no format is GC, not wig), so it
      // is never wig metadata and never rides along into a wig export; an
      // editor that preserves unknown keys keeps it until export, where it
      // must drop it.
      if (key === 'commands') continue;
      wig[key] = value;
    }

    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(wig).sort()) sorted[key] = wig[key];

    return JSON.stringify(sorted, null, 4) + '\n';
  }

  // Parse a wig JSON string and return an array of IRCode objects. alias,
  // ditto_count, and bypass_protocol are preserved on each code.
  //
  // Validation is all-or-nothing, per the format contract: a file either
  // validates completely or is rejected with a concrete, field-level reason
  // ("signals[3].pronto: ...") naming every problem at once. There is no such
  // thing as a half-imported wig.
  decode(input: string, converter: Converter): IRCode[] {
    if (input === undefined || input === null) throw new Error('No wig input provided');

    let text = String(input);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // Strip UTF-8 BOM

    const reasons: string[] = [];

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`wig: not valid JSON (${(e as Error).message})`);
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('wig: top level must be a JSON object');
    }

    if (text.length > MAX_BYTES) reasons.push('file: exceeds the 16 MB size cap');

    const wig = data as Record<string, unknown>;

    // A Global Caché IR database export (a "commands" list with raw Pronto
    // hex payloads, no hair-wig "format" field) carries the same signals a
    // wig does, so the wig entry point imports it interchangeably.
    if (wig.format === undefined && Array.isArray(wig.commands)) {
      return new GcFormat().decode(input, converter);
    }

    if (typeof wig.format !== 'string' || !/^hair-wig\/\d+$/.test(wig.format)) {
      reasons.push(`format: required to be hair-wig/1, hair-wig/2, or hair-wig/3 (got ${wig.format ?? 'nothing'})`);
    } else if (parseInt(wig.format.split('/')[1], 10) > 3) {
      reasons.push(`format: ${wig.format} is newer than this tool knows (hair-wig/1..3); update the tool`);
    }

    if (wig.climate !== undefined) {
      reasons.push('climate: climate (matrix) wigs are not supported by this tool');
    }

    if (typeof wig.name !== 'string' || wig.name.trim() === '') {
      reasons.push('name: required');
    }

    const signals = wig.signals;
    if (signals === undefined && wig.climate === undefined) {
      reasons.push('signals: required');
    } else if (signals !== undefined && !Array.isArray(signals)) {
      reasons.push('signals: must be a list');
    }

    if (wig.identifiers !== undefined) {
      if (wig.identifiers === null || typeof wig.identifiers !== 'object' || Array.isArray(wig.identifiers)) {
        reasons.push('identifiers: must be an object');
      } else {
        for (const [key, value] of Object.entries(wig.identifiers)) {
          const ok = (v: unknown): boolean =>
            typeof v === 'string' && v.length > 0 ||
            Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.length > 0);
          if (!ok(value)) reasons.push(`identifiers.${key}: must be a non-empty string or a non-empty list of non-empty strings`);
        }
      }
    }

    if (wig.supersedes !== undefined) {
      const ok = typeof wig.supersedes === 'string' ||
        Array.isArray(wig.supersedes) && wig.supersedes.every((s) => typeof s === 'string');
      if (!ok) reasons.push('supersedes: must be a string or a list of strings');
    }

    if (wig.origin !== undefined && typeof wig.origin !== 'string') {
      reasons.push('origin: must be a string');
    }

    if (Array.isArray(signals) && signals.length === 0 && wig.climate === undefined) {
      reasons.push('signals: must not be empty');
    }

    if (Array.isArray(signals)) {
      signals.forEach((sig, i) => {
        if (sig === null || typeof sig !== 'object' || Array.isArray(sig)) {
          reasons.push(`signals[${i}]: must be an object`);
          return;
        }
        const signal = sig as Record<string, unknown>;

        if (typeof signal.alias !== 'string' || signal.alias === '') {
          reasons.push(`signals[${i}].alias: required`);
        }

        if (typeof signal.pronto !== 'string' || signal.pronto.trim() === '') {
          reasons.push(`signals[${i}].pronto: required`);
        } else {
          try {
            converter.importFormat('Pronto', signal.pronto);
          } catch (e) {
            reasons.push(`signals[${i}].pronto: ${(e as Error).message}`);
          }
        }

        if (signal.ditto_count !== undefined && typeof signal.ditto_count !== 'number') {
          reasons.push(`signals[${i}].ditto_count: must be an integer`);
        }

        if (signal.bypass_protocol !== undefined && typeof signal.bypass_protocol !== 'boolean') {
          reasons.push(`signals[${i}].bypass_protocol: must be a boolean`);
        }

        if (signal.send_count !== undefined &&
            (typeof signal.send_count !== 'number' || !Number.isInteger(signal.send_count) || signal.send_count < 1)) {
          reasons.push(`signals[${i}].send_count: must be a positive integer`);
        }
      });
    }

    if (reasons.length) {
      throw new Error(`wig failed validation:\n${reasons.join('\n')}`);
    }

    const decoded: IRCode[] = [];
    for (const sig of signals as unknown[]) {
      const signal = sig as Record<string, unknown>;

      const code = converter.importFormat('Pronto', signal.pronto as string)[0];
      code.alias = signal.alias as string;
      const ditto = typeof signal.ditto_count === 'number' ? signal.ditto_count : 0;
      // Clamp to the contract range; a raw bypass signal has no ditto grammar.
      code.dittoCount = code.bypassProtocol ? 0 : Math.min(DITTO_MAX, Math.max(0, Math.trunc(ditto)));
      code.bypassProtocol = signal.bypass_protocol ? true : false;
      decoded.push(code);
    }

    return decoded;
  }
}
