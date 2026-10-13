import type { TLSSocket } from 'node:tls';
import { connectPeer, PeerTransportError, isRetryablePeerError, readFrame, writeFrame, type PeerIdentity } from './peer-transport.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { TransferPeer } from './transfers.js';
import { decodeInvite, type CreatedInvite } from './invites.js';
import { isPrivateEndpointHost } from './endpoints.js';
import { friendName, validateServerMetadata } from './relay-friends-store.js';

/** Relay connections start with one of these frames; `park` and `claim` then run the ordinary transfer protocol. */
export const RELAY_PROTOCOL_VERSION = 1;
export type RelayOperation = 'withdraw-offer' | 'recovery-status' | 'status' | 'park' | 'claim' | 'join' | 'invite' | 'friends' | 'gateway-status' | 'game-tunnel' | 'public-status' | 'public-enable' | 'public-disable' | 'remove-friend' | 'invite-for' | 'disband' | 'disband-status' | 'leave' | 'leave-status' | 'initial-publish' | 'host-start' | 'host-running' | 'host-cancel' | 'host-stopped' | 'server-metadata';
export const relayRequest = (op: RelayOperation) => ({ type: 'relay', version: RELAY_PROTOCOL_VERSION, op });

/** The only hostnames this app's public addresses take; shared by the relay store and its clients. */
export const HOST_ENDPOINT_ADDRESS = /^[a-z0-9][a-z0-9-]{0,62}\.(?:tun\.ply\.gg|joinmc\.link)$/;
export interface HostEndpoint { address: string; verifiedAt: number }
export function validHostEndpoint(value: unknown): value is HostEndpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.address === 'string' && HOST_ENDPOINT_ADDRESS.test(record.address) &&
    Number.isSafeInteger(record.verifiedAt) && (record.verifiedAt as number) > 0;
}

export interface RelayCustody {
  /** Fingerprint of the current authority: the relay itself while parked, otherwise the PC that claimed it. */
  owner: string;
  state: 'owned' | 'offered' | 'transferred';
  generation: number;
  snapshotId: string;
  /** Set while a claim is waiting for that PC's acknowledgment. Only that PC can complete (retry) it. */
  pendingTarget: string | null;
}
export interface RelayStatus extends RelayCustody { ownerName: string | null; pendingName: string | null; /** True only with a current authenticated host control session; null means unknown, never idle. */ hosting: true | null; /** Null for older relays: absence never proves no pending admission. */ pendingStart: boolean | null; /** The verified join address the current host session published, or null. Only meaningful while `hosting` is true. */ holderEndpoint: HostEndpoint | null }
export type RelayFriendsCustody = 'unknown' | 'parked' | 'pending' | 'held';
export interface RelayFriends {
  serverMetadata?: { owner: string; name: string };
  canManage: boolean;
  owner: string | null;
  members: { name: string; fingerprint: string; you: boolean }[];
  /** Relay ledger knowledge, not a claim about servers it has never seen. */
  custody: RelayFriendsCustody;
  /** A device name only when custody is held; otherwise null. */
  holder: string | null;
}
type RelayPeer = TransferPeer & { name?: string };

async function friendRequest(identity: PeerIdentity, relay: RelayPeer, request: unknown, replyTimeoutMs?: number): Promise<Record<string, unknown>> {
  const socket = await connectPeer(identity, relay.fingerprint, relay.host, relay.port);
  try {
    await writeFrame(socket, request);
    const frame: unknown = await readFrame(socket, 262144, replyTimeoutMs);
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid relay reply');
    const reply = frame as Record<string, unknown>;
    if (reply.type === 'error') throw new Error(`Relay refused: ${String(reply.message).slice(0, 512)}`);
    return reply;
  } finally { socket.destroy(); }
}

