// Publishes the current version's GitHub release: creates (or updates) the release for v<package.json version> and
// uploads the two updater assets built by tools/package-release.mjs.
//
// Order matters: the release is prepared as a DRAFT, both assets are uploaded and read back, and only then is it
// published. A failed upload therefore leaves a private draft instead of a public release with missing or stale files.
// An already-published release is refused unless --allow-published-replace is passed, so a retry can never silently
// unpublish or half-replace a live asset.
//
// Auth comes from the local git credential helper for github.com (never printed). No secrets in-repo.
//
// Usage: node tools/publish-release.mjs --notes=release/notes-v0.6.9-alpha.md
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = process.cwd();
const p = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tag = `v${p.version}`;
const notesPath = process.argv.find((a) => a.startsWith('--notes='))?.slice('--notes='.length);
const notes = notesPath ? await readFile(path.resolve(notesPath), 'utf8') : `Release ${tag}`;
const allowPublishedReplace = process.argv.includes('--allow-published-replace');
const repo = 'envosloth/seedhost';
const zipPath = path.join(root, 'release', `SeedHost-${p.version}-win32-x64.zip`);
const sumsPath = path.join(root, 'release', 'SHA256SUMS.txt');

const credential = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' }).toString();
const password = /^password=(.+)$/m.exec(credential)?.[1]?.trim();
if (!password) throw new Error('No stored GitHub credential for github.com; sign in for git push first');
const headers = { Authorization: `Bearer ${password}`, Accept: 'application/vnd.github+json', 'User-Agent': 'SeedHost-Release' };

async function api(route, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${repo}${route}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${route} -> ${response.status}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}

// The published SHA-256 must describe the exact local archive before anything is uploaded.
const localHash = createHash('sha256').update(await readFile(zipPath)).digest('hex');
const sums = (await readFile(sumsPath, 'utf8')).trim();
if (!sums.split(/\r?\n/).some((line) => line.startsWith(localHash))) {
  throw new Error('SHA256SUMS.txt does not describe the local release zip; refusing to upload');
}
console.log(`LOCAL_ZIP_SHA256=${localHash}`);

let release = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers }).then(async (r) => (r.ok ? r.json() : null));
if (release && release.draft !== true && !allowPublishedReplace) {
  throw new Error(`Release ${tag} is already published. Re-run with --allow-published-replace only if you intend to replace its assets.`);
}
if (release) {
  console.log(`Release ${tag} exists (${release.id}); preparing it as a draft.`);
  release = await api(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ name: tag, body: notes, prerelease: true, draft: true }) });
} else {
  release = await api('/releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, name: tag, body: notes, prerelease: true, draft: true }) });
  console.log(`Created DRAFT release ${tag} (${release.id}).`);
}

const uploadBase = String(release.upload_url).replace(/\{.*$/, '');
for (const [file, contentType] of [[zipPath, 'application/zip'], [sumsPath, 'text/plain']]) {
  const name = path.basename(file);
  const existing = (release.assets ?? []).find((a) => a.name === name);
  if (existing) {
    console.log(`Replacing draft asset ${name} (${existing.id}).`);
    await api(`/releases/assets/${existing.id}`, { method: 'DELETE' });
  }
  const body = await readFile(file);
  const uploaded = await fetch(`${uploadBase}?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...headers, 'Content-Type': contentType }, body });
  if (!uploaded.ok) throw new Error(`Upload ${name} -> ${uploaded.status}: ${(await uploaded.text()).slice(0, 300)}`);
  const asset = await uploaded.json();
  console.log(`Uploaded ${asset.name} (${asset.size} bytes) -> ${asset.browser_download_url}`);
}

// Read the draft back: both assets must exist with the exact byte sizes before it becomes public.
const draft = await api(`/releases/${release.id}`);
for (const [file] of [[zipPath], [sumsPath]]) {
  const name = path.basename(file);
  const asset = (draft.assets ?? []).find((a) => a.name === name);
  const expectedSize = (await readFile(file)).length;
  if (!asset) throw new Error(`Draft release is missing ${name}; it stays a private draft`);
  if (asset.size !== expectedSize) throw new Error(`Draft asset ${name} is ${asset.size} bytes, expected ${expectedSize}; it stays a private draft`);
}
console.log(`DRAFT_ASSETS_VERIFIED=${draft.assets.length}`);

const published = await api(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, prerelease: true }) });
if (published.draft !== false || published.prerelease !== true) throw new Error('The release did not become a published prerelease; check it on GitHub');
const final = await api(`/releases/tags/${tag}`);
console.log('RELEASE_URL=' + final.html_url);
console.log('RELEASE_TAG=' + final.tag_name);
console.log('RELEASE_DRAFT=' + final.draft);
console.log('RELEASE_PRERELEASE=' + final.prerelease);
console.log('RELEASE_ASSETS=' + (final.assets ?? []).map((a) => `${a.name}(${a.size})`).join(', '));
