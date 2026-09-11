// IRDB index builder (pure, no DOM / fetch / IndexedDB).
//
// IRDB (probonopd/irdb) stores one CSV per device as
// <brand>/<devicetype>/<device>,<subdevice>.csv. The whole repository is
// turned into an inverted code index at build time (scripts/build-index.mjs)
// and shipped as a single static JSON, so the browser never downloads the
// individual CSVs. The same types and key functions are reused by the UI for
// matching a captured command against the index.

import { kindForDevicetype } from './irdb.js';
import { Converter } from './converter.js';
import { parseCsvLine } from './format/csv.js';
import { IRCode } from './code.js';

// Bit-reverse a byte (8 bits), used for NECx2 ↔ SAMSUNG cross-protocol mapping.
// Samsung protocol transmits address and command bytes bit-reversed relative to
// NECx2, so the same physical signal decodes to different values depending on
// the protocol label.  Indexing NECx2 entries under their Samsung equivalents
// lets a Samsung capture find IRDB entries and vice versa.
function reverseByte(val: number): number {
  let out = 0;
  for (let i = 0; i < 8; i++) {
    out |= ((val >> i) & 1) << (7 - i);
  }
  return out;
}

// Cross-protocol aliases: when a code is indexed under one of these protocols,
// it is also reachable under the mapped protocol with bit-reversed address and
// command.  Only protocols with identical timing signatures and compatible frame
// layouts belong here.
const CROSS_PROTOCOL: Record<string, (code: IRCode) => IRCode> = {
  // NECX2 ↔ SAMSUNG: same 4500/4500 us header, 560/1680 us bit timing,
  // 32 bits, per-byte LSB-first.  Samsung enforces addr,addr,cmd,~cmd while
  // NECX2 allows addr,subaddr,cmd,~cmd; the Samsung address is the bit-
  // reversal of the NECX2 device byte, and likewise for the command.
  NECX2: (code) => new IRCode({
    ...code,
    protocol: 'SAMSUNG',
    address: reverseByte(code.address),
    subaddress: -1,
    command: reverseByte(code.command),
  }),
};

export interface IrdbDevice {
  path: string; // brand/model/address,subaddress.csv (no leading codes/)
  brand: string;
  model: string; // IRDB directory name, e.g. "CAMERA_PRC-100S"
  address: string; // pre-comma filename part, e.g. "32"
  subaddress: string; // post-comma filename part, e.g. "-1"
  kind?: string;
  signals: number;
}

export interface IndexEntry {
  path: string;
  alias: string;
}

// An individual code is "overlapping" when the exact protocol/address/command
// is shared across this many different devices. A captured signal matching
// such a code probably collides with unrelated equipment, so the UI warns.
// The unit is the code, not the address: big brands reuse the same address for
// different device types, each with its own set of commands, so a common
// address alone (e.g. NEC address 1, 36 devices but ≤28 per command) is not
// the risk — a specific code shared across many devices is.
export const OVERLAP_MIN_DEVICES = 35;

// Why some IRDB files end up not indexed, counted during the build. Every
// skip is one of two things: the file failed to parse, or it parsed but every
// row used a protocol the converter does not decode. The latter is far more
// common — IRDB spans dozens of protocols (RC5, Sony, Panasonic, …) while the
// build only handles the NEC family (including 48-NEC1/48-NEC2), JVC
// (including JVC-48), Samsung, Samsung20, and Samsung36 — so the report also
// records which unsupported protocols appear. A file whose rows all share one
// protocol counts toward that protocol; a file mixing several counts toward
// `mixedProtocols`.
export interface IrdbSkipReport {
  parseErrors: number;
  noSupportedRows: number;
  singleProtocol: Record<string, number>; // unsupported protocol token → files using only that one
  mixedProtocols: number;
}

export interface IrdbIndex {
  version: string; // IRDB commit the index was built from
  generator: number; // indexer schema version; bumped when the shape changes
  builtAt: number;
  commitDate?: number; // epoch ms of the upstream commit, if known
  devices: IrdbDevice[];
  exact: Record<string, IndexEntry[]>;
  loose: Record<string, IndexEntry[]>;
  overlap: Record<string, number>; // "protocol|address|command" → distinct devices sharing that exact code (codes above OVERLAP_MIN_DEVICES only)
  skipped: IrdbSkipReport; // why files were left out, for the build summary
  misses: number;
}

export interface IndexSource {
  path: string;
  text: string;
}

export function parseDevicePath(path: string): Omit<IrdbDevice, 'signals'> {
  const m = /^([^/]+)\/([^/]+)\/([^,]+),([^/]+)$/.exec(path);
  if (!m) return { path, brand: path, model: path, address: '', subaddress: '' };
  const model = m[2];
  return {
    path,
    brand: m[1],
    model,
    address: m[3],
    subaddress: m[4].replace(/\.csv$/i, ''),
    kind: kindForDevicetype(model),
  };
}

// Match keys from a decoded code. `exact` requires the subaddress byte to
// agree; `loose` ignores it (NEC files disagree about -1 vs 0 subdevices).
// The protocol name may be overridden when keying a code under an alias.
export function exactKey(code: IRCode, protocol: string = code.protocol): string {
  return `${protocol}|${code.address}|${code.subaddress ?? -1}|${code.command}`;
}