/** Redeem only against the code's pinned relay. Caller persists its local peer/config only after success. */
export async function joinRelayInvite(identity: PeerIdentity, code: string, name: string): Promise<{ relayName: string }> {
  const invite = decodeInvite(code);
  const memberName = friendName(name);
  if (invite.relayFingerprint === identity.fingerprint) throw new Error('Cannot join your own relay identity');
  let reply: Record<string, unknown>;
  for (let attempt = 0; ; attempt++) {
    try {
      reply = await friendRequest(identity, { fingerprint: invite.relayFingerprint, host: invite.host, port: invite.port },
        { ...relayRequest('join'), token: invite.token.toString('hex'), name: memberName });
      break;
    } catch (error) {
      // Only an explicit refusal from the pinned relay warrants this diagnostic. Admission
      // precedes token disclosure, so the relay cannot identify which token condition failed.
      if (error instanceof PeerTransportError && error.code === 'PEER_AUTHORIZATION_DENIED') {
        throw new PeerTransportError(error.code, 'Invitation unavailable: expired, used, revoked or not valid');
      }
      // Join is replay-safe only with this exact token, certificate and pinned endpoint: the
      // relay's durable receipt allows the same device to recover a lost response, never another.
      if (attempt === 0 && isRetryablePeerError(error)) {
        await delay(150);
        decodeInvite(code); // Expiry still fails closed before a second token disclosure.
        continue;
      }
      if (isRetryablePeerError(error)) {
        const privateRoute = isPrivateEndpointHost(invite.host)
          ? ` The invitation names a private address (${invite.host}), which only works when both PCs share the same home network or VPN. Ask the group owner for an invitation that uses a public ingress or Tailscale address.` : '';
        throw new Error(`Could not complete invitation acceptance at ${invite.host}:${invite.port}: ${(error as Error).message}. This pinned relay must be reachable separately from the account directory and Minecraft player address.${privateRoute} Retry the same invitation on this PC.`, { cause: error });
      }
      throw error;
    }
  }
  if (reply.type !== 'relay-joined' || typeof reply.relayName !== 'string') throw new Error('Invalid relay join reply');
  return { relayName: friendName(reply.relayName, 100) };
}

/** Member-generated invites default to 24 hours and the relay's configured advertised endpoint. */
export async function relayInvite(identity: PeerIdentity, relay: RelayPeer): Promise<CreatedInvite> {
  return parseInvitation(await friendRequest(identity, relay, relayRequest('invite')), relay);
}

export async function relayInviteFor(identity: PeerIdentity, relay: RelayPeer, fingerprint: string): Promise<CreatedInvite> {
  if (!hex(fingerprint)) throw new Error('Invalid friend');
  return parseInvitation(await friendRequest(identity, relay, { ...relayRequest('invite-for'), fingerprint }), relay);
}

function parseInvitation(reply: Record<string, unknown>, relay: RelayPeer): CreatedInvite {
  if (reply.type !== 'relay-invite' || typeof reply.code !== 'string' || !Number.isSafeInteger(reply.expiresAt)) throw new Error('Invalid relay invite reply');
  const invite = decodeInvite(reply.code);
  if (invite.relayFingerprint !== relay.fingerprint || invite.expiresAt * 1000 !== reply.expiresAt) throw new Error('Invalid relay invite pin or expiry');
  return { code: reply.code, expiresAt: reply.expiresAt as number };
}

export async function relayFriends(identity: PeerIdentity, relay: RelayPeer): Promise<RelayFriends> {
  const reply = await friendRequest(identity, relay, relayRequest('friends'));
  if (reply.type !== 'relay-friends' || !Array.isArray(reply.members) || reply.members.length > 200 ||
      !['unknown', 'parked', 'pending', 'held'].includes(reply.custody as string) ||
      (reply.custody === 'held' ? typeof reply.holder !== 'string' : reply.holder !== null)) throw new Error('Invalid relay friends reply');
  const members = reply.members.map((value: unknown) => {
    const member = value as Record<string, unknown>;
    if (!member || !hex(member.fingerprint) || typeof member.you !== 'boolean' || member.you !== (member.fingerprint === identity.fingerprint)) throw new Error('Invalid relay member');
    return { name: friendName(member.name, 100), fingerprint: member.fingerprint, you: member.you };
  });
  if (new Set(members.map((member) => member.fingerprint)).size !== members.length || !members.some((member) => member.you)) throw new Error('Invalid relay membership');
  if (reply.canManage !== undefined && typeof reply.canManage !== 'boolean') throw new Error('Invalid group permissions');
  const owner = reply.owner ?? null;
  if (owner !== null && (!hex(owner) || !members.some(m => m.fingerprint === owner))) throw new Error('Invalid group owner');
  if (reply.canManage === true && owner !== identity.fingerprint) throw new Error('Invalid group permissions');
  const metadata = reply.serverMetadata === undefined ? {} : { serverMetadata: validateServerMetadata(reply.serverMetadata, owner) };
  return { ...metadata, members, canManage: reply.canManage === true, owner: owner as string | null, custody: reply.custody as RelayFriendsCustody, holder: reply.holder === null ? null : friendName(reply.holder, 100) };
}

