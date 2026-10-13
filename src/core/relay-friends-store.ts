import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { syncDirectory } from './snapshots.js';
import { isValidEndpointHost } from './endpoints.js';

export interface FriendMember { name: string; fingerprint: string }
export interface RelayConfig {
  version: 1;
  trusted: FriendMember[];
  history: string[];
  name?: string;
  memberInvites?: boolean;
  /** Appointed locally; never inferred from invitation order or the current world holder. */
  owner?: string;
  /** Canonical world title, appointed-owner-authored; never local aliases or executable settings. */
  serverMetadata?: { owner: string; name: string };
  /** Permanent revocation tombstone; only this former owner may read disband status. */
  disbandedBy?: string;
  /** Certificate-bound durable self-leave receipts; never confer group authority. */
  leftMembers?: string[];
  advertise?: { host: string; port: number };
  /** Token digests only, for same-certificate retry after a lost join response. */
  redeemed?: Record<string, { fingerprint: string; expiresAt: number }>;
}
export interface PendingInvite { version: 1; expiresAt: number; issuer: string | null; recipient?: string }
export const fingerprintOK = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function friendName(value: unknown, max = 60): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\p{Cc}/u.test(value)) throw new Error(`Friend name must be 1–${max} characters with no controls`);
  return value.trim();
}
export function validateServerMetadata(value: unknown, owner: unknown): { owner: string; name: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid server metadata');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'name,owner' || !fingerprintOK(owner) || row.owner !== owner) throw new Error('Invalid server metadata owner or fields');
  const name = friendName(row.name, 100);
  if (name !== row.name) throw new Error('Invalid canonical server name');
  return { owner, name };
}
export function validAdvertise(value: unknown): value is { host: string; port: number } {
  const endpoint = value as { host: string; port: number } | undefined;
  return !!endpoint && isValidEndpointHost(endpoint.host) && endpoint.host !== '0.0.0.0' && Number.isInteger(endpoint.port) && endpoint.port >= 1 && endpoint.port <= 65535;
}
export async function readRelayConfig(root: string, defaultName: string): Promise<RelayConfig> {
  let value: RelayConfig;
  try { value = JSON.parse(await readFile(path.join(root, 'relay.json'), 'utf8')) as RelayConfig; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { version: 1, trusted: [], history: [], name: defaultName, memberInvites: true, redeemed: {} };
  }
  try {
    if (value?.version !== 1 || !Array.isArray(value.trusted) || !Array.isArray(value.history) ||
        value.trusted.length > 200 || value.trusted.some((member) => !fingerprintOK(member?.fingerprint) || !friendName(member.name, 100)) ||
        new Set(value.trusted.map((member) => member.fingerprint)).size !== value.trusted.length ||
        value.history.some((id) => !fingerprintOK(id)) || (value.name !== undefined && !friendName(value.name, 100)) ||
        (value.memberInvites !== undefined && typeof value.memberInvites !== 'boolean') ||
        (value.owner !== undefined && (!fingerprintOK(value.owner) || !value.trusted.some(m => m.fingerprint === value.owner))) ||
        (value.disbandedBy !== undefined && (!fingerprintOK(value.disbandedBy) || value.trusted.length !== 0 || value.owner !== undefined)) ||
        (value.leftMembers !== undefined && (!Array.isArray(value.leftMembers) || value.leftMembers.some(id => !fingerprintOK(id) || value.trusted.some(m => m.fingerprint === id)) || new Set(value.leftMembers).size !== value.leftMembers.length)) ||
        (value.serverMetadata !== undefined && !validateServerMetadata(value.serverMetadata, value.owner ?? value.disbandedBy)) ||
        (value.advertise !== undefined && !validAdvertise(value.advertise)) ||
        (value.redeemed !== undefined && (!value.redeemed || Array.isArray(value.redeemed) || typeof value.redeemed !== 'object' ||
          Object.entries(value.redeemed).some(([hash, entry]) => !fingerprintOK(hash) || !fingerprintOK(entry?.fingerprint) || !Number.isSafeInteger(entry.expiresAt))))) throw new Error();
  } catch { throw new Error('Invalid relay.json; it was left unchanged'); }
  return { ...value, name: value.name ?? defaultName, memberInvites: value.memberInvites ?? true, redeemed: value.redeemed ?? {} };
}

/** Atomic replace plus file and parent-directory sync; no bearer token is stored in relay config. */
export async function durableJSON(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  }
  finally { await rm(temporary, { force: true }); }
}

/** Cross-process serialization. Never guess that a lock is stale and allow two writers. */
export async function withRelayLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const lock = path.join(root, '.friends-mutation.lock');
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Relay configuration is locked; after a crash, stop all relay processes before removing .friends-mutation.lock');
      await delay(15);
    }
  }
  try { return await work(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}
