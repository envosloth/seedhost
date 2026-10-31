import { open } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { effectiveServerPort } from './server-properties.js';

type Interfaces = Record<string, Array<{ address: string; family: string | number; internal: boolean }> | undefined>;

// Addresses other PCs on the same home network can usually reach. Container/VM bridges and
// public, CGNAT/Tailscale (100.64/10) and loopback addresses are excluded.
export function privateLanAddresses(interfaces: Interfaces = networkInterfaces() as Interfaces): string[] {
  const result: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (/^(docker|br-|veth|virbr|lo)/.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.internal || (entry.family !== 'IPv4' && entry.family !== 4)) continue;
      const [a = -1, b = -1] = entry.address.split('.').map(Number);
      if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) result.push(entry.address);
    }
  }
  return [...new Set(result)].slice(0, 4);
}

// Tailscale (CGNAT 100.64.0.0/10) addresses: reachable by the user's own devices on their tailnet.
export function tailnetAddresses(interfaces: Interfaces = networkInterfaces() as Interfaces): string[] {
  const result: string[] = [];
  for (const entries of Object.values(interfaces)) for (const entry of entries ?? []) {
    if (entry.internal || (entry.family !== 'IPv4' && entry.family !== 4)) continue;
    const [a = -1, b = -1] = entry.address.split('.').map(Number);
    if (a === 100 && b >= 64 && b <= 127) result.push(entry.address);
  }
  return [...new Set(result)].slice(0, 2);
}

export async function readServerPort(serverDir: string): Promise<number> {
  try {
    const handle = await open(path.join(serverDir, 'server.properties'), 'r');
    let text: string;
    try { const buffer = Buffer.alloc(65536); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); text = buffer.subarray(0, bytesRead).toString('utf8'); }
    finally { await handle.close(); }
    // Same Java-compatible reader as launch preflight: a guard must never be given a port the JVM will not bind.
    return effectiveServerPort(text);
  } catch { return 25565; }
}
