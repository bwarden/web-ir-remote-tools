// Download the lirc-remotes repository tarball and build the
// capture-matching search index into dist/data/lirc-index.json.
//
// The index is built from the probonopd/lirc-remotes GitHub mirror because
// that is what the app fetches remotes from at runtime: individual
// .lircd.conf files are served from the jsDelivr CDN off the same mirror
// (@master). Indexing the original SourceForge repo instead could produce
// paths or content that 404 or differ at runtime.
//
// The build is make-like: the tarball is cached under .cache/lirc/ keyed by
// commit, and if the index on disk already matches the current mirror commit
// it is not rebuilt (and nothing is downloaded).
//
// Usage:
//   node scripts/build-lirc-index.mjs              # online: skip if unchanged
//   node scripts/build-lirc-index.mjs --offline    # no network; use cache / existing index
//   node scripts/build-lirc-index.mjs --skip       # never rebuild, keep existing index
//   node scripts/build-lirc-index.mjs --dir <path> # use a local checkout
//     (the checkout must contain a remotes/ directory; version becomes the
//     commit if the checkout is a git work tree, else "local")

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'dist', 'data');
const OUT_FILE = join(OUT_DIR, 'lirc-index.json');
const CACHE_DIR = join(ROOT, '.cache', 'lirc');
const LATEST_FILE = join(CACHE_DIR, 'latest-sha');

const REPO = 'probonopd/lirc-remotes';
const COMMIT_API = `https://api.github.com/repos/${REPO}/commits/master`;
const TARBALL_BASE = `https://codeload.github.com/${REPO}/tar.gz/`;

// Indexer schema version. Bump when buildLircIndex changes the index shape.
const GENERATOR = 4;

function parseArgs(argv) {
  const args = { skip: false, offline: false, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skip') args.skip = true;
    else if (a === '--offline') args.offline = true;
    else if (a === '--dir') args.dir = argv[++i];
  }
  return args;
}

// The version and generator of the index currently on disk, if any.
function builtIndexMeta() {
  if (!existsSync(OUT_FILE)) return null;
  try {
    const idx = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
    return {
      version: typeof idx.version === 'string' ? idx.version : null,
      generator: typeof idx.generator === 'number' ? idx.generator : 1,
    };
  } catch {
    return null;
  }
}

function cachedTarball(sha) {
  return join(CACHE_DIR, `${sha}.tar.gz`);
}

