import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { writeZip } from '../dist/src/core/zip.js';

const scratch = async (t, prefix) => {
  assert.ok(process.env.TMPDIR, 'Hermes scratch TMPDIR is required');
  const dir = await mkdtemp(path.join(process.env.TMPDIR, prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/** Minimal structural check: local header first, EOCD last, and the central directory exactly where EOCD points. */
async function assertWellFormed(file, expectedBytes) {
  const bytes = await readFile(file);
  assert.equal(bytes.length, expectedBytes, 'published size matches the reported size');
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'local file header');
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50, 'end of central directory is the final record');
  const directoryOffset = bytes.readUInt32LE(bytes.length - 6);
  assert.equal(bytes.readUInt32LE(directoryOffset), 0x02014b50, 'central directory starts where EOCD says');
  assert.equal(bytes.length - 22 - directoryOffset, bytes.readUInt32LE(bytes.length - 10), 'directory size is exact');
}
const payload = [{ name: 'mods/a.jar', data: Buffer.alloc(4096, 7) }, { name: 'README.txt', data: Buffer.from('hello') }];

test('a successful archive reports exactly the bytes it published', async (t) => {
  const dir = await scratch(t, 'zip-size-');
  const destination = path.join(dir, 'pack.zip');
  const result = await writeZip(destination, payload);
  await assertWellFormed(destination, result.bytes);
  assert.equal(result.bytes, (await stat(destination)).size);
});

/**
 * `FileHandle.write` may legally complete short. Advancing by the requested length instead of the written length
 * publishes a truncated archive while claiming success, so every short write must continue at the right offset.
 */
test('short but progressing file writes still publish a complete, well-formed archive', async (t) => {
  const dir = await scratch(t, 'zip-short-write-');
  const destination = path.join(dir, 'pack.zip');
  const original = fsPromises.open;
  let writes = 0;
  fsPromises.open = async (file, ...args) => {
    const handle = await original(file, ...args);
    if (!String(file).startsWith(`${destination}.`)) return handle;
    return {
      write: async (buffer, offset = 0, length = buffer.length - offset) => {
        writes++;
        return handle.write(buffer, offset, Math.max(1, length >> 1));
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  };
  syncBuiltinESMExports();
  let result;
  try { result = await writeZip(destination, payload); }
  finally { fsPromises.open = original; syncBuiltinESMExports(); }
  assert.ok(writes > 4, 'the fault was exercised repeatedly');
  await assertWellFormed(destination, result.bytes);
});

test('a write that makes no progress fails the export and leaves no archive behind', async (t) => {
  const dir = await scratch(t, 'zip-stalled-');
  const destination = path.join(dir, 'pack.zip');
  const original = fsPromises.open;
  fsPromises.open = async (file, ...args) => {
    const handle = await original(file, ...args);
    if (!String(file).startsWith(`${destination}.`)) return handle;
    return { write: async () => ({ bytesWritten: 0 }), sync: () => handle.sync(), close: () => handle.close() };
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(writeZip(destination, payload), /made no progress/i);
  } finally {
    fsPromises.open = original;
    syncBuiltinESMExports();
  }
  await assert.rejects(stat(destination), { code: 'ENOENT' }, 'a truncated archive is never left at the destination');
});
