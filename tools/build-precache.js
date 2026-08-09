// Plane Text: generate app/precache-manifest.js.
//
//   npm run precache
//
// Why this is generated and not written by hand.
//
// The offline-ready check verifies every precache entry by name (decision
// 2026-08-09), because a checkmark that can lie is worse than no checkmark. A
// hand-maintained array cannot lie in the direction you would notice. It fails
// closed on a deleted file (the check goes red, loudly) and open on an added
// one: the new file is never cached, every entry verifies, the tick is green,
// and the app breaks behind a captive portal at 30,000 feet while telling you
// it is ready. Four agents are about to add files.
//
// So the list is derived from the filesystem, and a test asserts the committed
// file matches what this script would produce right now. Regeneration is not
// wired into pretest: if `npm test` regenerated the manifest it could never
// detect that someone forgot to.
//
// The contract for adding a file:
//   1. Put it under app/ or src/ with one of the extensions below, or add it
//      to ROOT_FILES if it belongs at the root.
//   2. Run `npm run precache`.
//   3. Commit the regenerated app/precache-manifest.js with your change.
// A file outside those trees is not cached and will not work offline.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Trees that are walked, in this order.
export const INCLUDE_DIRS = ['app', 'src'];

// Files at the root. index.html is the shell, and the manifest is what makes
// it installable. Both must survive a cold cabin network.
export const ROOT_FILES = ['index.html', 'manifest.webmanifest'];

export const EXTENSIONS = new Set(['.js', '.css', '.html', '.svg', '.png', '.webp', '.json', '.webmanifest', '.woff2']);

// The generated manifests are in the list, since the service worker needs them
// cached, but out of the version hash, which would otherwise be circular.
//
// Two files, one source of truth. The ES module is what the app and a
// `type: 'module'` service worker import. The classic variant exists because
// importScripts() cannot load an ES module, and a module service worker needs
// Safari 16.4+. So a classic sw.js can read self.PRECACHE after
// `importScripts('app/precache-manifest.classic.js')`. Both come from the same
// walk and neither is editable, so they cannot disagree.
export const SELF = 'app/precache-manifest.js';
export const SELF_CLASSIC = 'app/precache-manifest.classic.js';
const GENERATED = new Set([SELF, SELF_CLASSIC]);

// sw.js is absent by design. A service worker caching itself fights the
// browser's own update check. The platform handles sw.js.
export const EXCLUDE = new Set(['sw.js']);

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.')) continue;
    const rel = `${dir}/${entry.name}`;
    if (EXCLUDE.has(rel)) continue;
    if (entry.isDirectory()) walk(rel, out);
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(rel);
  }
  return out;
}

export function buildManifest() {
  const files = [];
  for (const f of ROOT_FILES) if (existsSync(path.join(ROOT, f)) && !EXCLUDE.has(f)) files.push(f);
  for (const dir of INCLUDE_DIRS) walk(dir, files);
  for (const g of GENERATED) if (!files.includes(g)) files.push(g); // first run, before they exist
  files.sort();

  // The version hashes content, not a timestamp. A rebuild that changed
  // nothing must produce a byte-identical file, or the drift test becomes a
  // coin toss and everyone learns to ignore it.
  const h = createHash('sha256');
  for (const rel of files) {
    if (GENERATED.has(rel)) continue;
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(path.join(ROOT, rel)));
    h.update('\0');
  }
  const version = `pt-${h.digest('hex').slice(0, 12)}`;
  return { files, version, source: render(files, version), sourceClassic: renderClassic(files, version) };
}

function renderClassic(files, version) {
  return `// Generated file. Do not edit. Run \`npm run precache\`.
//
// The classic-script twin of precache-manifest.js, for a service worker that
// is registered without { type: 'module' }:
//
//   importScripts('app/precache-manifest.classic.js');
//   self.PRECACHE.map(function (p) { return new URL(p, self.location).href; });

self.PRECACHE_VERSION = '${version}';

self.PRECACHE = [
${files.map((f) => `  '${f}',`).join('\n')}
];
`;
}

function render(files, version) {
  return `// Generated file. Do not edit. Run \`npm run precache\`.
//
// Every path is relative to the app root, because GitHub Pages serves this
// from a sub-path. A service worker must resolve them against its own
// location: new URL(p, self.location), never against '/'.
//
// PRECACHE_VERSION hashes the contents of every file listed except this one.
// It changes when any of them changes and only then, so it is safe as both the
// cache name and the version string the offline readout reports.

export const PRECACHE_VERSION = '${version}';

export const PRECACHE = [
${files.map((f) => `  '${f}',`).join('\n')}
];
`;
}

// The line in sw.js that this script owns. Matched loosely enough to find a
// stamp from any previous build, and anchored to the start of a line so it
// cannot match the prose above it.
const STAMP_RE = /^\/\/ @build .*$/m;
const stampFor = (version) => `// @build ${version}`;

// STAMP THE VERSION INTO sw.js. Added 2026-08-09.
//
// The browser decides whether a service worker has changed by refetching sw.js
// and comparing bytes. sw.js is static: the version, and the whole file list,
// live in app/precache-manifest.classic.js, which sw.js pulls in with
// importScripts(). So every build of this app produced a byte-identical sw.js.
//
// The spec has said since 2019 that imported scripts are compared during an
// update too, and current Chrome, Firefox and Safari do. That is the only
// reason updates worked at all. It leaves the app's update path resting
// entirely on the newer half of a two-part rule, on a device population that
// includes old Android WebViews, for no reason -- the fix is one comment line
// that changes with the build.
//
// Reported symptom that led here: a deployed build would not reach a phone.
// The primary cause was elsewhere (updateViaCache, and nothing ever calling
// registration.update(); see app/offline.js). This is the belt to that
// braces, and it makes the byte comparison say what it means.
//
// sw.js stays out of EXCLUDE's precache list and out of the version hash. It is
// never cached by the app -- a worker that caches itself fights the browser's
// update check -- and hashing a file this script writes into would not
// converge.
function stampWorker(version) {
  const out = path.join(ROOT, 'sw.js');
  if (!existsSync(out)) return false;
  const before = readFileSync(out, 'utf8');
  const stamp = stampFor(version);
  if (STAMP_RE.test(before)) {
    const after = before.replace(STAMP_RE, stamp);
    if (after === before) return false;
    writeFileSync(out, after);
    return true;
  }
  // First run, or someone removed the line. It goes directly under the
  // /* eslint-env */ pragma, above importScripts, so it is the first thing read
  // after the header and cannot be mistaken for part of the prose.
  const anchor = "importScripts('app/precache-manifest.classic.js');";
  if (!before.includes(anchor)) {
    throw new Error('sw.js: cannot find the importScripts line to stamp the build version above');
  }
  writeFileSync(out, before.replace(anchor, `${stamp}\n\n${anchor}`));
  return true;
}

export function writeManifest() {
  const { source, sourceClassic, files, version } = buildManifest();
  let changed = false;
  for (const [rel, text] of [[SELF, source], [SELF_CLASSIC, sourceClassic]]) {
    const out = path.join(ROOT, rel);
    const before = existsSync(out) ? readFileSync(out, 'utf8') : null;
    if (before !== text) { writeFileSync(out, text); changed = true; }
  }
  if (stampWorker(version)) changed = true;
  return { files, version, changed };
}

// So a test can assert sw.js carries the version this build would produce,
// rather than reimplementing the format and drifting from it.
export { stampFor as buildStamp };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { files, version, changed } = writeManifest();
  console.log(`${SELF}: ${files.length} files, ${version}${changed ? '' : ' (unchanged)'}`);
}