function gitHead(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function gitDate(dir) {
  try {
    const iso = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%aI', 'HEAD'], { encoding: 'utf8' }).trim();
    return iso ? new Date(iso).getTime() : undefined;
  } catch {
    return undefined;
  }
}

async function fetchCommitSha() {
  const res = await fetch(COMMIT_API, { headers: { 'User-Agent': 'ir-remote-tools-build' } });
  if (!res.ok) throw new Error(`Cannot resolve lirc-remotes commit: ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (typeof data.sha !== 'string' || !data.sha) throw new Error('lirc-remotes commit response missing sha');
  const commitDate = data.commit?.author?.date ? new Date(data.commit.author.date).getTime() : undefined;
  return { sha: data.sha, commitDate };
}

async function downloadTarball(sha, dest) {
  const url = `${TARBALL_BASE}${encodeURIComponent(sha)}`;
  process.stdout.write(`Downloading ${url} …\n`);
  const res = await fetch(url, { headers: { 'User-Agent': 'ir-remote-tools-build' } });
  if (!res.ok) throw new Error(`Cannot download tarball: ${res.status} ${res.statusText}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function extractTarball(tarball, tmp) {
  execFileSync('tar', ['-xzf', tarball, '-C', tmp]);
  const entries = await readdir(tmp);
  const root = entries.find((e) => existsSync(join(tmp, e, 'remotes')));
  if (!root) throw new Error('Tarball does not contain a remotes/ directory');
  return join(tmp, root);
}

function findLircFiles(dir) {
  const out = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findLircFiles(p));
    else if (/\.lircd\.conf$/i.test(entry.name) || /\.conf$/i.test(entry.name)) out.push(p);
  }
  return out;
}

// Path relative to remotes/, e.g. samsung/00008E.lircd.conf
function repoPath(file, remotesDir) {
  return file.slice(remotesDir.length + 1).split('\\').join('/');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(CACHE_DIR, { recursive: true });

  if (args.skip) {
    if (!existsSync(OUT_FILE)) {
      process.stderr.write('--skip given but no existing index; building anyway.\n');
    } else {
      process.stdout.write('Skipping index build (--skip); keeping existing index.\n');
      return;
    }
  }

  // Determine which lirc-remotes commit to index.
  let version;
  let commitDate;
  if (args.dir) {
    version = gitHead(args.dir) ?? 'local';
    commitDate = gitDate(args.dir);
  } else if (args.offline) {
    if (builtIndexMeta() && builtIndexMeta().generator === GENERATOR) {
      process.stdout.write('Index up to date; skipping build (--offline).\n');
      return;
    }
    version = existsSync(LATEST_FILE) ? readFileSync(LATEST_FILE, 'utf8').trim() : null;
    if (!version) throw new Error('--offline given but no cached lirc-remotes tarball or index found');
  } else {
    ({ sha: version, commitDate } = await fetchCommitSha());
  }

  // Make-like: if the source commit hasn't changed and the indexer schema is
  // unchanged since the last build, keep the existing index (no download, no
  // rebuild).
  const built = builtIndexMeta();
  if (!args.dir && built && built.version === version && built.generator === GENERATOR) {
    process.stdout.write(`Index up to date (LIRC @${version.slice(0, 7)}); skipping rebuild.\n`);
    return;
  }

  let tmp = null;
  try {
    const { buildLircIndex } = await import('../dist/src/lib/lircIndexer.js');

    let sourcesDir;

    if (args.dir) {
      sourcesDir = args.dir;
      const remotesDir = join(sourcesDir, 'remotes');
      if (!existsSync(remotesDir)) throw new Error(`No remotes/ directory in ${sourcesDir}`);
      process.stdout.write(`Indexing local checkout ${sourcesDir} (${version.slice(0, 7)}).\n`);
    } else {
      const tarball = cachedTarball(version);
      if (!existsSync(tarball)) {
        if (args.offline) throw new Error(`No cached tarball for ${version.slice(0, 7)}`);
        await downloadTarball(version, tarball);
      } else {
        process.stdout.write(`Using cached tarball ${version.slice(0, 7)}.\n`);
      }

      // The source is up to date in the cache; remember it for --offline runs.
      writeFileSync(LATEST_FILE, version);

      tmp = join(tmpdir(), `lirc-build-${process.pid}`);
      mkdirSync(tmp, { recursive: true });
      sourcesDir = await extractTarball(tarball, tmp);
    }

    const remotesDir = join(sourcesDir, 'remotes');

    const lircFiles = findLircFiles(remotesDir);
    process.stdout.write(`Found ${lircFiles.length} .lircd.conf files.\n`);

    const sources = [];
    for (let i = 0; i < lircFiles.length; i++) {
      const text = readFileSync(lircFiles[i], 'utf8');
      sources.push({ path: repoPath(lircFiles[i], remotesDir), text });
      if ((i + 1) % 500 === 0 || i + 1 === lircFiles.length) {
        process.stdout.write(`  read ${i + 1}/${lircFiles.length}\n`);
      }
    }

    process.stdout.write('Building index…\n');
    const idx = buildLircIndex(sources, { version, generator: GENERATOR, commitDate });
    process.stdout.write(
      `  ${idx.devices.length} remotes indexed, ${idx.misses} files skipped, ` +
      `${Object.keys(idx.exact).length} exact keys.\n`,
    );

    const total = idx.devices.length + idx.misses;
    const { skipped } = idx;
    process.stdout.write(
      `  Skipped ${idx.misses} of ${total} files: ${skipped.parseErrors} failed to parse, ` +
      `${skipped.noSupportedRows} parsed but had no decodable codes.\n`,
    );
    const protocols = Object.entries(skipped.singleProtocol).sort((a, b) => b[1] - a[1]);
    if (protocols.length) {
      const top = protocols.slice(0, 12).map(([p, n]) => `${p} ${n}`).join(', ');
      const rest = protocols.length - 12;
      process.stdout.write(`  Unsupported protocols: ${top}${rest > 0 ? `, and ${rest} more` : ''}.\n`);
    }

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT_FILE, JSON.stringify(idx));
    const sizeKb = Math.round(existsSync(OUT_FILE) ? readFileSync(OUT_FILE).length / 1024 : 0);
    process.stdout.write(`Wrote ${OUT_FILE} (${sizeKb} KB, version ${version.slice(0, 7)}).\n`);

    // Keep only the newest tarball in the cache.
    if (!args.dir) {
      for (const entry of readdirSync(CACHE_DIR)) {
        const p = join(CACHE_DIR, entry);
        if (/\.tar\.gz$/.test(entry) && p !== cachedTarball(version)) rmSync(p, { force: true });
      }
    }
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`Index build failed: ${err.message}\n`);
  process.exit(1);
});
