// Builds the GitHub release assets from a VERIFIED packaged folder: SeedHost-<version>-win32-x64.zip plus
// SHA256SUMS.txt (the two assets the in-app updater consumes), using the Windows bundled tar (bsdtar).
// Run after `npm run package:windows`.
//
// The package is selected by its own manifest version, never by folder recency: a stale or hand-labelled build must
// never be shipped under the current version. After zipping, the archive is extracted again and every entry is
// compared (path, size, SHA-256) against the packaged folder, so the uploaded asset is provably the tested build.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const root = process.cwd();
const p = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const releaseRoot = path.join(root, 'release');
const top = 'SeedHost-win32-x64';
const tarExe = 'C:/Windows/System32/tar.exe';

const candidates = [];
for (const name of await readdir(releaseRoot).catch(() => [])) {
  if (!name.startsWith('alpha-')) continue;
  const directory = path.join(releaseRoot, name);
  const packageDir = path.join(directory, top);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(directory, 'package-manifest.json'), 'utf8'));
    await access(path.join(packageDir, 'SeedHost.exe'));
  } catch { continue; }
  // A package built from a different version is not a candidate for this release at all.
  if (manifest.version !== p.version) {
    console.log(`SKIP ${name}: package version ${JSON.stringify(manifest.version)} != ${p.version}`);
    continue;
  }
  candidates.push({ name, directory, packageDir, manifest });
}
if (!candidates.length) {
  throw new Error(`No release/alpha-*/${top} package built from ${p.version} was found; run npm run package:windows on this exact tree first`);
}
if (candidates.length > 1) {
  throw new Error(`Ambiguous release: ${candidates.map((c) => c.name).join(', ')} all claim ${p.version}. Remove the stale package(s) so the published asset is unambiguous.`);
}
const chosen = candidates[0];
const zipName = `SeedHost-${p.version}-win32-x64.zip`;
const zipPath = path.join(releaseRoot, zipName);
await rm(zipPath, { force: true });
// The zip must keep the internal top-level folder name the updater stages and mirrors: SeedHost-win32-x64.
const tar = spawnSync(tarExe, ['-a', '-c', '-f', zipPath, '-C', chosen.directory, top], { stdio: 'inherit' });
if (tar.error || tar.status !== 0) throw new Error('tar failed: ' + (tar.error ? tar.error.message : 'exit ' + tar.status));

async function inventory(directory, prefix = '') {
  const files = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) { for (const [key, value] of await inventory(absolute, relative)) files.set(key, value); continue; }
    if (!entry.isFile()) throw new Error(`Unsupported entry in packaged release: ${relative}`);
    const info = await stat(absolute);
    const hash = await new Promise((resolve, reject) => {
      const h = createHash('sha256');
      const s = createReadStream(absolute);
      s.on('data', (chunk) => h.update(chunk));
      s.on('error', reject);
      s.on('end', () => resolve(h.digest('hex')));
    });
    files.set(relative, { size: info.size, hash });
  }
  return files;
}

const expected = await inventory(chosen.packageDir);
if (!expected.size) throw new Error('The packaged folder is empty');
const extractRoot = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'seedhost-release-verify-'));
try {
  const extract = spawnSync(tarExe, ['-x', '-f', zipPath, '-C', extractRoot], { stdio: 'inherit' });
  if (extract.error || extract.status !== 0) throw new Error('The release zip could not be extracted for verification');
  const actual = await inventory(path.join(extractRoot, top));
  let compared = 0;
  for (const [relative, want] of expected) {
    const got = actual.get(relative);
    if (!got) throw new Error(`Release zip is missing ${relative}`);
    if (got.size !== want.size || got.hash !== want.hash) throw new Error(`Release zip entry ${relative} does not match the tested package`);
    compared++;
  }
  if (actual.size !== expected.size) throw new Error(`Release zip has ${actual.size} entries but the package has ${expected.size}`);
  console.log(`RELEASE_ZIP_ENTRIES_VERIFIED=${compared}`);
} finally { await rm(extractRoot, { recursive: true, force: true }); }

const hash = await new Promise((resolve, reject) => {
  const h = createHash('sha256');
  const s = createReadStream(zipPath);
  s.on('data', (c) => h.update(c));
  s.on('error', reject);
  s.on('end', () => resolve(h.digest('hex')));
});
const size = (await stat(zipPath)).size;
const sums = path.join(releaseRoot, 'SHA256SUMS.txt');
await writeFile(sums, `${hash}  ${zipName}\n`);
console.log('PACKAGE_DIRECTORY=' + chosen.packageDir);
console.log('PACKAGE_MANIFEST_VERSION=' + chosen.manifest.version);
console.log('RELEASE_ZIP=' + zipPath);
console.log('RELEASE_ZIP_BYTES=' + size);
console.log('RELEASE_ZIP_SHA256=' + hash);
console.log('SHA256SUMS=' + sums);
