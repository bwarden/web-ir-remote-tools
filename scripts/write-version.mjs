// Writes dist/version.json with the app name/version from package.json plus a
// short git identity and the build timestamp, so the deployed UI can show
// exactly what it is running. Git errors are tolerated (git may be absent,
// e.g. building from a tarball); the package version is always present.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

mkdirSync('dist', { recursive: true });
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
const info = {
  name: pkg.name,
  version: pkg.version,
  tag: tag || undefined,
  git: gitShort(),
  builtAt: new Date().toISOString(),
};

writeFileSync('dist/version.json', JSON.stringify(info, null, 2) + '\n');
const identity = tag ? `${info.version} (tag ${tag})` : info.version;
console.log(`Wrote dist/version.json (${info.name} ${identity}, git ${info.git})`);