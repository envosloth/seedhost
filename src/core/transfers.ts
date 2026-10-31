import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { connectPeer, readFrame, writeFrame, type PeerIdentity } from './peer-transport.js';
import { assertSafeStore, loadManifest, parseManifest, syncDirectory, type SnapshotManifest } from './snapshots.js';
import type { TransferOffer } from './ownership.js';
export type { TransferOffer } from './ownership.js';

export interface TransferPeer { fingerprint: string; host: string; port: number }
export interface ReceiveOptions {
  /** Free space that must remain on the receiving volume after the transfer. Default 1 GiB. */
  reserveBytes?: number;
}
type FileEntry = SnapshotManifest['files'][number];

const PROTOCOL_VERSION = 2;
const CHUNK_BYTES = 65536;
const MAX_FRAME_BYTES = 1048576;
const MAX_MANIFEST_BYTES = 64 * 1024 ** 2;
const MAX_FILE_ENTRIES = 65536;
const MAX_OBJECT_BYTES = 16 * 1024 ** 3;
const MAX_TOTAL_BYTES = 128 * 1024 ** 3;
const DEFAULT_RESERVE_BYTES = 1024 ** 3;
/** Transfer-only whole-frame deadlines include disk/backpressure waits. Never reset on trickle traffic.
 * Each awaited write/read is bounded; no whole-world deadline (worlds may be 128 GiB).
 * Relay prefaces, initial admission and error replies keep the ordinary 5 s control budget. */
const SLOW_PHASE_TIMEOUT_MS = 120000;
const FILES_FRAME_OVERHEAD = Buffer.byteLength(JSON.stringify({ type: 'files', files: [] }));

