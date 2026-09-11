// Search store for the browser — IRDB and LIRC indexes.
//
// Both indexes are generated at build time and served as single static JSONs.
// This module downloads each once and caches the parsed result in IndexedDB,
// so reloads don't re-parse them and the last-good index still works offline.
// Individual device CSVs (IRDB) and remote confs (LIRC) are fetched on demand
// from their respective CDNs when opened for editing.

import { IRDB_BASE } from '../lib/irdb.js';
import { exactKey, looseKey, type IrdbDevice, type IrdbIndex, type IrdbSkipReport, type IndexEntry } from '../lib/indexer.js';
import type { LircDevice, LircIndex, LircSkipReport } from '../lib/lircIndexer.js';

// Re-exported for the UI, which treats this module as the store facade.
export {
  parseDevicePath,
  exactKey,
  looseKey,
} from '../lib/indexer.js';
export type {
  IrdbDevice,
  IrdbSkipReport,
  IndexEntry,
  IrdbIndex,
} from '../lib/indexer.js';
export type {
  LircDevice,
  LircSkipReport,
  LircIndex,
} from '../lib/lircIndexer.js';

const IRDB_INDEX_URL = 'data/irdb-index.json';
const LIRC_INDEX_URL = 'data/lirc-index.json';

// jsDelivr CDN for individual .lircd.conf files (probonopd/lirc-remotes).
// The build-time index is generated from this same mirror, so indexed paths
// match what jsDelivr serves; only commits landing between a deploy and a
// page load can 404 until the next deploy.
const LIRC_CDN_BASE = 'https://cdn.jsdelivr.net/gh/probonopd/lirc-remotes@master/remotes';

function irdbUrl(path: string): string {
  return `${IRDB_BASE}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function lircUrl(path: string): string {
  return `${LIRC_CDN_BASE}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

// --- IndexedDB --------------------------------------------------------------

const DB_NAME = 'ir-remote-tools';
const DB_VERSION = 1;
const KV = 'kv';
const IRDB_INDEX_DB_KEY = 'irdb-index-v2';
const LIRC_INDEX_DB_KEY = 'lirc-index-v1';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    const timer = setTimeout(() => reject(new Error('IndexedDB unavailable')), 2000);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(KV)) req.result.createObjectStore(KV);
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      resolve(req.result);
    };
    req.onerror = () => {
      clearTimeout(timer);
      reject(req.error);
    };
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openDb();
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(KV, 'readonly');
      const req = tx.objectStore(KV).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(KV, 'readwrite');
      tx.objectStore(KV).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort
  }
}

// --- Generic index loader ---------------------------------------------------

async function loadStaticIndex<T extends { version: string; generator: number }>(
  url: string,
  dbKey: string,
): Promise<T | undefined> {
  const cached = await idbGet<T>(dbKey);
  let fresh: T | undefined;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Cannot fetch index: ${res.status} ${res.statusText}`);
    fresh = (await res.json()) as T;
  } catch {
    fresh = undefined;
  }
  if (fresh) {
    if (!cached || cached.version !== fresh.version || cached.generator !== fresh.generator) {
      await idbSet(dbKey, fresh);
    }
    return fresh;
  }
  return cached;
}

// --- IRDB index -------------------------------------------------------------

let irdbIndexPromise: Promise<IrdbIndex | undefined> | null = null;

export function loadIrdbIndex(): Promise<IrdbIndex | undefined> {
  irdbIndexPromise ??= loadStaticIndex<IrdbIndex>(IRDB_INDEX_URL, IRDB_INDEX_DB_KEY);
  return irdbIndexPromise;
}

export interface DeviceList {
  version: string;
  fetchedAt: number;
  devices: IrdbDevice[];
}

export async function fetchDeviceList(): Promise<DeviceList> {
  const idx = await loadIrdbIndex();
  return {
    version: idx?.version ?? '',
    fetchedAt: idx?.builtAt ?? 0,
    devices: idx?.devices ?? [],
  };
}

export async function fetchIrdbDevice(path: string): Promise<string> {
  const res = await fetch(irdbUrl(path));
  if (!res.ok) throw new Error(`Cannot fetch ${path}: ${res.status} ${res.statusText}`);
  return res.text();
}

// --- LIRC index -------------------------------------------------------------

let lircIndexPromise: Promise<LircIndex | undefined> | null = null;

export function loadLircIndex(): Promise<LircIndex | undefined> {
  lircIndexPromise ??= loadStaticIndex<LircIndex>(LIRC_INDEX_URL, LIRC_INDEX_DB_KEY);
  return lircIndexPromise;
}

export interface LircDeviceList {
  version: string;
  fetchedAt: number;
  devices: LircDevice[];
}

export async function fetchLircDeviceList(): Promise<LircDeviceList> {
  const idx = await loadLircIndex();
  return {
    version: idx?.version ?? '',
    fetchedAt: idx?.builtAt ?? 0,
    devices: idx?.devices ?? [],
  };
}

export async function fetchLircDevice(path: string): Promise<string> {
  const res = await fetch(lircUrl(path));
  if (!res.ok) throw new Error(`Cannot fetch ${path}: ${res.status} ${res.statusText}`);
  return res.text();
}

// --- Combined lookup --------------------------------------------------------

export interface CombinedCodeMatch {
  irdb: { exact: IndexEntry[]; loose: IndexEntry[] };
  lirc: { exact: IndexEntry[]; loose: IndexEntry[] };
}

export async function matchCode(
  code: import('../lib/code.js').IRCode,
): Promise<CombinedCodeMatch> {
  const [irdbIdx, lircIdx] = await Promise.all([loadIrdbIndex(), loadLircIndex()]);
  return {
    irdb: {
      exact: irdbIdx?.exact[exactKey(code)] ?? [],
      loose: irdbIdx?.loose[looseKey(code)] ?? [],
    },
    lirc: {
      exact: lircIdx?.exact[exactKey(code)] ?? [],
      loose: lircIdx?.loose[looseKey(code)] ?? [],
    },
  };
}
