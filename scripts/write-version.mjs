// Writes dist/index.html with the version (package version or vX.Y.Z release
// tag at HEAD), a short git identity, and the build timestamp stamped into the
// footer's version placeholder. Stamping the HTML instead of emitting a
// version.json keeps the version consistent with the page it is served on: a
// separately fetched file could be cached and served stale against a fresh
// index.html. Git errors are tolerated (git may be absent, e.g. building from
// a tarball); the package version is always present.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const VERSION_TOKEN = '__VERSION_TEXT__';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

function gitShort() {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

// The release tag pointing at HEAD (vX.Y.Z) when the build is a release;
// empty string when untagged (e.g. an intermediate commit or tarball build).
function gitTag() {
  try {
    return execSync('git describe --tags --exact-match HEAD', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const tag = gitTag();
const git = gitShort();
const versionText = `${tag || pkg.version} · git ${git} · built ${new Date().toISOString()}`;

const html = readFileSync('index.html', 'utf8');
if (!html.includes(VERSION_TOKEN)) {
  console.warn(`index.html has no ${VERSION_TOKEN} placeholder; dist/index.html left as-is`);
}
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html.replaceAll(VERSION_TOKEN, versionText));
console.log(`Stamped dist/index.html (${pkg.name} ${tag || pkg.version}, git ${git})`);