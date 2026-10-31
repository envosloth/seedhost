import { crc32, deflateRawSync } from 'node:zlib';
import { open, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export interface ZipEntry {
  /** Name inside the archive, using forward slashes. */
  name: string;
  /** Exactly one of `file` (a path to read) or `data`. */
  file?: string;
  data?: Buffer;
}

const MAX_ENTRY_BYTES = 1024 ** 3;
const MAX_ARCHIVE_BYTES = 4 * 1024 ** 3 - 1; // no Zip64: every offset must fit in 32 bits

function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Write a standard deflate ZIP (UTF-8 names, no Zip64) through a temporary file that is renamed into place only
 * after it is complete and flushed, so an interrupted export never leaves a truncated archive at `destination`.
 */
export async function writeZip(destination: string, entries: ZipEntry[]): Promise<{ bytes: number }> {
  if (!entries.length || entries.length > 65535) throw new Error('A zip needs 1–65,535 entries');
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith('/') || entry.name.includes('\\') || entry.name.split('/').some((part) => part === '..' || part === '')) {
      throw new Error(`Unsafe zip entry name: ${JSON.stringify(entry.name)}`);
    }
    if (names.has(entry.name.toLowerCase())) throw new Error(`Duplicate zip entry name: ${entry.name}`);
    names.add(entry.name.toLowerCase());
    if ((entry.file === undefined) === (entry.data === undefined)) throw new Error('Each zip entry needs exactly one of file or data');
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  let offset = 0;
  const central: Buffer[] = [];
  try {
    // `FileHandle.write` may legally complete short (quota, antivirus filter, network volume). Advance by the bytes
    // actually written and fail loudly, so a truncated archive is never renamed into place and reported as success.
    const write = async (buffer: Buffer) => {
      if (offset + buffer.length > MAX_ARCHIVE_BYTES) throw new Error('Client pack exceeds the 4 GiB zip limit');
      let written = 0;
      while (written < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, written, buffer.length - written);
        if (!bytesWritten) throw new Error(`Zip write made no progress after ${offset + written} bytes`);
        written += bytesWritten;
      }
      offset += written;
    };
    for (const entry of entries) {
      let data: Buffer, modified: Date;
      if (entry.file !== undefined) {
        const info = await stat(entry.file);
        if (info.size > MAX_ENTRY_BYTES) throw new Error(`${entry.name} is larger than 1 GiB`);
        const input = await open(entry.file, 'r');
        try { data = await input.readFile(); } finally { await input.close(); }
        if (data.length !== info.size) throw new Error(`${entry.name} changed while it was being packed`);
        modified = info.mtime;
      } else {
        data = entry.data!;
        modified = new Date();
      }
      const compressed = deflateRawSync(data, { level: 6 });
      const stored = compressed.length >= data.length;
      const body = stored ? data : compressed;
      const method = stored ? 0 : 8;
      const checksum = crc32(data) >>> 0;
      const name = Buffer.from(entry.name, 'utf8');
      const { time, day } = dosDateTime(modified);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(day, 12);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const headerOffset = offset;
      await write(Buffer.concat([local, name]));
      await write(body);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(method, 10);
      record.writeUInt16LE(time, 12);
      record.writeUInt16LE(day, 14);
      record.writeUInt32LE(checksum, 16);
      record.writeUInt32LE(body.length, 20);
      record.writeUInt32LE(data.length, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE(headerOffset, 42);
      central.push(record, name);
    }
    const directory = Buffer.concat(central);
    const directoryOffset = offset;
    await write(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(directoryOffset, 16);
    await write(end);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try { await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
  return { bytes: offset };
}
