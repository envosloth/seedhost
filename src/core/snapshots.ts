import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validateRelativePath } from './paths.js';

export interface SnapshotManifest {
  version: 1;
  id: string;
  parentId: string | null;
  files: Array<{ path: string; size: number; hash: string }>;
}

const runFile = promisify(execFile);
/** Files modified this recently are always re-read: their timestamps may not yet distinguish a later write. */
const STAT_CACHE_SETTLE_MS = 2000;

function validateRoot(root: string): void {
  const normalized = root.replaceAll('\\', '/');
  if (normalized.startsWith('//?/') || normalized.startsWith('//./') || normalized.includes('\u0000')) {
    throw new Error('Unsafe Windows device namespace root');
  }
  if (normalized.split('/').some((part) => part !== '.' && part !== '..' && /[. ]$/u.test(part))) {
    throw new Error('Unsafe root alias: nesting checks require unambiguous directory names');
  }
}

function pathKey(value: string): string {
  // Uppercase before lowercase catches Windows ordinal aliases such as long-s/S and final sigma.
  // Unicode expansions are intentionally conservative: reject extra aliases rather than overwrite.
  return value.toUpperCase().toLowerCase();
}

function assertDisjoint(first: string, second: string): void {
  validateRoot(first);
  validateRoot(second);
  const a = pathKey(path.resolve(first).replaceAll('\\', '/')).replace(/\/$/u, '');
  const b = pathKey(path.resolve(second).replaceAll('\\', '/')).replace(/\/$/u, '');
  if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
    throw new Error('Source/store/destination roots must be disjoint; nesting is forbidden');
  }
}

// Run only after link/reparse preflight. Resolve existing ancestors to catch 8.3/root aliases,
// including a destination whose final components have not been created yet.
async function canonicalRoot(root: string): Promise<string> {
  let current = path.resolve(root);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await realpath(current), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || current === path.dirname(current)) throw error;
      missing.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
}

async function assertPhysicalDisjoint(first: string, second: string): Promise<void> {
  assertDisjoint(await canonicalRoot(first), await canonicalRoot(second));
}

