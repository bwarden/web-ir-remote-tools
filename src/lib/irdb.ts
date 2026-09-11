// IRDB (https://github.com/probonopd/irdb) CDN access for the browser.
//
// IRDB stores remote control codes as CSV files named
// <manufacturer>/<devicetype>/<device>,<subdevice>.csv. The files are served
// from the probonopd/irdb repository through a CDN on demand; the jsDelivr
// flat-structure API provides the file list for a browser-side picker.

export const IRDB_BASE = 'https://cdn.jsdelivr.net/gh/probonopd/irdb@master/codes';
export const IRDB_INDEX = 'https://data.jsdelivr.com/v1/packages/gh/probonopd/irdb@master?structure=flat';

export interface IrdbMeta {
  brand?: string;
  model?: string;
  kind?: string;
}

// Normalize a repository path: tolerate a leading "codes/" (as in the index
// file) and a missing ".csv" extension.
export function irdbRepoPath(spec: string): string {
  let path = spec;
  path = path.replace(/^\//, '');
  path = path.replace(/^codes\//, '');
  path = path.replace(/\/$/, '');
  if (!/\.csv$/i.test(path)) path += '.csv';
  if (!/^[^/]+\/[^/]+\/[^/]+\.csv$/i.test(path)) {
    throw new Error(`Expected MANUFACTURER/DEVICETYPE/DEVICE,SUBDEVICE.csv, got: ${spec}`);
  }
  return path;
}

// Map IRDB device-type directories to HAIR kind slugs; fall back to a
// lowercased slug when there is no known mapping.
const KIND: Record<string, string> = {
  TV: 'tv',
  AC: 'ac',
  AIRCONDITIONER: 'ac',
  'AIR CONDITIONER': 'ac',
  AMPLIFIER: 'amplifier',
  AMP: 'amplifier',
  AUDIO: 'audio',
  BLURAY: 'bluray',
  'BLU-RAY': 'bluray',
  DVD: 'dvd',
  DVR: 'dvr',
  GAME: 'console',
  'GAME CONSOLE': 'console',
  PROJECTOR: 'projector',
  RECEIVER: 'receiver',
  SAT: 'satellite',
  SATELITE: 'satellite',
  SATELLITE: 'satellite',
  SOUNDBAR: 'soundbar',
  STB: 'stb',
  VCR: 'vcr',
};

export function kindForDevicetype(devtype: string): string | undefined {
  const up = devtype.toUpperCase();
  if (KIND[up] !== undefined) return KIND[up];
  const slug = devtype.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug.length ? slug : undefined;
}

// Manufacturer and model/device from an IRDB path, per the repo's naming
// convention <manufacturer>/<devicetype>/<device>,<subdevice>.csv.
export function metaFromPath(path: string): IrdbMeta {
  const m = /^([^/]+)\/([^/]+)\/([^/]+)\.csv$/i.exec(path);
  if (!m) return {};
  const meta: IrdbMeta = { brand: m[1], model: m[3] };
  const kind = kindForDevicetype(m[2]);
  if (kind) meta.kind = kind;
  return meta;
}

// Fetch an IRDB CSV on demand. Accepts an http(s) URL or a repository path.
export async function fetchIrdbCsv(
  spec: string,
  base: string = IRDB_BASE,
): Promise<{ text: string; meta: IrdbMeta }> {
  let url: string;
  let meta: IrdbMeta = {};
  if (/^https?:\/\//i.test(spec)) {
    url = spec;
  } else {
    const path = irdbRepoPath(spec);
    url = `${base}/${path.split('/').map(encodeURIComponent).join('/')}`;
    meta = metaFromPath(path);
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Cannot fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return { text: await res.text(), meta };
}

// Fetch the flat file index from the jsDelivr API, returning the CSV paths
// (each prefixed with "codes/", matching the repository layout).
export async function fetchIrdbIndex(): Promise<string[]> {
  const res = await fetch(IRDB_INDEX);
  if (!res.ok) {
    throw new Error(`Cannot fetch IRDB index: ${res.status} ${res.statusText}`);
  }
  const data: { files?: { name?: string }[] } = await res.json();
  return (data.files ?? [])
    .map((f) => f.name)
    .filter((name): name is string => typeof name === 'string' && name.endsWith('.csv'));
}