/** Appointed owner only. Durable pinned-authority readback precedes success. */
export async function relaySetServerName(identity: PeerIdentity, relay: RelayPeer, name: string): Promise<void> {
  const metadata = validateServerMetadata({ owner: identity.fingerprint, name }, identity.fingerprint);
  const reply = await friendRequest(identity, relay, { ...relayRequest('server-metadata'), metadata });
  if (Object.keys(reply).join(',') !== 'type' || reply.type !== 'relay-metadata-saved') throw new Error('Invalid server metadata acknowledgment');
  const readback = await relayFriends(identity, relay);
  if (readback.serverMetadata?.owner !== identity.fingerprint || readback.serverMetadata.name !== name) throw new Error('Canonical server name could not be verified');
}

export async function relayDisbandStatus(identity: PeerIdentity, relay: RelayPeer): Promise<{disbanded: boolean}> {
  const reply = await friendRequest(identity, relay, relayRequest('disband-status'));
  if (Object.keys(reply).sort().join(',') !== 'disbanded,owner,type' || reply.type !== 'relay-disband-status' || reply.owner !== identity.fingerprint || typeof reply.disbanded !== 'boolean') throw new Error('Group revocation could not be verified');
  return { disbanded: reply.disbanded };
}

export async function relayDisbandGroup(identity: PeerIdentity, relay: RelayPeer): Promise<void> {
  const reply = await friendRequest(identity, relay, relayRequest('disband'));
  if (Object.keys(reply).sort().join(',') !== 'owner,type' || reply.type !== 'relay-disbanded' || reply.owner !== identity.fingerprint || !(await relayDisbandStatus(identity, relay)).disbanded) throw new Error('Group may have been disbanded, but revocation could not be verified. Check status before retrying.');
}

export async function relayLeaveStatus(identity: PeerIdentity, relay: RelayPeer): Promise<{left: boolean}> {
  const reply = await friendRequest(identity, relay, relayRequest('leave-status'));
  if (Object.keys(reply).sort().join(',') !== 'fingerprint,left,type' || reply.type !== 'relay-leave-status' || reply.fingerprint !== identity.fingerprint || typeof reply.left !== 'boolean') throw new Error('Member leave could not be verified');
  return {left: reply.left};
}

export async function relayLeaveGroup(identity: PeerIdentity, relay: RelayPeer): Promise<void> {
  let failure: unknown;
  try {
    const reply = await friendRequest(identity, relay, relayRequest('leave'));
    if (Object.keys(reply).sort().join(',') !== 'fingerprint,type' || reply.type !== 'relay-left' || reply.fingerprint !== identity.fingerprint) throw new Error('Invalid leave acknowledgement');
  } catch (error) { failure = error; }
  // An acknowledgement is not authority. Only this certificate's durable receipt permits local cleanup.
  let status;
  try { status = await relayLeaveStatus(identity, relay); }
  catch (error) { throw new Error('Leave was not verified. Retain the local group and retry on this PC when the relay is online.', {cause: failure ?? error}); }
  if (!status.left) throw failure ?? new Error('Member leave could not be verified; local association retained');
}

export async function relayRemoveFriend(identity: PeerIdentity, relay: RelayPeer, fingerprint: string): Promise<void> {
  if (!hex(fingerprint)) throw new Error('Invalid friend');
  const reply = await friendRequest(identity, relay, { ...relayRequest('remove-friend'), fingerprint });
  if (reply.type !== 'relay-removed' || reply.fingerprint !== fingerprint) throw new Error('Invalid removal reply');
  if ((await relayFriends(identity, relay)).members.some(m => m.fingerprint === fingerprint)) throw new Error('Member removal could not be verified');
}

const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const name = (value: unknown): string | null => typeof value === 'string' ? value.slice(0, 100) : null;