function hex(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid lowercase SHA256 id/hash/fingerprint');
}
function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('Invalid transfer fields');
}
function validateOffer(value: unknown, snapshotId: string): TransferOffer | undefined {
  if (value === null) return undefined;
  fields(value, ['id', 'lineage', 'source', 'target', 'generation', 'snapshotId']);
  for (const key of ['id', 'lineage', 'source', 'target']) {
    const item = value[key];
    if (typeof item !== 'string' || !item.length || item.length > 128 || /[\u0000-\u001f\u007f]/u.test(item)) throw new Error('Invalid ownership offer identifier');
  }
  hex(value.snapshotId);
  if (value.snapshotId !== snapshotId || typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new Error('Invalid ownership offer revision/generation');
  }
  return { id: value.id as string, lineage: value.lineage as string, source: value.source as string, target: value.target as string,
    generation: value.generation, snapshotId: value.snapshotId };
}
async function writeTransferFrame(socket: TLSSocket, value: unknown): Promise<void> {
  await writeFrame(socket, value, SLOW_PHASE_TIMEOUT_MS);
}
async function frame(socket: TLSSocket, timeoutMs = SLOW_PHASE_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const value: unknown = await readFrame(socket, undefined, timeoutMs);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid transfer frame');
  const message = value as Record<string, unknown>;
  if (message.type === 'error') throw new Error(`Peer transfer rejected: ${String(message.message).slice(0, 512)}`);
  return message;
}
async function safeOpen(filename: string) {
  const before = await lstat(filename);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('Unsafe object link or file type');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const actual = await handle.stat();
  if (!actual.isFile() || actual.ino !== before.ino || actual.dev !== before.dev) {
    await handle.close();
    throw new Error('Object changed while opening');
  }
  return handle;
}
async function verifyFile(filename: string, expected: { hash: string; size: number }): Promise<void> {
  const handle = await safeOpen(filename);
  try {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ highWaterMark: CHUNK_BYTES, autoClose: false })) {
      size += chunk.length;
      if (size > expected.size) throw new Error('Object integrity length mismatch');
      hash.update(chunk);
    }
    if (size !== expected.size || hash.digest('hex') !== expected.hash) throw new Error('Object integrity hash/length mismatch');
  } finally { await handle.close(); }
}
/** The staged object was hashed while it streamed in; after linking, the published target is verified once. */
async function publishObject(temporary: string, target: string, expected: { hash: string; size: number }) {
  try { await link(temporary, target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await verifyFile(target, expected);
}
/** Unique objects of one revision, with the per-object and total policy limits. */
function objectsOf(files: FileEntry[]) {
  if (files.length > MAX_FILE_ENTRIES) throw new Error('Manifest file count limit exceeded');
  const objects = new Map<string, { hash: string; size: number }>();
  let total = 0;
  for (const file of files) {
    if (file.size > MAX_OBJECT_BYTES) throw new Error('Object byte limit exceeded');
    const prior = objects.get(file.hash);
    if (prior && prior.size !== file.size) throw new Error('Conflicting object lengths');
    if (!prior) {
      total += file.size;
      if (total > MAX_TOTAL_BYTES) throw new Error('Total object byte limit exceeded');
    }
    objects.set(file.hash, { hash: file.hash, size: file.size });
  }
  return objects;
}
/** Split file entries into `files` frames that each fit the one-MiB frame limit. */
function fileBatches(files: FileEntry[]): FileEntry[][] {
  const batches: FileEntry[][] = [];
  let current: FileEntry[] = [], bytes = FILES_FRAME_OVERHEAD;
  for (const file of files) {
    const size = Buffer.byteLength(JSON.stringify(file), 'utf8') + 1;
    if (FILES_FRAME_OVERHEAD + size > MAX_FRAME_BYTES) throw new Error('File entry metadata exceeds the one-MiB frame limit');
    if (bytes + size > MAX_FRAME_BYTES) { batches.push(current); current = []; bytes = FILES_FRAME_OVERHEAD; }
    current.push(file);
    bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}
async function readFileEntries(socket: TLSSocket, count: number): Promise<unknown[]> {
  const files: unknown[] = [];
  let metadataBytes = 0;
  while (files.length < count) {
    const batch = await frame(socket);
    fields(batch, ['type', 'files']);
    if (batch.type !== 'files' || !Array.isArray(batch.files) || !batch.files.length) throw new Error('Invalid manifest file batch');
    if (files.length + batch.files.length > count) throw new Error('Manifest file count mismatch');
    metadataBytes += Buffer.byteLength(JSON.stringify(batch.files), 'utf8');
    if (metadataBytes > MAX_MANIFEST_BYTES) throw new Error('Snapshot metadata 64-MiB limit exceeded');
    files.push(...batch.files);
  }
  return files;
}
const gib = (bytes: bigint) => `${(Number(bytes) / 1024 ** 3).toFixed(2)} GiB`;
async function requireFreeSpace(directory: string, needed: number, reserve: number): Promise<void> {
  const stat = await statfs(directory, { bigint: true });
  const free = stat.bavail * stat.bsize;
  if (free < BigInt(needed) + BigInt(reserve)) {
    throw new Error(`Insufficient disk space: the transfer needs ${gib(BigInt(needed))} plus a ${gib(BigInt(reserve))} free-space reserve, but only ${gib(free)} is available`);
  }
}

/** Preflight the materialized copy as well as transfer bytes, on its actual destination volume. */
export async function requireFreeSpaceFor(directory: string, neededBytes: number, reserveBytes = DEFAULT_RESERVE_BYTES): Promise<void> {
  if (!Number.isSafeInteger(neededBytes) || neededBytes < 0) throw new RangeError('neededBytes must be a non-negative safe integer');
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) throw new RangeError('reserveBytes must be a non-negative safe integer');
  let probe = path.resolve(directory);
  for (;;) {
    try { await requireFreeSpace(probe, neededBytes, reserveBytes); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
}

export interface SendResult { snapshot: SnapshotManifest; filesSent: number; bytesSent: number; ownershipAccepted: boolean }

/**
 * Dial a pinned peer and send a snapshot. `preface` is an optional first frame (the relay uses it to select an
 * operation); everything after it is the ordinary transfer protocol.
 */
export async function sendSnapshotToPeer(identity: PeerIdentity, peer: TransferPeer, storeDir: string,
  snapshotId: string, offer?: TransferOffer, { preface }: { preface?: unknown } = {}): Promise<SendResult> {
  const prepared = await prepareSend(storeDir, snapshotId, offer);
  const socket = await connectPeer(identity, peer.fingerprint, peer.host, peer.port);
  try {
    if (preface !== undefined) await writeFrame(socket, preface);
    return await sendPrepared(socket, prepared);
  } finally { socket.destroy(); }
}

/** Send a snapshot over an already pinned socket, in either connection direction. The caller owns the socket. */
export async function sendSnapshot(socket: TLSSocket, storeDir: string, snapshotId: string, offer?: TransferOffer, beforeComplete?: () => Promise<void>): Promise<SendResult> {
  return sendPrepared(socket, await prepareSend(storeDir, snapshotId, offer), beforeComplete);
}

async function prepareSend(storeDir: string, snapshotId: string, offer?: TransferOffer) {
  hex(snapshotId);
  await assertSafeStore(storeDir);
  const manifestStat = await lstat(path.join(storeDir, 'snapshots', `${snapshotId}.json`));
  if (manifestStat.size > MAX_MANIFEST_BYTES) throw new Error('Snapshot metadata 64-MiB limit exceeded');
  const snapshot = await loadManifest(storeDir, snapshotId);
  const validated = validateOffer(offer ?? null, snapshotId);
  // Only the head revision is sent. The receiver can materialize it alone, so history never grows a transfer.
  return { storeDir, snapshotId, snapshot, offer: validated, batches: fileBatches(snapshot.files), objects: objectsOf(snapshot.files) };
}

async function sendPrepared(socket: TLSSocket, { storeDir, snapshotId, snapshot, offer, batches, objects }: Awaited<ReturnType<typeof prepareSend>>, beforeComplete?: () => Promise<void>): Promise<SendResult> {
  {
    await writeTransferFrame(socket, { type: 'snapshot', version: PROTOCOL_VERSION, snapshotId, parentId: snapshot.parentId,
      fileCount: snapshot.files.length, offer: offer ?? null });
    for (const files of batches) await writeTransferFrame(socket, { type: 'files', files });
    // The receiver re-verifies objects it already holds before answering, which can take a while on large stores.
    const request = await frame(socket, SLOW_PHASE_TIMEOUT_MS);
    fields(request, ['type', 'hashes']);
    if (request.type !== 'need' || !Array.isArray(request.hashes)) throw new Error('Invalid missing-object request');
    const requested = new Set<string>();
    if (request.hashes.length > objects.size) throw new Error('Missing-object request count exceeds advertised objects');
    for (const hash of request.hashes) {
      hex(hash);
      if (!objects.has(hash) || requested.has(hash)) throw new Error('Unadvertised or duplicate requested object');
      requested.add(hash);
    }
    let filesSent = 0, bytesSent = 0;
    for (const hash of requested) {
      const object = objects.get(hash)!;
      const handle = await safeOpen(path.join(storeDir, 'objects', hash));
      try {
        await writeTransferFrame(socket, { type: 'object', hash, size: object.size });
        const digest = createHash('sha256');
        let size = 0;
        for await (const chunk of handle.createReadStream({ highWaterMark: CHUNK_BYTES, autoClose: false })) {
          size += chunk.length;
          if (size > object.size) throw new Error('Source object integrity length mismatch');
          digest.update(chunk);
          await writeTransferFrame(socket, { type: 'chunk', data: chunk.toString('base64') });
        }
        if (size !== object.size || digest.digest('hex') !== hash) throw new Error('Source object integrity hash/length mismatch');
        await writeTransferFrame(socket, { type: 'object-end', hash });
        filesSent++;
        bytesSent += size;
      } finally { await handle.close(); }
    }
    // Receiver callbacks cannot accept authority before complete. Fence cancellation durably first.
    await beforeComplete?.();
    await writeTransferFrame(socket, { type: 'complete', snapshotId, filesSent, bytesSent });
    const ack = await frame(socket, SLOW_PHASE_TIMEOUT_MS);
    fields(ack, ['type', 'snapshotId', 'filesSent', 'bytesSent', 'ownershipAccepted']);
    if (ack.type !== 'ack' || ack.snapshotId !== snapshotId || ack.filesSent !== filesSent || ack.bytesSent !== bytesSent ||
        typeof ack.ownershipAccepted !== 'boolean') throw new Error('Snapshot acknowledgment id/counters mismatch');
    if (ack.ownershipAccepted && !offer) throw new Error('Ownership acknowledgment without a transfer offer');
    return { snapshot, filesSent, bytesSent, ownershipAccepted: ack.ownershipAccepted };
  }
}

export async function receiveSnapshot(socket: TLSSocket, authenticatedFingerprint: string, storeDir: string,
  onSnapshot?: (snapshot: SnapshotManifest, source: string, offer?: TransferOffer) => Promise<boolean | void>,
  options: ReceiveOptions = {}): Promise<void> {
  let staging: string | undefined;
  try {
    const reserveBytes = options.reserveBytes ?? DEFAULT_RESERVE_BYTES;
    if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) throw new RangeError('reserveBytes must be a non-negative safe integer');
    hex(authenticatedFingerprint);
    const raw = socket.getPeerCertificate().raw;
    if (!raw || createHash('sha256').update(raw).digest('hex') !== authenticatedFingerprint) throw new Error('Authenticated source fingerprint mismatch');
    // All metadata is validated in memory before any filesystem write.
    const hello = await frame(socket, 5000); // The transport gate refuses unpinned TLS before any application frame.
    fields(hello, ['type', 'version', 'snapshotId', 'parentId', 'fileCount', 'offer']);
    if (hello.type !== 'snapshot') throw new Error('Invalid snapshot transfer metadata');
    if (hello.version !== PROTOCOL_VERSION) {
      throw new Error(`Unsupported transfer protocol version ${String(hello.version).slice(0, 32)}; both peers must run the same SeedHost alpha`);
    }
    hex(hello.snapshotId);
    if (hello.parentId !== null) hex(hello.parentId);
    if (typeof hello.fileCount !== 'number' || !Number.isSafeInteger(hello.fileCount) || hello.fileCount < 0) throw new Error('Invalid manifest file count');
    if (hello.fileCount > MAX_FILE_ENTRIES) throw new Error('Manifest file count limit exceeded');
    const offer = validateOffer(hello.offer, hello.snapshotId);
    const entries = await readFileEntries(socket, hello.fileCount);
    const snapshot = parseManifest({ version: 1, id: hello.snapshotId, parentId: hello.parentId, files: entries }, hello.snapshotId);
    const objects = objectsOf(snapshot.files);
    await assertSafeStore(storeDir);
    await mkdir(storeDir, { recursive: true });
    const hashes: string[] = [];
    let neededBytes = 0;
    for (const object of objects.values()) {
      try { await verifyFile(path.join(storeDir, 'objects', object.hash), object); }
      catch (error) {
        // A corrupt published object is not silently trusted or overwritten. Quarantine is a separate local operation.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        hashes.push(object.hash);
        neededBytes += object.size;
      }
    }
    if (neededBytes > 0) await requireFreeSpace(storeDir, neededBytes, reserveBytes);
    staging = await mkdtemp(path.join(storeDir, '.transfer-'));
    await mkdir(path.join(staging, 'objects'));
    await writeTransferFrame(socket, { type: 'need', hashes });
    let filesSent = 0, bytesSent = 0;
    for (const hash of hashes) {
      const object = objects.get(hash)!;
      const start = await frame(socket);
      fields(start, ['type', 'hash', 'size']);
      if (start.type !== 'object' || start.hash !== hash || start.size !== object.size) throw new Error('Unexpected object header');
      const handle = await open(path.join(staging, 'objects', hash), 'wx');
      let size = 0;
      const digest = createHash('sha256');
      try {
        for (;;) {
          const part = await frame(socket);
          if (part.type === 'object-end') {
            fields(part, ['type', 'hash']);
            if (part.hash !== hash || size !== object.size || digest.digest('hex') !== hash) throw new Error('Incoming object integrity hash/length mismatch');
            break;
          }
          fields(part, ['type', 'data']);
          if (part.type !== 'chunk' || typeof part.data !== 'string' || !part.data.length || part.data.length > 87384) throw new Error('Invalid object chunk');
          const chunk = Buffer.from(part.data, 'base64');
          if (chunk.length > CHUNK_BYTES || chunk.toString('base64') !== part.data || !chunk.length) throw new Error('Invalid canonical base64 chunk');
          size += chunk.length;
          if (size > object.size) throw new Error('Incoming object integrity length exceeds manifest');
          digest.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const written = await handle.write(chunk, offset, chunk.length - offset);
            if (!written.bytesWritten) throw new Error('Failed to write incoming object');
            offset += written.bytesWritten;
          }
        }
        await handle.sync();
      } finally { await handle.close(); }
      filesSent++;
      bytesSent += size;
    }
    const complete = await frame(socket);
    fields(complete, ['type', 'snapshotId', 'filesSent', 'bytesSent']);
    if (complete.type !== 'complete' || complete.snapshotId !== snapshot.id || complete.filesSent !== filesSent || complete.bytesSent !== bytesSent) {
      throw new Error('Transfer completion id/counters mismatch');
    }
    const objectsDir = path.join(storeDir, 'objects'), snapshotsDir = path.join(storeDir, 'snapshots');
    await mkdir(objectsDir, { recursive: true });
    await mkdir(snapshotsDir, { recursive: true });
    for (const hash of hashes) await publishObject(path.join(staging, 'objects', hash), path.join(objectsDir, hash), objects.get(hash)!);
    if (hashes.length) await syncDirectory(objectsDir);
    // Pre-existing objects were hashed above; confirm they are still in place before the revision becomes visible.
    for (const object of objects.values()) {
      const stat = await lstat(path.join(objectsDir, object.hash));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== object.size) throw new Error('Object integrity: an object disappeared or changed before publication');
    }
    const stagedManifest = path.join(staging, `${snapshot.id}.json`);
    const manifestHandle = await open(stagedManifest, 'wx');
    try { await manifestHandle.writeFile(JSON.stringify(snapshot)); await manifestHandle.sync(); }
    finally { await manifestHandle.close(); }
    try { await link(stagedManifest, path.join(snapshotsDir, `${snapshot.id}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (JSON.stringify(await loadManifest(storeDir, snapshot.id)) !== JSON.stringify(snapshot)) throw new Error('Published manifest integrity mismatch');
    await syncDirectory(snapshotsDir);
    let decision: boolean | void = undefined;
    if (onSnapshot) {
      let approvalTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Bound the wait, not the callback's side effects: durable authority cannot be rolled back here.
        decision = await Promise.race([
          onSnapshot(snapshot, authenticatedFingerprint, offer),
          new Promise<never>((_, reject) => {
            approvalTimer = setTimeout(() => reject(new Error(
              'Snapshot approval timed out after 120000ms; callback may still complete; ownership requires explicit reconciliation',
            )), SLOW_PHASE_TIMEOUT_MS);
          }),
        ]);
      } finally { clearTimeout(approvalTimer); }
    }
    // A callback that *returns* (rather than throws or times out) has given a definitive answer. `false` means it
    // committed nothing, which is what lets the sender safely cancel its offer.
    const ownershipAccepted = offer !== undefined && decision === true;
    await writeTransferFrame(socket, { type: 'ack', snapshotId: snapshot.id, filesSent, bytesSent, ownershipAccepted });
    socket.end();
  } catch (error) {
    if (!socket.destroyed) await writeFrame(socket, { type: 'error', message: error instanceof Error ? error.message.slice(0, 512) : 'Snapshot transfer failed' }).catch(() => {});
    socket.destroy();
    throw error;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
