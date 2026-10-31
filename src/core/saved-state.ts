import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isValidEndpointHost } from './endpoints.js';
import { validateSettings, type Settings } from './settings.js';

export const DEFAULT_START_TIMEOUT_SECONDS = 600;
export const DEFAULT_STOP_TIMEOUT_SECONDS = 180;
export const MIN_TIMEOUT_SECONDS = 5;
export const MAX_TIMEOUT_SECONDS = 3600;

export interface LaunchProfile {
  executable: string;
  args: string[];
  /** Seconds to wait for the server's "Done (" line. Large modpacks routinely need several minutes. */
  startTimeoutSeconds: number;
  /** Seconds to wait for a clean `stop`, which includes saving every loaded chunk. */
  stopTimeoutSeconds: number;
}
export interface SavedServer {
  /** Stable identity for this entry in the server library. */
  id: string;
  name: string;
  serverDir: string;
  storeDir: string;
  snapshotId: string;
  profile: LaunchProfile;
  ledgerFile: string;
  /** The one hosting group this world belongs to; null means the world is hosted only by this PC. */
  group: RelayConfig | null;
}
export interface SavedPeer { name: string; fingerprint: string; host: string; port: number }
/** An always-on trusted peer that stores ONE world between hosts. Its endpoint lives in the matching peer entry. */
export interface RelayConfig { fingerprint: string; parkOnStop: boolean }
/** A hosting group this PC joined without any local copy of its world. Identified by the pinned relay fingerprint;
 *  an explicit download/claim creates the new library server and consumes this entry.
 *  `adoptable` marks the explicit LEGACY single-world continuity: only entries created by the old invite-code join,
 *  an explicit local group choice, or the pre-fix migration may continue onto the first world added afterwards.
 *  Modern enrollment (account invitations, joinHostingGroup) stays pending until an explicit download. */
export interface SavedPendingGroup { fingerprint: string; parkOnStop: boolean; relayName: string; since: number; adoptable: boolean }
/** A claim activation that was recorded before its ownership authority was initialized. On restart this is the
 *  durable evidence needed to finish or safely roll back an interrupted append; it is cleared once the ledger
 *  durably records the acceptance. */
export interface SavedActivation {
  serverId: string;
  pending: SavedPendingGroup | null;
  /** The world that was selected before the claim replaced it, so a rollback restores the user's selection. */
  previousActiveServerId: string | null;
}
export interface SavedState {
  version: 2;
  settings: Settings;
  servers: SavedServer[];
  activeServerId: string | null;
  peers: SavedPeer[];
  pendingGroups: SavedPendingGroup[];
  /** Present only while a claim's new server entry is published but its ownership authority is not yet proven. */
  activation?: SavedActivation | null;
}

export type LaunchProfileInput = { executable: string; args: string[]; startTimeoutSeconds?: number; stopTimeoutSeconds?: number };

function invalid(detail: string): never {
  throw new Error(`Invalid saved application state: ${detail}. The file was left unchanged; restore it from a backup.`);
}
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isAbsolutePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && path.isAbsolute(value) && !value.includes('\0');
const isFingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_TIMEOUT_SECONDS && value <= MAX_TIMEOUT_SECONDS;
}

/** Validate a user-supplied launch profile. Missing timeouts take the modpack-friendly defaults. */
export function validateLaunchProfile(input: unknown, allowEmptyExecutable = false): LaunchProfile {
  if (!isObject(input)) throw new Error('Invalid structured launch profile');
  const { executable, args, startTimeoutSeconds, stopTimeoutSeconds } = input;
  if (typeof executable !== 'string' || /[\0\r\n]/.test(executable) || executable.length > 4096 || (!allowEmptyExecutable && !executable.trim())) {
    throw new Error('Invalid structured launch profile');
  }
  if (!Array.isArray(args) || args.length > 100 || args.some((arg) => typeof arg !== 'string' || /[\0\r\n]/.test(arg) || arg.length > 4096)) {
    throw new Error('Invalid structured launch profile');
  }
  for (const value of [startTimeoutSeconds, stopTimeoutSeconds]) {
    if (value !== undefined && !validTimeout(value)) {
      throw new Error(`Launch timeouts must be whole seconds from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}`);
    }
  }
  return {
    executable,
    args: [...args],
    startTimeoutSeconds: (startTimeoutSeconds as number | undefined) ?? DEFAULT_START_TIMEOUT_SECONDS,
    stopTimeoutSeconds: (stopTimeoutSeconds as number | undefined) ?? DEFAULT_STOP_TIMEOUT_SECONDS,
  };
}