async function assertSafeRoots(roots: string[]): Promise<void> {
  // A concurrent store writer may remove its private staging directory (.transfer-*, .staging-*)
  // between our enumeration and our inspection of it. Only an enumerated child that is gone
  // (plain ENOENT, before its stat or its own enumeration) is skipped: the walk root itself,
  // any junction/reparse point present at check time, and every other error still fail closed.
  async function inspect(filename: string, recursive: boolean, missingAllowed: boolean, enumeratedChild = false): Promise<void> {
    let stat;
    try { stat = await lstat(filename); }
    catch (error) {
      if ((missingAllowed || enumeratedChild) && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlink/reparse point forbidden: ${filename}`);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Unsupported file type: ${filename}`);
    if (recursive && stat.isDirectory()) {
      let names: string[];
      try { names = await readdir(filename); }
      catch (error) {
        if (enumeratedChild && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const name of names) await inspect(path.join(filename, name), true, false, true);
    }
  }
  const absoluteRoots = roots.map((root) => { validateRoot(root); return path.resolve(root); });
  for (const root of absoluteRoots) {
    for (let current = root; ; current = path.dirname(current)) {
      await inspect(current, false, true);
      if (current === path.dirname(current)) break;
    }
  }
  // Node lstat detects junctions, but not every Windows reparse tag (e.g. cloud placeholders).
  // Inspect the native attribute bit as well, and fail closed if the platform probe is unavailable.
  if (process.platform === 'win32') {
    const literal = JSON.stringify(absoluteRoots).replaceAll("'", "''");
    const script = `$ErrorActionPreference = 'Stop'
function TestVanished([System.Exception]$exception) {
  $current = $exception
  while ($null -ne $current) {
    if ($current -is [System.IO.FileNotFoundException] -or $current -is [System.IO.DirectoryNotFoundException]) { return $true }
    $current = $current.InnerException
  }
  return $false
}
function TestAccessDenied([System.Exception]$exception) {
  $current = $exception
  while ($null -ne $current) {
    if ($current -is [System.UnauthorizedAccessException]) { return $true }
    $current = $current.InnerException
  }
  return $false
}
function CheckPath([string]$p, [bool]$recursive, [bool]$enumeratedChild, [int]$retry = 0) {
  try { $attrs = [System.IO.File]::GetAttributes($p) }
  catch {
    if (TestVanished $_.Exception) { return }
    # A delete-pending child can transiently deny the attribute probe too; retry bounded, then fail closed.
    if ($enumeratedChild -and $retry -lt 3 -and (TestAccessDenied $_.Exception)) {
      Start-Sleep -Milliseconds 10
      CheckPath $p $recursive $enumeratedChild ($retry + 1)
      return
    }
    throw
  }
  if (($attrs -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point forbidden: $p" }
  if ($recursive -and (($attrs -band [System.IO.FileAttributes]::Directory) -ne 0)) {
    try { $entries = [System.IO.Directory]::GetFileSystemEntries($p) }
    catch {
      # An enumerated child may legitimately vanish before enumeration (a concurrent transfer
      # removing its staging directory); the walk root must not be skipped this way.
      if ($enumeratedChild -and (TestVanished $_.Exception)) { return }
      # A delete-pending directory can briefly deny enumeration on Windows. Recheck all
      # attributes after a bounded wait; never treat persistent denial as disappearance.
      if ($enumeratedChild -and $retry -lt 3 -and (TestAccessDenied $_.Exception)) {
        Start-Sleep -Milliseconds 10
        CheckPath $p $recursive $enumeratedChild ($retry + 1)
        return
      }
      throw
    }
    foreach ($entry in $entries) { CheckPath $entry $true $true }
  }
}
try {
  foreach ($rootPath in (ConvertFrom-Json '${literal}')) {
    $current = $rootPath
    while ($current) { CheckPath $current $false $false; $current = [System.IO.Path]::GetDirectoryName($current) }
    CheckPath $rootPath $true $false
  }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;
    try {
      await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      throw new Error('Windows reparse-point safety check failed; refusing filesystem access', { cause: error });
    }
  }
  for (const root of absoluteRoots) await inspect(root, true, true);
}

function manifestId(parentId: string | null, files: SnapshotManifest['files']): string {
  return createHash('sha256').update(JSON.stringify({ version: 1, parentId, files })).digest('hex');
}

/** Flush a directory entry list (new links/removals). Windows cannot open directories for flushing. */
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeDurable(filename: string, data: string): Promise<void> {
  const handle = await open(filename, 'wx');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally { await handle.close(); }
}

/**
 * The temporary has already been written, flushed and hashed while streaming. After linking, the target is
 * either that same inode or a previously published object; both are verified by reading the target once.
 */
async function publish(temporary: string, target: string, expected: { size: number; hash: string }): Promise<void> {
  try {
    await link(temporary, target); // Atomic, never overwrites a published revision/object.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const actual = await hashFile(target);
  if (actual.hash !== expected.hash || actual.size !== expected.size) {
    throw new Error(`Published artifact integrity hash mismatch: ${target}`);
  }
}

async function hashFile(filename: string): Promise<{ size: number; hash: string }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filename)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, hash: hash.digest('hex') };
}

async function syncFile(filename: string): Promise<void> {
  const handle = await open(filename, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function streamObject(source: string, temporary: string): Promise<{ size: number; hash: string }> {
  const before = await lstat(source, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Unsafe source file/symlink: ${source}`);
  const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(Number.isSafeInteger(size) ? null : new Error('Source file size exceeds safe integer range'), chunk);
    } });
    await pipeline(handle.createReadStream({ autoClose: false }), meter, createWriteStream(temporary, { flags: 'wx' }));
    const after = await lstat(source, { bigint: true });
    const opened = await handle.stat({ bigint: true });
    if (statIdentity(before) !== statIdentity(after) || statIdentity(before) !== statIdentity(opened) || BigInt(size) !== before.size) {
      throw new Error(`Source changed while copying; stop the server before snapshotting: ${source}`);
    }
    return { size, hash: hash.digest('hex') };
  } finally { await handle.close(); }
}

function statIdentity(stat: import('node:fs').BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');
}

