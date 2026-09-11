// LIRC index builder (pure, no DOM / fetch / IndexedDB).
//
// The lirc-remotes repository (https://sourceforge.net/p/lirc-remotes) stores
// one .lircd.conf per remote as <manufacturer>/<remote>.lircd.conf.  The whole
// repository is turned into an inverted code index at build time
// (scripts/build-lirc-index.mjs) and shipped as a single static JSON, so the
// browser never downloads the individual conf files.  The same types and key
// functions are reused by the UI for matching a captured command against the
// index, just like the IRDB index.

import { exactKey, looseKey, OVERLAP_MIN_DEVICES, type IndexEntry } from './indexer.js';
import { Converter } from './converter.js';
import type { IRCode } from './code.js';

export interface LircDevice {
  path: string; // manufacturer/remote.lircd.conf
  manufacturer: string;
  remote: string; // filename without .lircd.conf
  brand: string; // from header comment, falls back to manufacturer
  model: string; // from header comment, falls back to remote
  kind?: string;
  signals: number;
}

export interface LircSkipReport {
  parseErrors: number;
  noSupportedRows: number;
  singleProtocol: Record<string, number>;
  mixedProtocols: number;
}

export interface LircIndex {
  version: string;
  generator: number;
  builtAt: number;
  commitDate?: number;
  devices: LircDevice[];
  exact: Record<string, IndexEntry[]>;
  loose: Record<string, IndexEntry[]>;
  overlap: Record<string, number>;
  skipped: LircSkipReport;
  misses: number;
}

export interface LircIndexSource {
  path: string;
  text: string;
}

// Extract brand and model from the LIRC header comment block.  Most files
// contain lines like "# brand:  Samsung" and "# model no. of remote control:
// BN59-00603A".  The parser is tolerant of inconsistent whitespace.
function parseHeaderComments(text: string): { brand?: string; model?: string } {
  let brand: string | undefined;
  let model: string | undefined;
  for (const line of text.split('\n').slice(0, 30)) {
    const m = /^\s*#\s*brand\s*:\s*(.+?)\s*$/i.exec(line);
    if (m) brand = m[1];
    const m2 = /^\s*#\s*model(?:\s+no\.?\s+of\s+remote\s+control)?\s*:\s*(.+?)\s*$/i.exec(line);
    if (m2) model = m2[1];
  }
  return { brand, model };
}

// Parse the path into manufacturer and remote name.
export function parseLircPath(path: string): Omit<LircDevice, 'signals' | 'brand' | 'model'> {
  const parts = path.replace(/\\/g, '/').split('/');
  const filename = parts[parts.length - 1];
  const remote = filename.replace(/\.lircd\.conf$/i, '').replace(/\.conf$/i, '');
  const manufacturer = parts.length >= 2 ? parts[parts.length - 2] : 'unknown';
  return { path, manufacturer, remote };
}

const REPEAT_VARIANT_BASE: Record<string, string> = {
  NEC2: 'NEC',
  NECX2: 'NECX1',
  '48-NEC2': '48-NEC1',
};

function indexProtocolNames(code: IRCode): string[] {
  const names = [code.protocol];
  const base = REPEAT_VARIANT_BASE[code.protocol];
  if (base) names.push(base);
  return names;
}

function rowProtocols(text: string): Set<string> {
  const protocols = new Set<string>();
  // Look for protocol names in header flags (e.g. "flags SPACE_ENC|CONST_LENGTH")
  // and in the codes section (the converter may log unsupported protocols).
  for (const line of text.split(/\r?\n/)) {
    if (!/\S/.test(line)) continue;
    const flagMatch = /^\s*flags\s+(.+)/i.exec(line);
    if (flagMatch) {
      const flags = flagMatch[1].trim().split('|').map((f) => f.trim().toUpperCase());
      for (const f of flags) {
        if (f && f !== 'CONST_LENGTH' && f !== 'RAW_CODES' && f !== 'SPACE_ENC' &&
            f !== 'RC5' && f !== 'RC6' && f !== 'REPEAT_HEADER' &&
            f !== 'NO_HEAD_REP' && f !== 'CYCLEсужден' && f !== 'GENERIC') {
          protocols.add(f);
        }
      }
    }
  }
  return protocols;
}

export function buildLircIndex(
  sources: LircIndexSource[],
  opts: { version: string; generator?: number; builtAt?: number; commitDate?: number },
): LircIndex {
  const converter = new Converter();
  const devices: LircDevice[] = [];
  const exact: Record<string, IndexEntry[]> = {};
  const loose: Record<string, IndexEntry[]> = {};
  let misses = 0;
  const skipped: LircSkipReport = {
    parseErrors: 0,
    noSupportedRows: 0,
    singleProtocol: {},
    mixedProtocols: 0,
  };

  for (const src of sources) {
    let codes: IRCode[];
    try {
      codes = converter.importFormat('LIRC', src.text);
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

    // Skip files where every decoded code is UNKNOWN — those are unsupported
    // protocols the converter cannot match against.
    const supportedCodes = codes.filter((c) => c.protocol !== 'UNKNOWN');
    if (!supportedCodes.length) {
      misses++;
      skipped.noSupportedRows++;
      continue;
    }

    const { manufacturer, remote } = parseLircPath(src.path);
    const header = parseHeaderComments(src.text);
    devices.push({
      ...parseLircPath(src.path),
      brand: header.brand ?? manufacturer,
      model: header.model ?? remote,
      signals: supportedCodes.length,
    });

    for (const c of supportedCodes) {
      for (const name of indexProtocolNames(c)) {
        const ek = exactKey(c, name);
        (exact[ek] ??= []).push({ path: src.path, alias: c.alias });
        const lk = looseKey(c, name);
        (loose[lk] ??= []).push({ path: src.path, alias: c.alias });
      }
    }
  }

  devices.sort((a, b) => a.brand.localeCompare(b.brand));

  // Overlap detection (same logic as IRDB indexer).
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