function parseStatus(frame: unknown): RelayStatus | null {
  if (!frame || typeof frame !== 'object') throw new Error('Invalid relay status reply');
  const reply = frame as Record<string, unknown>;
  if (reply.type === 'error') throw new Error(`Relay refused: ${String(reply.message).slice(0, 512)}`);
  if (reply.type !== 'relay-status') throw new Error('Invalid relay status reply');
  if (reply.custody === null) return null;
  const custody = reply.custody as Record<string, unknown>;
  if (!custody || !hex(custody.owner) || !hex(custody.snapshotId) || !['owned', 'offered', 'transferred'].includes(custody.state as string) ||
      !Number.isSafeInteger(custody.generation) || (custody.pendingTarget !== null && !hex(custody.pendingTarget))) {
    throw new Error('Invalid relay status reply');
  }
  return { owner: custody.owner, state: custody.state as RelayCustody['state'], generation: custody.generation as number,
    snapshotId: custody.snapshotId, pendingTarget: custody.pendingTarget as string | null,
    ownerName: name(reply.ownerName), pendingName: name(reply.pendingName), hosting: reply.hosting === true ? true : null,
    pendingStart: typeof reply.pendingStart === 'boolean' ? reply.pendingStart : null,
    // Lenient: a missing or malformed endpoint is simply "not published", never a reply failure.
    holderEndpoint: validHostEndpoint(reply.holderEndpoint) ? reply.holderEndpoint : null };
}

export async function relayWithdrawOffer(identity: PeerIdentity, relay: RelayPeer, offer: import('./ownership.js').TransferOffer) {
  const request = { ...relayRequest('withdraw-offer'), offer };
  const reply = await friendRequest(identity, relay, request);
  const custody = reply.custody as import('./ownership.js').OwnershipState;
  if (Object.keys(reply).sort().join(',') !== 'custody,disposition,offer,type' || reply.type !== 'relay-withdrawal' ||
      !['accepted','withdrawn'].includes(reply.disposition as string) || JSON.stringify(reply.offer) !== JSON.stringify(offer) || !custody ||
      !hex(custody.owner) || !hex(custody.snapshotId) || custody.version !== 1 || custody.lineage !== offer.lineage || !Number.isSafeInteger(custody.generation) ||
      (reply.disposition === 'withdrawn' && (custody.owner !== identity.fingerprint || custody.state !== 'transferred' || custody.generation + 1 !== offer.generation || custody.offer)) ||
      (reply.disposition === 'accepted' && custody.generation < offer.generation)) throw new Error('Exact durable offer withdrawal could not be verified');
  // Read the same durable receipt again: an acknowledgment alone is not evidence of durable state.
  const readback = await friendRequest(identity, relay, request);
  if (JSON.stringify(readback) !== JSON.stringify(reply)) throw new Error('Withdrawal receipt changed; recovery remains blocked');
  return { disposition: reply.disposition as 'accepted' | 'withdrawn', offer, custody };
}

export interface GroupRecoveryRemote {
  custody: import('./ownership.js').OwnershipState;
  observation: ({ owner: string; state: 'starting' | 'hosting' | 'cancelled' | 'stopped' } & import('./recovery-journal.js').HostingRevision) | null;
}
export async function relayRecoveryStatus(identity: PeerIdentity, relay: RelayPeer): Promise<GroupRecoveryRemote> {
  const reply = await friendRequest(identity, relay, relayRequest('recovery-status'));
  const c = reply.custody as GroupRecoveryRemote['custody'];
  const o = reply.observation as GroupRecoveryRemote['observation'];
  if (Object.keys(reply).sort().join(',') !== 'custody,observation,type' || reply.type !== 'relay-recovery-status' ||
      !c || c.version !== 1 || c.owner !== identity.fingerprint || c.state !== 'transferred' || c.offer ||
      !Number.isSafeInteger(c.generation) || c.generation < 1 || !hex(c.snapshotId) || typeof c.lineage !== 'string' || !c.lineage) throw new Error('Invalid exact recovery custody');
  if (o !== null && (!o || o.owner !== identity.fingerprint || o.generation !== c.generation || o.snapshotId !== c.snapshotId || o.lineage !== c.lineage ||
      typeof o.reservation !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(o.reservation) ||
      !['starting', 'hosting', 'cancelled', 'stopped'].includes(o.state))) throw new Error('Invalid exact recovery reservation');
  return { custody: c, observation: o };
}

export async function relayHostState(identity: PeerIdentity, relay: RelayPeer, op: 'host-start' | 'host-running' | 'host-cancel' | 'host-stopped', revision: { generation: number; snapshotId: string; lineage: string; reservation: string }): Promise<void> {
  const reply = await friendRequest(identity, relay, { ...relayRequest(op), ...revision });
  if (Object.keys(reply).sort().join(',') !== 'type' || reply.type !== 'relay-host-accepted') throw new Error('Group hosting admission could not be verified; do not retry an uncertain launch automatically');
}