/** Content identity for the stat cache: any write, truncate, replace or utimes changes one of these. */
function contentKey(stat: import('node:fs').BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

interface StatCache { version: 1; entries: Record<string, { key: string; hash: string; size: number }> }

async function statCacheFile(store: string, sourceDir: string): Promise<string> {
  const source = await canonicalRoot(sourceDir);
  return path.join(store, 'stat-cache', `${createHash('sha256').update(pathKey(source)).digest('hex')}.json`);
}

/** The cache is only an optimization: anything unreadable or malformed is ignored, never trusted. */
async function readStatCache(filename: string): Promise<Map<string, { key: string; hash: string; size: number }>> {
  try {
    const value = JSON.parse(await readFile(filename, 'utf8')) as StatCache;
    if (value?.version !== 1 || !value.entries || typeof value.entries !== 'object') return new Map();
    const entries = new Map<string, { key: string; hash: string; size: number }>();
    for (const [relative, entry] of Object.entries(value.entries)) {
      if (typeof entry?.key === 'string' && typeof entry.hash === 'string' && /^[a-f0-9]{64}$/u.test(entry.hash) &&
          Number.isSafeInteger(entry.size) && entry.size >= 0) entries.set(relative, entry);
    }
    return entries;
  } catch { return new Map(); }
}

async function writeStatCache(filename: string, entries: StatCache['entries']): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeDurable(temporary, JSON.stringify({ version: 1, entries } satisfies StatCache));
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}