export function validateRelayConfig(input: unknown): RelayConfig | null {
  if (input === null) return null;
  if (!isObject(input) || Object.keys(input).sort().join(',') !== 'fingerprint,parkOnStop' ||
      typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint) || typeof input.parkOnStop !== 'boolean') {
    throw new Error('Invalid relay configuration');
  }
  return { fingerprint: input.fingerprint, parkOnStop: input.parkOnStop };
}

export function validatePeer(input: unknown): SavedPeer {
  if (!isObject(input)) throw new Error('Invalid peer identity or endpoint');
  const { name, fingerprint, host, port } = input;
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint) ||
      !isValidEndpointHost(host) || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid peer identity or endpoint');
  }
  return { name, fingerprint, host, port };
}

export const SERVER_ID_PATTERN = /^[a-f0-9]{32}$/;
/** Hard bounds of the saved-state format. `open()` refuses files beyond them, so every mutation must respect the
 * same numbers or it can persist a profile the app will not reopen. Keep both lists bounded in ONE place. */
export const MAX_LIBRARY_SERVERS = 200;
export const MAX_PENDING_GROUPS = 20;
export function newServerId(): string { return randomUUID().replace(/-/g, ''); }
export function isServerId(value: unknown): value is string { return typeof value === 'string' && SERVER_ID_PATTERN.test(value); }

function validateSavedServer(value: unknown, index: number, withGroup: boolean): SavedServer {
  if (!isObject(value)) invalid(`server ${index + 1}`);
  const saved = value;
  if (!isServerId(saved.id)) invalid(`server ${index + 1} id`);
  if (typeof saved.name !== 'string' || saved.name.length > 4096) invalid('server name');
  for (const key of ['serverDir', 'storeDir', 'ledgerFile'] as const) if (!isAbsolutePath(saved[key])) invalid(`server ${key}`);
  if (typeof saved.snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(saved.snapshotId)) invalid('server snapshotId');
  let profile: LaunchProfile;
  try { profile = validateLaunchProfile(saved.profile, true); } catch { invalid('server launch profile'); }
  let group: RelayConfig | null = null;
  if (withGroup && saved.group !== undefined && saved.group !== null) {
    try { group = validateRelayConfig(saved.group); } catch { invalid(`server ${index + 1} hosting group`); }
  }
  return { id: saved.id, name: saved.name, serverDir: saved.serverDir as string, storeDir: saved.storeDir as string,
    snapshotId: saved.snapshotId, profile, ledgerFile: saved.ledgerFile as string, group };
}

function validatePendingGroup(value: unknown, index: number): SavedPendingGroup {
  if (!isObject(value)) invalid(`pending hosting group ${index + 1}`);
  if (!isFingerprint(value.fingerprint) || typeof value.parkOnStop !== 'boolean' ||
      typeof value.relayName !== 'string' || !value.relayName.trim() || value.relayName.length > 100 || /\p{Cc}/u.test(value.relayName) ||
      !Number.isSafeInteger(value.since) || (value.since as number) <= 0) invalid(`pending hosting group ${index + 1}`);
  // Pre-fix modern pending groups have no provenance: preserve membership without granting implicit
  // attachment. Explicit old global-relay migration and new legacy joins set true themselves.
  if (value.adoptable !== undefined && typeof value.adoptable !== 'boolean') invalid(`pending hosting group ${index + 1}`);
  return { fingerprint: value.fingerprint, parkOnStop: value.parkOnStop, relayName: value.relayName, since: value.since as number,
    adoptable: value.adoptable === true };
}

/**
 * Parse state.json without repairing it. Version 1 held a single server; version 2 is the current list form, which
 * carries one hosting group PER SERVER (`server.group`) plus groups joined without a local world (`pendingGroups`).
 * Legacy version-2 files kept ONE app-wide `relay`; those are migrated onto the old active world only — never onto
 * every library world — and become a pending group when no world exists yet.
 */