export function looseKey(code: IRCode, protocol: string = code.protocol): string {
  return `${protocol}|${code.address}|${code.command}`;
}

// Repeat variants ("2" members of the NEC family) share the base variant's
// single-frame timing signature, so a raw capture of one always decodes to the
// base protocol name (converter.ts: NEC absorbs NEC2, 48-NEC1 absorbs
// 48-NEC2, NECX1 absorbs NECX2). Rows carrying such a variant must therefore
// also be reachable under the base name, or a captured signal would never find
// them. The base rows are not keyed under the variant name in return: nothing
// decodes to a "2" variant from timing, so those keys would be dead weight.
const REPEAT_VARIANT_BASE: Record<string, string> = {
  NEC2: 'NEC',
  NECX2: 'NECX1',
  '48-NEC2': '48-NEC1',
};

// The protocol names a code must be indexed under: its own (so by-name imports
// keep the variant identity) plus, for a repeat variant, its base.
function indexProtocolNames(code: IRCode): string[] {
  const names = [code.protocol];
  const base = REPEAT_VARIANT_BASE[code.protocol];
  if (base) names.push(base);
  return names;
}

// The distinct raw protocol tokens a CSV file's rows use (excluding the
// header's own "protocol" label), used to explain why a file produced no
// decodable codes.
function rowProtocols(text: string): Set<string> {
  const protocols = new Set<string>();
  for (const line of String(text).split(/\r?\n/)) {
    if (!/\S/.test(line)) continue;
    const fields = parseCsvLine(line);
    if (fields.length < 2) continue;
    const token = fields[1].trim().toUpperCase();
    if (token && token !== 'PROTOCOL') protocols.add(token);
  }
  return protocols;
}

export function buildIrdbIndex(
  sources: IndexSource[],
  opts: { version: string; generator?: number; builtAt?: number; commitDate?: number },
): IrdbIndex {
  const converter = new Converter();
  const devices: IrdbDevice[] = [];
  const exact: Record<string, IndexEntry[]> = {};
  const loose: Record<string, IndexEntry[]> = {};
  let misses = 0;
  const skipped: IrdbSkipReport = {
    parseErrors: 0,
    noSupportedRows: 0,
    singleProtocol: {},
    mixedProtocols: 0,
  };

  for (const src of sources) {
    let codes: IRCode[];
    try {
      codes = converter.importFormat('CSV', src.text);
    } catch {
      misses++;
      skipped.parseErrors++;
      continue;
    }
    if (!codes.length) {
      misses++;
      skipped.noSupportedRows++;
      const protocols = rowProtocols(src.text);
      if (protocols.size === 1) {
        const [only] = protocols;
        skipped.singleProtocol[only] = (skipped.singleProtocol[only] ?? 0) + 1;
      } else if (protocols.size > 1) {
        skipped.mixedProtocols++;
      }
      continue;
    }
    devices.push({ ...parseDevicePath(src.path), signals: codes.length });
    for (const c of codes) {
      for (const name of indexProtocolNames(c)) {
        const ek = exactKey(c, name);
        (exact[ek] ??= []).push({ path: src.path, alias: c.alias });
        const lk = looseKey(c, name);
        (loose[lk] ??= []).push({ path: src.path, alias: c.alias });
      }
      // Cross-protocol aliases: e.g. NECx2 entries are also reachable as SAMSUNG.
      const alias = CROSS_PROTOCOL[c.protocol]?.(c);
      if (alias) {
        const ek = exactKey(alias);
        (exact[ek] ??= []).push({ path: src.path, alias: c.alias });
        const lk = looseKey(alias);
        (loose[lk] ??= []).push({ path: src.path, alias: c.alias });
      }
    }
  }

  devices.sort((a, b) => a.brand.localeCompare(b.brand));

  // Which individual codes are shared across many devices. The unit is the
  // exact protocol/address/command code (from the loose key space, so devices
  // that only disagree about a -1/0 subaddress still collide), because an
  // address alone is not the risk: big brands reuse one address for different
  // device types, each with its own set of commands. Only codes used by
  // OVERLAP_MIN_DEVICES or more devices are flagged, so a "common address,
  // fragmented commands" family like NEC address 1 (36 devices, ≤28 per
  // command) stays quiet.
  const byCode = new Map<string, Set<string>>();
  for (const [lk, entries] of Object.entries(loose)) {
    const paths = byCode.get(lk) ?? new Set();
    for (const e of entries) paths.add(e.path);
    byCode.set(lk, paths);
  }
  const overlap: Record<string, number> = {};
  const overlapping = [...byCode.entries()]
    .filter(([, paths]) => paths.size >= OVERLAP_MIN_DEVICES)
    .sort((a, b) => b[1].size - a[1].size);
  for (const [code, paths] of overlapping) overlap[code] = paths.size;

  return {
    version: opts.version,
    generator: opts.generator ?? 1,
    builtAt: opts.builtAt ?? Date.now(),
    commitDate: opts.commitDate,
    devices,
    exact,
    loose,
    overlap,
    skipped,
    misses,
  };
}