async function objectPresent(store: string, hash: string, size: number): Promise<boolean> {
  try {
    const stat = await lstat(path.join(store, 'objects', hash));
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function sourceInventory(source: string): Promise<string> {
  const inventory: Array<[string, string]> = [];
  const seen = new Map<string, { spelling: string; directory: boolean }>();
  async function visit(absolute: string, relative: string): Promise<void> {
    const stat = await lstat(absolute, { bigint: true });
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Unsafe source link/type: ${absolute}`);
    if (relative) {
      if (validateRelativePath(relative) !== relative) throw new Error(`Source path is not canonical: ${relative}`);
      registerPath(seen, relative, stat.isDirectory());
    }
    inventory.push([relative, statIdentity(stat)]);
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
    }
  }
  await visit(path.resolve(source), '');
  return JSON.stringify(inventory);
}

function validateId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid SHA256 hash snapshot/object id');
}

function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error('Invalid manifest fields');
  }
}

/** Includes implied directories: World/a and world/b are a collision too. */
function registerPath(seen: Map<string, { spelling: string; directory: boolean }>, relative: string, directory: boolean): void {
  const parts = relative.split('/');
  for (let count = 1; count <= parts.length; count++) {
    const spelling = parts.slice(0, count).join('/');
    const isDirectory = count < parts.length || directory;
    const key = pathKey(spelling);
    const prior = seen.get(key);
    if (prior && (prior.spelling !== spelling || !prior.directory || !isDirectory)) {
      throw new Error(`Unsafe path collision: ${spelling}`);
    }
    seen.set(key, { spelling, directory: isDirectory });
  }
}

function validateManifest(value: unknown, expectedId: string): SnapshotManifest {
  exactKeys(value, ['version', 'id', 'parentId', 'files']);
  if (value.version !== 1 || value.id !== expectedId || !Array.isArray(value.files)) {
    throw new Error('Invalid snapshot manifest');
  }
  if (value.parentId !== null) validateId(value.parentId);
  const files: SnapshotManifest['files'] = [];
  const seen = new Map<string, { spelling: string; directory: boolean }>();
  let previous: string | undefined;
  for (const entry of value.files) {
    exactKeys(entry, ['path', 'size', 'hash']);
    if (typeof entry.path !== 'string' || validateRelativePath(entry.path) !== entry.path) {
      throw new Error('Manifest path is not canonical');
    }
    if (previous !== undefined && entry.path <= previous) throw new Error('Manifest paths must be sorted and unique');
    previous = entry.path;
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error('Invalid manifest file size');
    }
    validateId(entry.hash);
    registerPath(seen, entry.path, false);
    files.push({ path: entry.path, size: entry.size, hash: entry.hash });
  }
  if (manifestId(value.parentId as string | null, files) !== expectedId) throw new Error('Manifest integrity hash mismatch');
  return { version: 1, id: expectedId, parentId: value.parentId as string | null, files };
}

export async function readSnapshot(storeDir: string, id: string): Promise<SnapshotManifest> {
  validateId(id);
  await assertSafeStore(storeDir);
  return loadManifest(storeDir, id);
}

/** Root, ancestor, link and reparse-point checks for a store. A missing store is allowed. Run once per operation. */
export async function assertSafeStore(storeDir: string): Promise<void> {
  await assertSafeRoots([storeDir]);
}

/** Read and fully validate a manifest. The caller must already have run assertSafeStore for this operation. */
export async function loadManifest(storeDir: string, id: string): Promise<SnapshotManifest> {
  validateId(id);
  const filename = path.join(storeDir, 'snapshots', `${id}.json`);
  const stat = await lstat(filename);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe manifest file/link: ${filename}`);
  return validateManifest(JSON.parse(await readFile(filename, 'utf8')), id);
}

/** Validate untrusted manifest data (exact schema, canonical sorted paths, collisions, sizes and content id). */
export function parseManifest(value: unknown, expectedId: string): SnapshotManifest {
  validateId(expectedId);
  return validateManifest(value, expectedId);
}

export interface PruneResult { snapshotsRemoved: number; objectsRemoved: number; bytesFreed: number }

/**
 * Delete revisions that are neither kept nor within `ancestors` parents of a kept revision, then delete objects no
 * surviving revision references. Every manifest is validated first; anything unexpected aborts before deletion.
 * Callers must hold the store exclusively (no concurrent snapshot or transfer).
 */
export async function pruneStore(storeDir: string, { keep, ancestors = 0, remove }: { keep: string[]; ancestors?: number; remove?: string[] }): Promise<PruneResult> {
  if (!Array.isArray(keep) || !keep.length) throw new Error('Pruning requires at least one revision to keep');
  if (!Number.isInteger(ancestors) || ancestors < 0) throw new RangeError('ancestors must be a non-negative integer');
  await assertSafeStore(storeDir);
  const store = path.resolve(storeDir);
  const snapshotsDir = path.join(store, 'snapshots'), objectsDir = path.join(store, 'objects');
  const manifests = new Map<string, SnapshotManifest>();
  for (const name of await readdir(snapshotsDir)) {
    const id = /^([a-f0-9]{64})\.json$/u.exec(name)?.[1];
    if (!id) throw new Error(`Unexpected entry in snapshot store; refusing to prune: ${name}`);
    manifests.set(id, await loadManifest(store, id));
  }
  const kept = new Set<string>();
  // Targeted automatic retention never treats unknown/unrelated history as disposable.
  if (remove) {
    for (const id of remove) validateId(id);
    const candidates = new Set(remove);
    for (const id of manifests.keys()) if (!candidates.has(id)) kept.add(id);
  }
  for (const id of keep) {
    validateId(id);
    if (!manifests.has(id)) throw Object.assign(new Error(`Kept snapshot is missing: ${id}`), { code: 'ENOENT' });
    // With an explicit removal set, `keep` is the caller's COMPLETE protected closure; expanding it here
    // would silently protect the very revisions the caller asked to replace.
    let current: string | null = id;
    for (let depth = 0; current !== null && manifests.has(current) && depth <= (remove ? 0 : ancestors); depth++) {
      kept.add(current);
      current = manifests.get(current)!.parentId;
    }
  }
  const referenced = new Set<string>();
  for (const id of kept) for (const file of manifests.get(id)!.files) referenced.add(file.hash);
  const objects: Array<{ filename: string; size: number }> = [];
  for (const name of await readdir(objectsDir)) {
    if (referenced.has(name)) continue;
    if (!/^[a-f0-9]{64}$/u.test(name)) throw new Error(`Unexpected entry in object store; refusing to prune: ${name}`);
    const stat = await lstat(path.join(objectsDir, name));
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe object entry; refusing to prune: ${name}`);
    objects.push({ filename: path.join(objectsDir, name), size: stat.size });
  }
  // Manifests go first, so no surviving revision ever references a deleted object.
  let snapshotsRemoved = 0;
  for (const id of manifests.keys()) {
    if (kept.has(id)) continue;
    await rm(path.join(snapshotsDir, `${id}.json`));
    snapshotsRemoved++;
  }
  if (snapshotsRemoved) await syncDirectory(snapshotsDir);
  let bytesFreed = 0;
  for (const object of objects) { await rm(object.filename); bytesFreed += object.size; }
  if (objects.length) await syncDirectory(objectsDir);
  return { snapshotsRemoved, objectsRemoved: objects.length, bytesFreed };
}

/** Rolling history only: keep every unrelated revision and every ancestor of a conflict branch.
 * Caller owns the application operation lock and has verified all custody/journal references. */
export async function pruneBackupHistory(storeDir: string, latest: string, keep: string[]): Promise<PruneResult> {
  const current = await readSnapshot(storeDir, latest);
  // Re-read immutable bytes, including stat-cache hits, before discarding the previous valid copy.
  for (const file of current.files) {
    const filename = path.join(storeDir, 'objects', file.hash);
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe backup object');
    const actual = await hashFile(filename);
    if (actual.hash !== file.hash || actual.size !== file.size) throw new Error('Completed backup object integrity mismatch');
  }
  // Candidate replaceable segment: the completed revision's own ordinary lineage (its predecessors).
  // Explicitly kept revisions (published world, other worlds, custody/journal refs) end the segment,
  // and an ancestor already removed by an earlier retention cycle is a normal dangling parent link.
  const chain = new Set<string>();
  let cursor: string | null = current.parentId;
  while (cursor && !keep.includes(cursor)) {
    if (chain.has(cursor) || cursor === latest) throw new Error('Backup history cycle');
    let manifest: SnapshotManifest;
    try { manifest = await readSnapshot(storeDir, cursor); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
    chain.add(cursor); cursor = manifest.parentId;
  }
  // Nothing is ever deleted except a chain node no surviving line depends on. Unreadable state fails closed.
  const protectedIds = new Set<string>([...keep, latest]);
  const protectLine = async (root: string): Promise<void> => {
    let ancestor: string | null = root;
    const seen = new Set<string>();
    while (ancestor) {
      if (seen.has(ancestor)) throw new Error('Protected backup history cycle');
      seen.add(ancestor);
      // Any chain node this surviving revision descends from is a fork point: never replaceable.
      if (chain.has(ancestor)) protectedIds.add(ancestor);
      try { ancestor = (await readSnapshot(storeDir, ancestor)).parentId; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
    }
  };
  for (const root of keep) await protectLine(root);
  for (const name of await readdir(path.join(storeDir, 'snapshots'))) {
    const id = /^([a-f0-9]{64})\.json$/u.exec(name)?.[1];
    if (!id) throw new Error('Unexpected backup manifest entry');
    if (id === latest || keep.includes(id) || chain.has(id)) continue;
    // A surviving tip outside the replaceable segment keeps its whole line, including shared fork points.
    protectedIds.add(id); await protectLine(id);
  }
  const removal = [...chain].filter((candidate) => !protectedIds.has(candidate));
  return pruneStore(storeDir, { keep: [...protectedIds], remove: removal });
}

export async function materializeSnapshot(storeDir: string, id: string, destinationDir: string): Promise<void> {
  assertDisjoint(storeDir, destinationDir);
  await assertSafeRoots([destinationDir]);
  const manifest = await readSnapshot(storeDir, id);
  await assertPhysicalDisjoint(storeDir, destinationDir);
  const destination = path.resolve(destinationDir);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.seedhost-staging-${randomUUID()}`);
  await mkdir(staging);
  try {
    for (const file of manifest.files) {
      const target = path.join(staging, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      const copied = await streamObject(path.join(storeDir, 'objects', file.hash), target);
      if (copied.hash !== file.hash || copied.size !== file.size) {
        throw new Error(`Snapshot object integrity hash/size mismatch: ${file.path}`);
      }
      const verified = await hashFile(target);
      if (verified.hash !== file.hash || verified.size !== file.size) {
        throw new Error(`Staged file integrity hash/size mismatch: ${file.path}`);
      }
    }
    let exists = false;
    try {
      const stat = await lstat(destination);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Destination must be an ordinary directory');
      exists = true;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const backup = path.join(parent, `.seedhost-previous-${path.basename(destination)}-${randomUUID()}`);
    if (exists) await rename(destination, backup);
    try { await rename(staging, destination); }
    catch (error) {
      if (exists) await rename(backup, destination);
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function importServer(sourceDir: string, managedRoot: string): Promise<{
  serverDir: string; storeDir: string; snapshot: SnapshotManifest;
}> {
  assertDisjoint(sourceDir, managedRoot);
  await assertSafeRoots([sourceDir, managedRoot]);
  await assertPhysicalDisjoint(sourceDir, managedRoot);
  const root = path.resolve(managedRoot);
  const storeDir = path.join(root, 'store');
  const serverDir = path.join(root, 'servers', randomUUID());
  const snapshot = await createSnapshot(sourceDir, storeDir);
  await materializeSnapshot(storeDir, snapshot.id, serverDir);
  return { serverDir, storeDir, snapshot };
}

export async function createSnapshot(
  sourceDir: string, storeDir: string, parentId: string | null = null,
): Promise<SnapshotManifest> {
  assertDisjoint(sourceDir, storeDir);
  await assertSafeRoots([sourceDir, storeDir]);
  await assertPhysicalDisjoint(sourceDir, storeDir);
  if (!(await lstat(sourceDir)).isDirectory()) throw new Error('Source must be a directory');
  // The store was walked once above; reading the parent does not repeat that walk.
  if (parentId !== null) await loadManifest(storeDir, parentId);
  const started = Date.now();
  const before = await sourceInventory(sourceDir);
  const store = path.resolve(storeDir);
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'snapshots'), { recursive: true });
  const cacheFile = await statCacheFile(store, sourceDir);
  const cache = await readStatCache(cacheFile);
  const nextCache: StatCache['entries'] = {};
  const staging = path.join(store, `.staging-${randomUUID()}`);
  await mkdir(staging);
  const files: SnapshotManifest['files'] = [];
  let published = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = validateRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(absolute, relative); continue; }
      const stat = await lstat(absolute, { bigint: true });
      const key = contentKey(stat);
      const settled = Number(stat.mtimeMs) < started - STAT_CACHE_SETTLE_MS;
      const cached = cache.get(relative);
      let result: { size: number; hash: string };
      if (settled && cached?.key === key && BigInt(cached.size) === stat.size && await objectPresent(store, cached.hash, cached.size)) {
        // Unchanged since a previous verified snapshot: reuse its immutable object without re-reading the file.
        result = { size: cached.size, hash: cached.hash };
      } else {
        const temporary = path.join(staging, randomUUID());
        result = await streamObject(absolute, temporary);
        if (!await objectPresent(store, result.hash, result.size)) {
          await syncFile(temporary); // New content must reach the disk before any manifest can reference it.
          published++;
        }
        await publish(temporary, path.join(store, 'objects', result.hash), result);
      }
      if (settled) nextCache[relative] = { key, hash: result.hash, size: result.size };
      files.push({ path: relative, size: result.size, hash: result.hash });
    }
  }
  try {
    await visit(path.resolve(sourceDir), '');
    if (await sourceInventory(sourceDir) !== before) {
      throw new Error('Source changed during snapshot; a stopped, quiescent server is required');
    }
    // Objects and their directory entries are durable before any manifest can reference them.
    if (published) await syncDirectory(path.join(store, 'objects'));
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const manifest: SnapshotManifest = { version: 1, id: manifestId(parentId, files), parentId, files };
    const temporary = path.join(staging, 'manifest.json');
    const encoded = JSON.stringify(manifest);
    await writeDurable(temporary, encoded);
    await publish(temporary, path.join(store, 'snapshots', `${manifest.id}.json`), {
      size: Buffer.byteLength(encoded), hash: createHash('sha256').update(encoded).digest('hex'),
    });
    await syncDirectory(path.join(store, 'snapshots'));
    await writeStatCache(cacheFile, nextCache).catch(() => {}); // Optimization only; a failed write just means a full read next time.
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