export interface RelayHostSession {
  close(): void;
  /** Publish (or clear, with null) the verified join address on the retained session socket. Transport errors surface to the caller only. */
  sendEndpoint(endpoint: HostEndpoint | null): Promise<void>;
}
/** Keep authenticated liveness separate from durable custody; a disconnect never releases the world. */
export async function openRelayHostSession(identity: PeerIdentity, relay: RelayPeer, revision: { generation: number; snapshotId: string; lineage: string; reservation: string }): Promise<RelayHostSession> {
  const socket = await connectPeer(identity, relay.fingerprint, relay.host, relay.port);
  try {
    await writeFrame(socket, { ...relayRequest('host-running'), ...revision });
    const reply = await readFrame(socket) as Record<string, unknown>;
    if (reply?.type === 'error') throw new Error(`Relay refused: ${String(reply.message).slice(0, 512)}`);
    if (!reply || Object.keys(reply).join(',') !== 'type' || reply.type !== 'relay-host-accepted') throw new Error('Group host session could not be verified');
    socket.on('error', () => {});
    return {
      close: () => socket.destroy(),
      sendEndpoint: async (endpoint) => {
        if (endpoint !== null && !validHostEndpoint(endpoint)) throw new Error('Invalid join address: expected a verified hostname or null');
        await writeFrame(socket, endpoint === null
          ? { type: 'host-endpoint', address: null, verifiedAt: null }
          : { type: 'host-endpoint', address: endpoint.address, verifiedAt: endpoint.verifiedAt });
      },
    };
  } catch (error) { socket.destroy(); throw error; }
}

/** A member's Start may request ONLY the enrolled owner's bound, safely stopped initial revision. */
export async function relayInitialPublish(identity: PeerIdentity, relay: RelayPeer): Promise<void> {
  // This reply includes snapshot creation and local park, not just a control lookup.
  // Give stopped large worlds up to two minutes (the transport's maximum), without
  // extending status/admission deadlines. Expiry closes only this request socket;
  // it does not cancel publication or authorize a claim/launch on uncertain state.
  const reply = await friendRequest(identity, relay, relayRequest('initial-publish'), 120000);
  if (Object.keys(reply).sort().join(',') !== 'type' || reply.type !== 'relay-initial-published') throw new Error('Initial publication could not be verified');
}

/** Ask the relay what it holds. Read-only; also serves as the reachability check before any offer is prepared. */
export async function relayStatus(identity: PeerIdentity, relay: RelayPeer): Promise<RelayStatus | null> {
  const socket = await connectPeer(identity, relay.fingerprint, relay.host, relay.port);
  try {
    await writeFrame(socket, relayRequest('status'));
    return parseStatus(await readFrame(socket));
  } finally { socket.destroy(); }
}

/** Open a pinned relay connection that has already selected an operation. */
export async function openRelayOperation(identity: PeerIdentity, relay: TransferPeer, op: 'park' | 'claim'): Promise<TLSSocket> {
  const socket = await connectPeer(identity, relay.fingerprint, relay.host, relay.port);
  try { await writeFrame(socket, relayRequest(op)); return socket; }
  catch (error) { socket.destroy(); throw error; }
}

export interface RelayPublicStatus { state: string; address: string | null; detail: string; approveUrl: string | null }
const PUBLIC_STATES = new Set(['off', 'unsupported', 'downloading', 'approve', 'starting', 'creating', 'pending', 'reserved', 'reachable', 'error']);
/** The always-on PC's public address, controlled from a member PC. Reply fields are validated, never trusted. */
export async function relayPublic(identity: PeerIdentity, relay: RelayPeer, op: 'public-status' | 'public-enable' | 'public-disable'): Promise<RelayPublicStatus> {
  const reply = await friendRequest(identity, relay, relayRequest(op));
  if (reply.type !== 'relay-public' || !PUBLIC_STATES.has(reply.state as string) || typeof reply.detail !== 'string') throw new Error('Invalid public address reply');
  const address = typeof reply.address === 'string' && /^[a-z0-9][a-z0-9-]{0,62}\.(?:tun\.ply\.gg|joinmc\.link)$/.test(reply.address) ? reply.address : null;
  const approveUrl = typeof reply.approveUrl === 'string' && /^https:\/\/playit\.gg\/claim\/[a-f0-9]{10}$/.test(reply.approveUrl) ? reply.approveUrl : null;
  return { state: reply.state as string, address, detail: reply.detail.slice(0, 300), approveUrl };
}
