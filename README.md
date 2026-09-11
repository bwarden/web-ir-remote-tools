# IR Remote Tools

Browser-based IR remote code tools: look up remotes in IRDB and lirc-remotes,
decode captures (Tasmota, mode2, Pronto hex, …), and export as HAIR wig. All
conversion runs locally in your browser.

## Distribution

The distributable site is the `dist/` directory — plain static files, no
server-side component required.

### Prerequisites

- Node.js 18+ (20 LTS recommended) and npm
- Network access for `npm install` and for building the search indexes
  (`tar` is used by the index scripts)

### Build

```sh
npm install
npm run build
```

This runs `tsc`, then:

1. `scripts/build-index.mjs` — downloads the irdb tarball and builds
   `dist/data/irdb-index.json`
2. `scripts/build-lirc-index.mjs` — downloads the lirc-remotes (probonopd
   GitHub mirror) tarball and builds `dist/data/lirc-index.json`. The index is
   built from this mirror because it is also what the app fetches individual
   remotes from at runtime via the jsDelivr CDN, so indexed paths always match
   what is served.
3. `scripts/copy-assets.mjs` — copies `index.html`, CSS, and test fixtures
   into `dist/`

Both index scripts are make-like: sources are cached under `.cache/` and an
index is only rebuilt when the upstream commit or indexer schema changes.
Flags: `--offline` (use cache only), `--skip` (keep existing index), `--dir
<path>` (index a local checkout instead).

### Test

```sh
npm test        # compiles, copies fixtures, then runs node --test dist/test/
```

### Serve locally

```sh
npm run serve   # build + python3 -m http.server on http://localhost:8000/dist/
```

Any static file server pointed at `dist/` works. All asset URLs are relative,
so it also works under a subpath (e.g. GitHub Pages project sites).

## Transmitting MWM commands

The MWM / Glow-With-The-Show protocol reference (`docs/mwm-show-protocol.md`),
the verified command table (`samples/mwm-gwts-colors.tsv`), and the rig
transmit/probe tools (`tools/mwm-send.py`) live in the separate `python-mwm`
repository.

## Deployment to GitHub Pages

Deploys are automated with `.github/workflows/deploy.yml`: every push to
`main` (and manual runs via *Run workflow*) tests, builds, and publishes
`dist/`.

One-time setup after creating the GitHub repository:

1. **Settings → Pages → Build and deployment → Source**: select
   **GitHub Actions**.
2. Push to `main`. The workflow deploys to
   `https://<user>.github.io/<repo>/`; the URL is shown in the workflow run's
   `deploy` job summary.

## Versioning releases

The app version lives in `package.json` (mirrored in `package-lock.json`).
Releases are tagged `vX.Y.Z`:

```sh
npm version patch   # or minor / major; bumps both files, commits, tags v0.x.y
git push --follow-tags
```

Then publish the release on GitHub and optionally attach the built site as a
downloadable artifact:

```sh
VERSION="v$(node -p "require('./package.json').version")"
npm run build
zip -r "ir-remote-tools-${VERSION}.dist.zip" dist
gh release create "$VERSION" --generate-notes "ir-remote-tools-${VERSION}.dist.zip"
```

Notes:

- Tags/releases do **not** drive the GitHub Pages deploy — every push to
  `main` deploys automatically. Tag a release once its deploy has gone green
  if you want the published site to match it.
- The index JSONs embed the upstream commit they were built from (`version`
  field), so a released zip is reproducible against a known IRDB/lirc-remotes
  state.