export function parseSavedState(value: unknown): SavedState {
  if (!isObject(value) || (value.version !== 1 && value.version !== 2)) invalid('unsupported version');
  let settings: Settings;
  try { settings = validateSettings(value.settings); } catch (error) { invalid(`settings (${(error as Error).message})`); }
  if (!Array.isArray(value.peers)) invalid('peers must be a list');
  const peers = value.peers.map((peer, index) => {
    try { return validatePeer(peer); } catch { return invalid(`peer ${index + 1}`); }
  });
  // A legacy file is recognizable by the old app-wide relay field (or by being version 1); it never carries per-server groups.
  const legacy = value.version === 1 || value.relay !== undefined;
  let servers: SavedServer[];
  let activeServerId: string | null;
  if (value.version === 1) {
    // Every v1 alpha held exactly one server, and owning it was mandatory to host.
    const single = value.server;
    if (single === null) { servers = []; activeServerId = null; }
    else { const migrated = validateSavedServer({ ...(isObject(single) ? single : {}), id: newServerId() }, 0, false); servers = [migrated]; activeServerId = migrated.id; }
  } else {
    if (!Array.isArray(value.servers) || value.servers.length > MAX_LIBRARY_SERVERS) invalid('servers must be a list');
    servers = value.servers.map((entry, index) => validateSavedServer(entry, index, !legacy));
    if (new Set(servers.map((entry) => entry.id)).size !== servers.length) invalid('server ids must be unique');
    if (value.activeServerId === null || value.activeServerId === undefined) activeServerId = null;
    else if (!isServerId(value.activeServerId)) invalid('active server id');
    else activeServerId = value.activeServerId;
    if (activeServerId !== null && !servers.some((entry) => entry.id === activeServerId)) invalid('active server is missing from the library');
    if (activeServerId === null && servers.length > 0) invalid('a library with servers needs an active server');
  }
  let pendingGroups: SavedPendingGroup[];
  if (legacy) {
    if (value.version === 2) {
      // Fail closed on an ambiguous hybrid: only legacy files (no per-server groups) may carry the old global relay.
      const rawServers = Array.isArray(value.servers) ? value.servers : [];
      const carriesGroups = rawServers.some((entry) => isObject(entry) && entry.group !== undefined && entry.group !== null);
      const rawPending = value.pendingGroups;
      if (carriesGroups || (rawPending !== undefined && (!Array.isArray(rawPending) || rawPending.length > 0))) invalid('relay cannot be combined with per-server hosting groups');
      if (value.activation !== undefined && value.activation !== null) invalid('relay cannot be combined with a claim activation journal');
    }
    let relay: RelayConfig | null = null;
    try { relay = validateRelayConfig(value.relay ?? null); } catch { invalid('relay'); }
    if (relay && !peers.some((peer) => peer.fingerprint === relay.fingerprint)) invalid('relay is not a trusted peer');
    pendingGroups = [];
    if (relay) {
      const target = activeServerId === null ? undefined : servers.find((entry) => entry.id === activeServerId);
      if (target) target.group = { ...relay };
      else pendingGroups = [{ fingerprint: relay.fingerprint, parkOnStop: relay.parkOnStop,
        relayName: peers.find((peer) => peer.fingerprint === relay.fingerprint)?.name ?? 'Relay', since: Date.now(), adoptable: true }];
    }
  } else {
    if (value.pendingGroups !== undefined && !Array.isArray(value.pendingGroups)) invalid('pending hosting groups must be a list');
    pendingGroups = (value.pendingGroups ?? []).map((entry, index) => validatePendingGroup(entry, index));
    if (pendingGroups.length > MAX_PENDING_GROUPS) invalid('pending hosting groups must be a list');
    if (new Set(pendingGroups.map((entry) => entry.fingerprint)).size !== pendingGroups.length) invalid('pending hosting groups must be unique');
    for (const entry of servers) {
      if (entry.group && !peers.some((peer) => peer.fingerprint === entry.group!.fingerprint)) invalid('a server hosting group is not a trusted peer');
    }
    for (const entry of pendingGroups) {
      if (!peers.some((peer) => peer.fingerprint === entry.fingerprint)) invalid('a pending hosting group is not a trusted peer');
    }
  }
  let activation: SavedActivation | null = null;
  if (value.activation !== undefined && value.activation !== null) {
    const raw = value.activation;
    if (!isObject(raw) || !isServerId(raw.serverId)) invalid('claim activation journal');
    let pending: SavedPendingGroup | null = null;
    if (raw.pending !== undefined && raw.pending !== null) {
      try { pending = validatePendingGroup(raw.pending, 0); } catch { invalid('claim activation journal'); }
    }
    if (raw.previousActiveServerId !== undefined && raw.previousActiveServerId !== null && !isServerId(raw.previousActiveServerId)) invalid('claim activation journal');
    activation = { serverId: raw.serverId, pending, previousActiveServerId: (raw.previousActiveServerId as string | undefined) ?? null };
    if (!servers.some((entry) => entry.id === activation!.serverId)) invalid('a claim activation journal references a missing server');
  }
  return { version: 2, settings, servers, activeServerId, peers, pendingGroups, activation };
}
