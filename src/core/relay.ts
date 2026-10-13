import { createHash, createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { createIdentity, isVerifiedPeerSocket, listenPeer, readInviteFrame, writeInviteFrame, writeFrame, type PeerIdentity } from './peer-transport.js';
import { OwnershipLedger, canAcceptOffer } from './ownership.js';
import { receiveSnapshot, sendSnapshot } from './transfers.js';
import { pruneStore, syncDirectory } from './snapshots.js';
import { RELAY_PROTOCOL_VERSION, validHostEndpoint, type HostEndpoint, type RelayCustody } from './relay-client.js';
import { encodeInvite, type CreatedInvite } from './invites.js';
import { RelayGameGateway, type GameRoute, type GameGatewayOptions } from './game-gateway.js';
import type { PublicAddress } from './public-address.js';
import { durableJSON, fingerprintOK, friendName, validateServerMetadata, readRelayConfig, validAdvertise, withRelayLock,
  type FriendMember, type PendingInvite, type RelayConfig } from './relay-friends-store.js';

export interface RelayOptions {
  name?: string;
  /** Received revisions to keep (the held revision is always kept). Default 10. */
  keepRevisions?: number;
  log?: (line: string) => void;
}


const DEFAULT_PORT = 47625;
const REQUEST_TIMEOUT_MS = 5000;

// Older configs lack provenance: preserve their non-loopback routes as explicit advertisements.
type RelayNodeConfig = RelayConfig & { advertiseSource?: 'explicit' | 'inferred' };

/**
 * An always-on custodian for one server lineage. Hosts park the server here (a normal handoff with the relay as
 * the target), and any trusted host can later claim it (a normal handoff from the relay), so the PCs that run the
 * server never need to be online at the same time. The relay never runs Minecraft and never materializes a world.
 */
export class RelayNode {
  private config: RelayNodeConfig = { version: 1, trusted: [], history: [] };
  private listener?: { host: string; port: number; close: () => Promise<void> };
  /** Park and claim run one at a time, in arrival order. Status reads never wait. */
  private queue: Promise<void> = Promise.resolve();
  private game?: RelayGameGateway;
  /** Optional one-click public address for this relay's player gateway; any member can turn it on. */
  publicAddress?: PublicAddress;
  /** Running same-PC owner application binding only; no file paths or remote commands on the wire. */
  publishStoppedInitial?: (group: string, owner: string) => Promise<void>;
  private initialPublication?: Promise<void>;
  private hostSessions = new Map<string, { socket: TLSSocket; generation: number; snapshotId: string; endpoint: HostEndpoint | null }>();
  private readonly keepRevisions: number;
  private readonly log: (line: string) => void;
  private readonly defaultName: string;

  constructor(readonly root: string, readonly identity: PeerIdentity, options: RelayOptions = {}) {
    this.keepRevisions = options.keepRevisions ?? 10;
    if (!Number.isInteger(this.keepRevisions) || this.keepRevisions < 1) throw new RangeError('keepRevisions must be a positive integer');
    this.log = options.log ?? ((line) => console.log(line));
    this.defaultName = friendName(options.name ?? 'SeedHost relay', 100);
    if (Buffer.byteLength(this.defaultName) > 100) throw new Error('Relay name must fit in 100 UTF-8 bytes');
  }

  get endpoint(): { host: string; port: number } | undefined {
    return this.listener && { host: this.listener.host, port: this.listener.port };
  }
  get owner(): string | undefined { return this.config.owner; }
  get trusted(): FriendMember[] { return this.config.trusted.map((host) => ({ ...host })); }
  get gameEndpoint(): { host: string; port: number } | undefined { return this.game?.endpoint; }

  /** Explicit opt-in; the player listener is independent of the TLS custody listener. */
  async listenGame(options: GameGatewayOptions = {}): Promise<void> {
    if (this.game) throw new Error('Player gateway is already listening');
    const game = new RelayGameGateway(() => this.gameRoute());
    await game.listen(options);
    this.game = game;
  }

  private async gameRoute(): Promise<GameRoute | null> {
    await this.reload();
    let state;
    try { state = await this.ledger().status(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (state.version !== 1 || state.state !== 'transferred' || state.offer !== undefined ||
        !fingerprintOK(state.owner) || !fingerprintOK(state.snapshotId) || !Number.isSafeInteger(state.generation) || state.generation < 1 ||
        typeof state.lineage !== 'string' || !state.lineage || state.lineage.length > 128 || /[\u0000-\u001f\u007f]/u.test(state.lineage) ||
        !this.config.trusted.some(m => m.fingerprint === state.owner)) return null;
    return { owner: state.owner, generation: state.generation, lineage: state.lineage };
  }
  get name(): string { return this.config.name ?? this.defaultName; }
  private get invites(): string { return path.join(this.root, 'invites'); }
  private get store(): string { return path.join(this.root, 'store'); }
  private ledger(): OwnershipLedger { return new OwnershipLedger(path.join(this.root, 'ownership.sqlite'), this.identity.fingerprint); }

  async open(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.invites, { recursive: true, mode: 0o700 });
    await this.reload();
  }

  async reload(): Promise<void> { this.config = await readRelayConfig(this.root, this.defaultName); }

  /** Reload inside the cross-process lock before every write, including transfer bookkeeping. */
  private mutate<T>(work: (config: RelayNodeConfig) => Promise<T>): Promise<T> {
    return withRelayLock(this.root, async () => {
      const config: RelayNodeConfig = await readRelayConfig(this.root, this.defaultName);
      const result = await work(config);
      config.redeemed = Object.fromEntries(Object.entries(config.redeemed ?? {}).filter(([, receipt]) => receipt.expiresAt > Date.now()));
      await durableJSON(path.join(this.root, 'relay.json'), config);
      this.config = config;
      return result;
    });
  }

  private requireMember(source: string, config = this.config): void {
    if (config.disbandedBy || !config.trusted.some((member) => member.fingerprint === source)) throw new Error('Invite required; untrusted device refused');
  }

  /** Durable admission is consequential work, even when its acknowledgment/session was lost.
   * Read only while holding withRelayLock; never expire or infer cancellation from a disconnect. */
  private async hostObservation(): Promise<{ owner: string; generation: number; snapshotId: string; lineage: string; state: string; reservation?: string } | null> {
    let observation;
    try { observation = JSON.parse(await readFile(path.join(this.root, 'host-observation.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!observation || typeof observation !== 'object' || Array.isArray(observation) ||
        !['generation,lineage,owner,reservation,snapshotId,state', 'generation,lineage,owner,snapshotId,state'].includes(Object.keys(observation).sort().join(',')) ||
        !fingerprintOK(observation.owner) || !fingerprintOK(observation.snapshotId) || !Number.isSafeInteger(observation.generation) || observation.generation < 1 ||
        typeof observation.lineage !== 'string' || observation.lineage.length < 1 || observation.lineage.length > 512 || /[\x00-\x1f\x7f]/.test(observation.lineage) ||
        ('reservation' in observation && (typeof observation.reservation !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(observation.reservation))) ||
        !['starting', 'hosting', 'cancelled', 'stopped'].includes(observation.state)) throw new Error('Hosting admission recovery required: invalid durable reservation');
    return observation;
  }

  private async pendingStart(owner?: string): Promise<boolean> {
    const observation = await this.hostObservation();
    return observation?.state === 'starting' && (!owner || observation.owner === owner);
  }

  private async requireNoPendingStart(owner?: string): Promise<void> {
    if (await this.pendingStart(owner)) throw new Error('Hosting start is pending; resolve the exact admitted start before revocation or handoff. Lost acknowledgment is unknown, not cancellation.');
  }

  async trust(name: string, fingerprint: string): Promise<void> {
    const memberName = friendName(name, 100);
    if (!fingerprintOK(fingerprint)) throw new Error('Fingerprint must be exactly 64 lowercase SHA256 hex digits');
    if (fingerprint === this.identity.fingerprint) throw new Error('The relay cannot trust its own identity');
    await this.mutate(async (config) => {
      if (config.disbandedBy) throw new Error('This group is permanently disbanded; its identity cannot be reused');
      if (config.trusted.length >= 200 && !config.trusted.some((entry) => entry.fingerprint === fingerprint)) throw new Error('Relay friend limit reached');
      config.trusted = [...config.trusted.filter((host) => host.fingerprint !== fingerprint), { name: memberName, fingerprint }];
      config.leftMembers = (config.leftMembers ?? []).filter(id => id !== fingerprint);
    });
  }

  /** Local administration only; the wire protocol has no appoint-owner operation. */
  async setOwner(fingerprint: string): Promise<void> {
    if (!fingerprintOK(fingerprint)) throw new Error('Invalid owner');
    await this.mutate(async config => { this.requireMember(fingerprint, config); if (config.owner !== fingerprint) delete config.serverMetadata; config.owner = fingerprint; });
  }

  /** Permanent group-wide revocation, serialized with park/claim. Retains every world revision and ledger. */
  async disbandGroup(source: string): Promise<void> {
    const run = this.queue.then(() => this.mutate(async config => {
      this.requireMember(source, config);
      if (config.owner !== source) throw new Error('Only the group owner can disband the group');
      await this.requireNoPendingStart();
      const custody = await this.custody();
      if (custody && (custody.state !== 'transferred' || custody.owner !== source || custody.pendingTarget)) throw new Error('Hand the world back to the group owner and finish every handoff before disbanding');
      config.disbandedBy = source;
      config.trusted = [];
      config.redeemed = {};
      config.memberInvites = false;
      delete config.owner;
    }));
    this.queue = run.catch(() => {});
    await run;
    await this.game?.validate();
  }

  async leaveGroup(source: string): Promise<void> {
    const run = this.queue.then(() => this.mutate(async config => {
      if (config.leftMembers?.includes(source)) return;
      this.requireMember(source, config);
      if (config.owner === source) throw new Error('The group owner cannot leave; hand back the world and disband instead');
      await this.requireNoPendingStart();
      const observation = await this.hostObservation();
      if (observation?.owner === source && observation.state === 'hosting') throw new Error('Stop and publish the world before leaving; hosting is unresolved');
      const custody = await this.custody();
      if (custody && (custody.owner === source || custody.state === 'offered' || custody.pendingTarget)) throw new Error('Stop and publish or hand off the latest world and finish pending handoffs before leaving');
      config.trusted = config.trusted.filter(member => member.fingerprint !== source);
      config.leftMembers = [...(config.leftMembers ?? []), source];
      await this.removeInvites(record => record.issuer === source || record.recipient === source);
    }));
    this.queue = run.catch(() => {});
    await run;
    await this.game?.validate();
  }

  async removeFriend(source: string, fingerprint: string): Promise<void> {
    if (!fingerprintOK(fingerprint)) throw new Error('Invalid friend');
    // Serialize with custody transfers, then recheck authority under the durable configuration lock.
    const run = this.queue.then(() => this.mutate(async config => {
      this.requireMember(source, config);
      if (config.owner !== source) throw new Error('Only the group owner can remove a member');
      if (fingerprint === config.owner) throw new Error('The group owner cannot be removed');
      await this.requireNoPendingStart(fingerprint);
      const custody = await this.custody();
      if (custody?.owner === fingerprint || custody?.pendingTarget === fingerprint) throw new Error('Ask this friend to hand the world back before removing them');
      if (!config.trusted.some(m => m.fingerprint === fingerprint)) return;
      config.trusted = config.trusted.filter(m => m.fingerprint !== fingerprint);
      await this.removeInvites(record => record.issuer === fingerprint || record.recipient === fingerprint);
    }));
    this.queue = run.catch(() => {});
    await run;
    await this.game?.validate();
    this.log('Group member removed by the group owner.');
  }

  async untrust(fingerprint: string): Promise<void> {
    if (!fingerprintOK(fingerprint)) throw new Error('Invalid fingerprint');
    // Serialize with in-process park/claim work, then hold the cross-process configuration lock for the whole
    // check + removal (a serving relay in another process — app vs CLI — has its own queue): a relay must never
    // commit a park or claim decision between the check and the removal. A handoff to this device that is still
    // pending refuses to be cut mid-flight; revoking a settled holder proceeds and disconnects their access.
    const run = this.queue.then(() => withRelayLock(this.root, async () => {
      const config = await readRelayConfig(this.root, this.defaultName);
      if (!config.trusted.some((host) => host.fingerprint === fingerprint)) throw new Error('Not a trusted relay friend');
      const name = config.trusted.find((host) => host.fingerprint === fingerprint)?.name ?? 'a friend';
      await this.requireNoPendingStart(fingerprint);
      const custody = await this.custody();
      if (custody?.pendingTarget === fingerprint) {
        throw new Error('This friend has a handoff pending; finish or decline that handoff before removing them');
      }
      config.trusted = config.trusted.filter((host) => host.fingerprint !== fingerprint);
      if (config.owner === fingerprint) delete config.owner;
      // Keep used-token tombstones: removing a friend must not revive a consumed token after a crash.
      await this.removeInvites((record) => record.issuer === fingerprint || record.recipient === fingerprint);
      config.redeemed = Object.fromEntries(Object.entries(config.redeemed ?? {}).filter(([, receipt]) => receipt.expiresAt > Date.now()));
      await durableJSON(path.join(this.root, 'relay.json'), config);
      this.config = config;
      this.log('Locally removed ' + name + ' from this group.');
    }));
    this.queue = run.catch(() => {});
    await run;
    await this.game?.validate();
  }

  async setMemberInvites(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('Member invites must be true or false');
    await this.mutate(async (config) => {
      if (!enabled) await this.removeInvites((record) => record.issuer !== null);
      config.memberInvites = enabled;
    });
  }

  async setName(name: string): Promise<void> {
    const relayName = friendName(name, 100);
    if (Buffer.byteLength(relayName) > 100) throw new Error('Relay name must fit in 100 UTF-8 bytes');
    await this.mutate(async (config) => { config.name = relayName; });
  }

  /** Local operator configuration only; this is not exposed through the relay protocol. */
  async setAdvertisedControlRoute(endpoint: { host: string; port: number }): Promise<void> {
    if (!validAdvertise(endpoint)) throw new Error('Invalid advertised control route');
    await this.mutate(async config => { config.advertise = { ...endpoint }; config.advertiseSource = 'explicit'; });
    await this.reload();
  }

  /** `token` lets a short pairing code stand in for the long invitation: both sides derive the same 16 bytes.
   * `minutes` gives a short-lived code (5–1440); otherwise `hours` (1–720) applies. */
  async createInvite({ hours = 24, minutes, advertise, token, recipient, persistAdvertise = true }: { hours?: number; minutes?: number; advertise?: { host: string; port: number }; token?: Buffer; recipient?: string; persistAdvertise?: boolean } = {}): Promise<CreatedInvite> {
    if (typeof persistAdvertise !== 'boolean') throw new Error('Persist advertised address must be true or false');
    if (recipient !== undefined && !fingerprintOK(recipient)) throw new Error('Invalid invite recipient');
    if (token !== undefined && (!Buffer.isBuffer(token) || token.length !== 16)) throw new Error('Invite token must be 16 bytes');
    if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440)) throw new Error('Invite minutes must be between 5 and 1440');
    if (minutes === undefined && (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30)) throw new Error('Invite hours must be between 1 and 720');
    return this.issueInvite(minutes !== undefined ? minutes / 60 : hours, advertise, null, token, recipient, persistAdvertise);
  }

  private issueInvite(hours: number, advertise: { host: string; port: number } | undefined, issuer: string | null, fixedToken?: Buffer, recipient?: string, persistAdvertise = true): Promise<CreatedInvite> {
    if (!Number.isFinite(hours) || hours < 5 / 60 || hours > 24 * 30) return Promise.reject(new Error('Invite hours must be between 1 and 720'));
    return this.mutate(async (config) => {
      if (config.disbandedBy) throw new Error('This group is permanently disbanded');
      if (issuer !== null) {
        this.requireMember(issuer, config);
        if (!config.memberInvites && config.owner !== issuer) throw new Error('Only the relay owner can create invites');
        if (recipient !== undefined && (!fingerprintOK(recipient) || config.owner !== issuer)) throw new Error('Only the group owner can invite by username');
      }
      const endpoint = advertise ?? config.advertise ?? this.endpoint;
      if (!validAdvertise(endpoint)) throw new Error('Invite needs a reachable advertised relay address and port (not a wildcard bind address)');
      const token = fixedToken ? Buffer.from(fixedToken) : randomBytes(16);
      const expiresAt = Math.floor(Date.now() / 1000 + hours * 3600) * 1000;
      const code = encodeInvite({ relayFingerprint: this.identity.fingerprint, ...endpoint, token, expiresAt: expiresAt / 1000, relayName: config.name ?? this.defaultName });
      if (advertise && persistAdvertise) {
        config.advertise = { ...advertise };
        config.advertiseSource = 'explicit';
      }
      const files = await readdir(this.invites);
      for (const file of files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file))) {
        const record = await this.readInvite(file);
        if (record && record.expiresAt <= Date.now()) await rm(path.join(this.invites, file), { force: true });
      }
      if ((await readdir(this.invites)).filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).length >= 100) throw new Error('Too many pending relay invites');
      await durableJSON(path.join(this.invites, this.tokenHash(token) + '.json'), { version: 1, expiresAt, issuer, ...(recipient ? { recipient } : {}) } satisfies PendingInvite);
      return { code, expiresAt };
    });
  }

  private tokenHash(token: Buffer): string { return createHash('sha256').update(token).digest('hex'); }

  private async removeInvites(matches: (record: PendingInvite) => boolean): Promise<void> {
    for (const file of (await readdir(this.invites)).filter((file) => /^[a-f0-9]{64}\.json$/.test(file))) {
      const record = await this.readInvite(file);
      if (record && matches(record)) await rm(path.join(this.invites, file), { force: true });
    }
    await syncDirectory(this.invites);
  }

  private async readInvite(file: string): Promise<PendingInvite | null> {
    let record: PendingInvite;
    try { record = JSON.parse(await readFile(path.join(this.invites, file), 'utf8')) as PendingInvite; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (record?.version !== 1 || !Number.isSafeInteger(record.expiresAt) || (record.issuer !== null && !fingerprintOK(record.issuer)) || (record.recipient !== undefined && !fingerprintOK(record.recipient))) throw new Error('Invalid pending invite record');
    return record;
  }

  private async hasPendingInvite(): Promise<boolean> {
    for (const file of (await readdir(this.invites)).filter((file) => /^[a-f0-9]{64}\.json$/.test(file))) {
      const record = await this.readInvite(file);
      if (record && record.expiresAt > Date.now() && (record.issuer === null ||
          ((this.config.memberInvites || this.config.owner === record.issuer) && this.config.trusted.some((entry) => entry.fingerprint === record.issuer)))) return true;
    }
    return false;
  }

  private async redeemInvite(token: unknown, name: unknown, source: string): Promise<void> {
    const memberName = friendName(name);
    if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) throw new Error('Invite is not valid');
    if (source === this.identity.fingerprint) throw new Error('Cannot join your own relay');
    const hash = this.tokenHash(Buffer.from(token, 'hex'));
    await this.mutate(async (config) => {
      if (config.disbandedBy) throw new Error('Invite has been revoked: group disbanded');
      const receipt = config.redeemed?.[hash];
      if (receipt) {
        if (receipt.expiresAt <= Date.now()) throw new Error('Invite has expired');
        if (receipt.fingerprint !== source) throw new Error('Invite already used');
        this.requireMember(source, config);
        return;
      }
      const record = await this.readInvite(hash + '.json');
      if (!record) throw new Error('Invite already used or not valid');
      if (record.expiresAt <= Date.now()) throw new Error('Invite has expired');
      if (record.recipient && record.recipient !== source) throw new Error('Only the intended friend can accept this invitation');
      if (record.issuer !== null && ((!config.memberInvites && config.owner !== record.issuer) || !config.trusted.some((entry) => entry.fingerprint === record.issuer))) throw new Error('Invite has been revoked');
      if (config.trusted.length >= 200 && !config.trusted.some((entry) => entry.fingerprint === source)) throw new Error('Relay friend limit reached');
      config.trusted = [...config.trusted.filter((host) => host.fingerprint !== source), { name: memberName, fingerprint: source }];
      config.leftMembers = (config.leftMembers ?? []).filter(id => id !== source);
      config.redeemed = { ...config.redeemed, [hash]: { fingerprint: source, expiresAt: record.expiresAt } };
    });
    // Receipt + membership were committed atomically before deletion; a crash here is still single-use.
    await rm(path.join(this.invites, hash + '.json'), { force: true });
    await syncDirectory(this.invites);
  }

  /** Loopback by default. Binding a LAN address is an explicit choice of the person running the relay. */
  async listen({ host = '127.0.0.1', port = 0, advertise, advertiseHost }: { host?: string; port?: number; advertise?: { host: string; port: number }; advertiseHost?: string } = {}): Promise<void> {
    if (this.listener) throw new Error('Relay is already listening');
    if (advertise !== undefined && !validAdvertise(advertise)) throw new Error('Invalid advertised relay address');
    if (advertiseHost !== undefined && !validAdvertise({ host: advertiseHost, port: 1 })) throw new Error('Invalid fallback relay address');
    this.listener = await listenPeer(this.identity, [],
      (socket, source) => { void this.handle(socket, source); }, { host, port, authorizeCertificate: async (source) => {
        await this.reload();
        if (this.config.disbandedBy) return this.config.disbandedBy === source ? 'trusted' : false;
        if (this.config.trusted.some((entry) => entry.fingerprint === source) || this.config.leftMembers?.includes(source)) return 'trusted';
        // Retained unexpired receipts allow a bounded bootstrap socket to return an
        // explicit used-token refusal. This never grants membership: handle() still
        // restricts bootstrap sockets to join, and redeemInvite binds receipt reuse
        // to the original certificate. Expired receipts do not reopen admission.
        const hasReceipt = Object.values(this.config.redeemed ?? {}).some(receipt => receipt.expiresAt > Date.now());
        return await this.hasPendingInvite() || hasReceipt ? 'invite' : false;
      } });
    try {
      await this.mutate(async (config) => {
        if (advertise) { config.advertise = { ...advertise }; config.advertiseSource = 'explicit'; }
        // Only inferred endpoints follow the bind port; never rewrite deliberate public/proxy routes.
        else if (config.advertise && (config.advertiseSource === 'explicit' ||
          (config.advertiseSource === undefined && config.advertise.host !== 'localhost' && !/^127\./.test(config.advertise.host)))) { /* keep configured route */ }
        else if (advertiseHost) {
          config.advertise = { host: advertiseHost, port: this.listener!.port };
          config.advertiseSource = 'inferred';
        } else if (validAdvertise(this.endpoint)) {
          config.advertise = this.endpoint;
          config.advertiseSource = 'inferred';
        } else {
          delete config.advertise; // Never retain a stale inferred endpoint behind a wildcard bind.
          delete config.advertiseSource;
        }
      });
    } catch (error) { await this.close(); throw error; }
  }

  /** Resolves once every queued park/claim has finished (its post-acknowledgment ledger update included). */
  async settled(): Promise<void> { await this.queue; }

  async custody(): Promise<RelayCustody | null> {
    let state;
    try { state = await this.ledger().status(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (state.state === 'hosting' || state.state === 'uncertain') throw new Error(`Relay ledger is in an impossible state (${state.state})`);
    return { owner: state.owner, state: state.state, generation: state.generation, snapshotId: state.snapshotId,
      pendingTarget: state.state === 'offered' ? state.offer!.target : null };
  }

  private nameOf(fingerprint: string | null): string | null {
    if (fingerprint === null) return null;
    if (fingerprint === this.identity.fingerprint) return 'the relay';
    return this.config.trusted.find((host) => host.fingerprint === fingerprint)?.name ?? 'an untrusted device';
  }

  /** Incremental length-prefixed (4-byte BE, 1..4096) frame reader for the retained host telemetry socket. */
  private attachHostEndpointParser(session: { socket: TLSSocket; endpoint: HostEndpoint | null }, owner: string): void {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    session.socket.on('data', (chunk: Buffer) => {
      if (session.socket.destroyed) return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      if (buffer.length > 65536) { session.socket.destroy(); return; }
      let offset = 0;
      while (buffer.length - offset >= 4) {
        const length = buffer.readUInt32BE(offset);
        if (length < 1 || length > 4096) { session.socket.destroy(); return; }
        if (buffer.length - offset < 4 + length) break;
        this.acceptHostEndpointFrame(session, owner, buffer.subarray(offset + 4, offset + 4 + length));
        offset += 4 + length;
      }
      if (offset > 0) buffer = buffer.subarray(offset);
    });
  }

  /** Accepts ONLY the exact three-key host-endpoint frame from the authenticated holder; anything else is ignored. */
  private acceptHostEndpointFrame(session: { endpoint: HostEndpoint | null }, who: string, body: Buffer): void {
    let frame: unknown;
    try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
    catch { this.log(`Relay ${who}: ignored malformed join-address frame.`); return; }
    const record = frame as Record<string, unknown>;
    if (!record || typeof frame !== 'object' || Array.isArray(frame) ||
        Object.keys(record).sort().join(',') !== 'address,type,verifiedAt' || record.type !== 'host-endpoint') {
      this.log(`Relay ${who}: ignored malformed join-address frame.`); return;
    }
    if (record.address === null && record.verifiedAt === null) { session.endpoint = null; return; }
    if (!validHostEndpoint(record)) { this.log(`Relay ${who}: ignored malformed join-address frame.`); return; }
    session.endpoint = { address: record.address, verifiedAt: record.verifiedAt };
  }

  private async handle(socket: TLSSocket, source: string): Promise<void> {
    const who = this.nameOf(source)!;
    let retained = false;
    try {
      const request = await readInviteFrame(socket, 4096, REQUEST_TIMEOUT_MS) as Record<string, unknown>;
      if (!request || request.type !== 'relay' || request.version !== RELAY_PROTOCOL_VERSION || !['withdraw-offer', 'recovery-status', 'status', 'park', 'claim', 'join', 'invite', 'friends', 'gateway-status', 'game-tunnel', 'public-status', 'public-enable', 'public-disable', 'remove-friend', 'invite-for', 'disband', 'disband-status', 'leave', 'leave-status', 'initial-publish', 'host-start', 'host-running', 'host-cancel', 'host-stopped', 'server-metadata'].includes(request.op as string) ||
          Object.keys(request).length !== (['host-start', 'host-running', 'host-cancel', 'host-stopped'].includes(request.op as string) ? 7 : request.op === 'join' || request.op === 'game-tunnel' ? 5 : request.op === 'withdraw-offer' || request.op === 'remove-friend' || request.op === 'invite-for' || request.op === 'server-metadata' ? 4 : 3)) {
        throw new Error('Unsupported relay request; both ends must run the same SeedHost alpha');
      }
      if (request.op === 'join') {
        await this.redeemInvite(request.token, request.name, source);
        await writeInviteFrame(socket, { type: 'relay-joined', relayName: this.name });
        return;
      }
      // Bootstrap sockets stay bootstrap-only even after another connection joins the same certificate.
      if (!isVerifiedPeerSocket(socket)) throw new Error('Invite required; untrusted request refused');
      await this.reload();
      if (request.op === 'disband-status') {
        if (this.config.disbandedBy !== source && this.config.owner !== source) throw new Error('Only the group owner can inspect disband status');
        await writeFrame(socket, { type: 'relay-disband-status', disbanded: this.config.disbandedBy === source, owner: source });
        return;
      }
      if (request.op === 'leave-status') {
        if (!this.config.leftMembers?.includes(source)) this.requireMember(source);
        await writeFrame(socket, { type: 'relay-leave-status', fingerprint: source, left: this.config.leftMembers?.includes(source) === true });
        return;
      }
      if (request.op === 'leave') {
        await this.leaveGroup(source);
        await writeFrame(socket, { type: 'relay-left', fingerprint: source });
        return;
      }
      this.requireMember(source);
      if (request.op === 'server-metadata') {
        await this.mutate(async config => {
          this.requireMember(source, config);
          if (config.owner !== source) throw new Error('Only the appointed group owner can set the server name');
          config.serverMetadata = validateServerMetadata(request.metadata, source);
        });
        await writeFrame(socket, { type: 'relay-metadata-saved' });
        return;
      }
      if (request.op === 'withdraw-offer') {
        const result = await withRelayLock(this.root, async () => {
          await this.reload(); this.requireMember(source);
          return this.ledger().withdrawIncoming(request.offer as import('./ownership.js').TransferOffer, source);
        });
        await writeFrame(socket, {type:'relay-withdrawal', offer:request.offer, ...result});
        return;
      }
      if (request.op === 'recovery-status') {
        const recovered = await withRelayLock(this.root, async () => {
          await this.reload(); this.requireMember(source);
          const custody = await this.ledger().status();
          if (custody.state !== 'transferred' || custody.owner !== source) throw new Error('Only the exact current holder can inspect recovery status');
          const observation = await this.hostObservation();
          if (observation && (observation.owner !== source || observation.generation !== custody.generation || observation.snapshotId !== custody.snapshotId || observation.lineage !== custody.lineage)) throw new Error('Recovery observation does not match exact custody');
          return { custody, observation };
        });
        await writeFrame(socket, { type: 'relay-recovery-status', ...recovered });
        return;
      }
      if (['host-start', 'host-running', 'host-cancel', 'host-stopped'].includes(request.op as string)) {
        const run = this.queue.then(() => withRelayLock(this.root, async () => {
          await this.reload(); this.requireMember(source);
          const custody = await this.ledger().status();
          if (custody.state !== 'transferred' || custody.owner !== source || custody.generation !== request.generation || custody.snapshotId !== request.snapshotId || custody.lineage !== request.lineage) throw new Error('Hosting refused: exact latest checked-out lineage is not held by this device');
          if (typeof request.reservation !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.reservation)) throw new Error('Invalid hosting reservation');
          const observation = await this.hostObservation();
          const exact = observation?.owner === source && observation.generation === custody.generation && observation.snapshotId === custody.snapshotId && observation.lineage === custody.lineage && observation.reservation === request.reservation;
          if (request.op === 'host-start') {
            await this.requireNoPendingStart();
            if (observation?.state === 'hosting' && observation.owner === source && observation.generation === custody.generation) throw new Error('Hosting is unresolved; stop the previous process before starting again');
          } else {
            if (!exact) throw new Error('Hosting reservation mismatch; explicit recovery required');
            const allowed = request.op === 'host-running' ? ['starting', 'hosting'] : request.op === 'host-cancel' ? ['starting', 'cancelled'] : ['starting', 'hosting', 'stopped'];
            if (!allowed.includes(observation!.state)) throw new Error('Hosting reservation cannot be resolved from this state');
          }
          const state = request.op === 'host-start' ? 'starting' : request.op === 'host-running' ? 'hosting' : request.op === 'host-cancel' ? 'cancelled' : 'stopped';
          await durableJSON(path.join(this.root, 'host-observation.json'), { owner: source, generation: custody.generation, snapshotId: custody.snapshotId, lineage: custody.lineage, reservation: request.reservation, state });
        }));
        this.queue = run.catch(() => {});
        await run;
        if (request.op === 'host-running') {
          this.hostSessions.get(source)?.socket.destroy();
          const session = { socket, generation: request.generation as number, snapshotId: request.snapshotId as string, endpoint: null as HostEndpoint | null };
          this.hostSessions.set(source, session);
          const clear = () => { if (this.hostSessions.get(source) === session) this.hostSessions.delete(source); };
          socket.once('close', clear); socket.once('end', clear); socket.on('error', clear);
          // Incremental telemetry reader on the retained socket: idle sessions have no finite deadline, so the
          // request/readFrame loop (which validates a finite deadline <= 120 s) must never be used here.
          this.attachHostEndpointParser(session, source);
          retained = true;
        }
        await writeFrame(socket, { type: 'relay-host-accepted' });
        return;
      }
      if (request.op === 'initial-publish') {
        const owner = await withRelayLock(this.root, async () => {
          await this.reload(); this.requireMember(source);
          if (await this.custody()) return null;
          if (!this.config.owner || !this.publishStoppedInitial) throw new Error('The group owner application is offline or not bound here; initial hosting status is unknown');
          return this.config.owner;
        });
        // Never hold the relay queue/lock across the callback: it parks through this same TLS listener.
        if (owner) {
          if (!this.initialPublication) {
            const publication = this.publishStoppedInitial!(this.identity.fingerprint, owner);
            this.initialPublication = publication;
            void publication.finally(() => { if (this.initialPublication === publication) this.initialPublication = undefined; }).catch(() => {});
          }
          await this.initialPublication;
        }
        await withRelayLock(this.root, async () => {
          await this.reload(); this.requireMember(source);
          if (!(await this.custody())) throw new Error('No durable stopped revision was published');
        });
        await writeFrame(socket, { type: 'relay-initial-published' });
        return;
      }
      if (request.op === 'disband') {
        await this.disbandGroup(source);
        await writeFrame(socket, { type: 'relay-disbanded', owner: source });
        return;
      }
      if (request.op === 'public-status' || request.op === 'public-enable' || request.op === 'public-disable') {
        const pa = this.publicAddress;
        if (!pa) { await writeFrame(socket, { type: 'relay-public', state: 'unsupported', address: null, detail: 'This always-on PC can’t make a public address. Update Seed Hosting on it.', approveUrl: null }); return; }
        // Serialize provider work with revocation. Recheck at admission, not just at TLS authentication.
        // Disband acknowledges only after already-admitted provider work has settled.
        const run = this.queue.then(async () => {
          await this.reload();
          this.requireMember(source);
          if (request.op !== 'public-status' && !this.game) throw new Error('Turn on the player address on the always-on PC first');
          return request.op === 'public-enable' ? pa.enable() : request.op === 'public-disable' ? pa.disable() : pa.refresh();
        });
        this.queue = run.then(() => undefined, () => undefined);
        const status = await run;
        if (request.op !== 'public-status') this.log(`Public address ${request.op === 'public-enable' ? 'turned on' : 'turned off'} by ${who}.`);
        await writeFrame(socket, { type: 'relay-public', ...status });
        return;
      }
      if (request.op === 'gateway-status') {
        await writeFrame(socket, { type: 'relay-gateway-status', ...(this.game ? await this.game.status() : { enabled: false, host: null, port: null, ready: false, detail: 'Player gateway is off' }) });
        return;
      }
      if (request.op === 'game-tunnel') {
        if (!this.game) throw new Error('Player gateway is off');
        await this.game.register(socket, source, request.generation, request.lineage);
        retained = true;
        return;
      }
      if (request.op === 'invite-for') {
        const invite = await this.issueInvite(24, undefined, source, undefined, request.fingerprint as string);
        await writeFrame(socket, { type: 'relay-invite', ...invite });
        return;
      }
      if (request.op === 'invite') {
        const invite = await this.issueInvite(24, undefined, source);
        await writeFrame(socket, { type: 'relay-invite', ...invite });
        return;
      }
      if (request.op === 'remove-friend') {
        await this.removeFriend(source, request.fingerprint as string);
        await writeFrame(socket, { type: 'relay-removed', fingerprint: request.fingerprint });
        return;
      }
      if (request.op === 'friends') {
        const custody = await this.custody();
        await writeFrame(socket, { type: 'relay-friends', canManage: this.config.owner === source, owner: this.config.owner ?? null, members: this.config.trusted.map((member) => ({ ...member, you: member.fingerprint === source })),
          custody: !custody ? 'unknown' : custody.state === 'owned' ? 'parked' : custody.state === 'offered' ? 'pending' : 'held',
          holder: custody?.state === 'transferred' ? this.nameOf(custody.owner) : null,
          ...(this.config.serverMetadata ? { serverMetadata: this.config.serverMetadata } : {}) });
        return;
      }
      if (request.op === 'status') {
        const { custody, pendingStart } = await withRelayLock(this.root, async () => {
          await this.reload(); this.requireMember(source);
          return { custody: await this.custody(), pendingStart: await this.pendingStart() };
        });
        const session = custody ? this.hostSessions.get(custody.owner) : undefined;
        // The SAME predicate gates `hosting` and the published endpoint: a transferred custody with a live,
        // generation/snapshot-matching session from a trusted member.
        const current = custody?.state === 'transferred' && session && !session.socket.destroyed && session.generation === custody.generation && session.snapshotId === custody.snapshotId && this.config.trusted.some(member => member.fingerprint === custody.owner) ? session : null;
        const hosting: true | null = current ? true : null;
        const holderEndpoint = current?.endpoint ? { address: current.endpoint.address, verifiedAt: current.endpoint.verifiedAt } : null;
        await writeFrame(socket, { type: 'relay-status', custody, hosting, pendingStart, holderEndpoint,
          ownerName: this.nameOf(custody?.owner ?? null), pendingName: this.nameOf(custody?.pendingTarget ?? null) });
        socket.end();
        return;
      }
      const run = this.queue.then(async () => {
        await this.reload(); this.requireMember(source);
        return request.op === 'park' ? this.receivePark(socket, source, who) : this.serveClaim(socket, source, who);
      });
      this.queue = run.catch(() => {});
      await run;
    } catch (error) {
      this.log(`Relay ${who}: ${(error as Error).message}`);
      if (!socket.destroyed) await writeInviteFrame(socket, { type: 'error', message: (error as Error).message.slice(0, 512) }).catch(() => {});
    } finally {
      if (!retained) socket.destroy();
    }
  }

  /** A host hands the server to the relay. Conflicting offers are declined, which lets the host keep ownership. */
  private async receivePark(socket: TLSSocket, source: string, who: string): Promise<void> {
    const ledger = this.ledger();
    await receiveSnapshot(socket, source, this.store, async (snapshot, authenticated, offer) => {
      if (!offer) return false;
      // The membership, lineage and custody decision — including whether an already-accepted offer may be
      // re-acknowledged — commits under the cross-process lock shared with revocation
      // (`untrust`, CLI included) and with claim preparation: a device revoked while its park streamed, or a
      // member answering before the owner, can never still receive the group's authority.
      const accepted = await withRelayLock(this.root, async () => {
        await this.reload();
        if (this.config.disbandedBy || !this.config.trusted.some((member) => member.fingerprint === authenticated)) {
          this.log(`Declined park from ${who}: the device is not a trusted member of this group.`);
          return false;
        }
        if (await ledger.hasWithdrawn(offer.id)) return false;
        if (await ledger.hasAccepted(offer.id)) {
          // Re-acknowledge ONLY the exact durable acceptance, verified under this same cross-process lock:
          // the device must still be an authenticated member, and the complete offer metadata (source, target,
          // lineage, generation, snapshot) must match both the stored acceptance and this ledger's lineage.
          // A replayed park never re-applies custody, even after it advanced to another holder. Records
          // accepted before the details table existed fail closed (explicit operator recovery required).
          const detail = await ledger.acceptedOfferDetails(offer.id);
          const verified = detail?.durable && detail.custody.lineage !== undefined && detail.custody.lineage === offer.lineage &&
            detail.custody.generation >= offer.generation &&
            detail.offer.id === offer.id && detail.offer.source === offer.source && detail.offer.target === offer.target &&
            detail.offer.lineage === offer.lineage && detail.offer.generation === offer.generation && detail.offer.snapshotId === offer.snapshotId;
          if (!verified) {
            this.log(`Declined replayed park from ${who}: it does not match the durable acceptance record; explicit operator recovery required.`);
            return false;
          }
          return true;
        }
        await this.requireNoPendingStart();
        if ((await this.hostObservation())?.state === 'hosting') throw new Error('Hosting is unresolved; verified Stop must resolve the exact admission before handoff.');
        let current;
        try { current = await ledger.status(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        // The first world lineage is established by the group owner, never by whichever member answers first;
        // groups created without a configured owner (older installs) keep accepting the first trusted park.
        if (!current && this.config.owner && authenticated !== this.config.owner) {
          this.log(`Declined first park from ${who}: only the group owner establishes the world lineage.`);
          return false;
        }
        if (!canAcceptOffer(current, offer, authenticated, this.identity.fingerprint)) {
          this.log(`Declined park from ${who}: relay holds generation ${current?.generation} (${current?.state}); offer was generation ${offer.generation}.`);
          return false;
        }
        await ledger.acceptTransfer(offer, authenticated, snapshot.id);
        await this.game?.validate();
        return true;
      });
      if (!accepted) return false;
      // Bookkeeping happens before the acknowledgment, so the host's next request never races it.
      // It is best-effort: authority has already committed and must not be reported as failed.
      try {
        const history = await this.mutate(async (config) => {
          config.history = [...config.history.filter((id) => id !== snapshot.id), snapshot.id].slice(-this.keepRevisions);
          return [...config.history];
        });
        const pruned = await pruneStore(this.store, { keep: history });
        this.log(`Parked ${snapshot.id} from ${who}. Pruned ${pruned.snapshotsRemoved} old revision(s).`);
      } catch (error) {
        this.log(`Parked ${snapshot.id} from ${who}, but history cleanup failed: ${(error as Error).message}`);
      }
      return true;
    });
  }

  /** The relay hands the server to a trusted host, or resends a pending claim to the host it is pending for. */
  private async serveClaim(socket: TLSSocket, target: string, who: string): Promise<void> {
    const ledger = this.ledger();
    // The handoff decision commits under the cross-process lock shared with revocation: a claim can never be
    // prepared for a just-revoked member, and no removal can slip between the membership check and the preparation.
    const offer = await withRelayLock(this.root, async () => {
      await this.reload();
      this.requireMember(target);
      await this.requireNoPendingStart();
      const custody = await this.custody();
      if (!custody) throw new Error('The relay holds no server yet. Park one on it first.');
      if (custody.state === 'owned') {
        const prepared = await ledger.prepareTransfer(target, custody.snapshotId);
        await this.game?.validate();
        return prepared;
      }
      if (custody.state === 'offered') {
        if (custody.pendingTarget !== target) {
          const name = this.nameOf(custody.pendingTarget);
          throw new Error(`The server is pending checkout to ${name}; ${name} must retry its claim to finish it.`);
        }
        return (await ledger.status()).offer!;
      }
      if (custody.owner === target) throw new Error('Your device already holds the server; there is nothing to claim.');
      const name = this.nameOf(custody.owner);
      throw new Error(`The server is checked out by ${name} (generation ${custody.generation}). Ask ${name} to park it on the relay.`);
    });
    let result;
    try { result = await sendSnapshot(socket, this.store, offer.snapshotId, offer); }
    catch (error) {
      this.log(`Claim by ${who} did not complete (${(error as Error).message}); it stays pending for ${who} to retry.`);
      throw error;
    }
    if (!result.ownershipAccepted) {
      await ledger.cancelTransfer(offer.id, target);
      this.log(`${who} declined the claim; the relay still holds the server.`);
      return;
    }
    await ledger.confirmTransfer(offer.id, target);
    await this.game?.validate();
    this.log(`Checked the server out to ${who} at generation ${offer.generation}.`);
  }

  async close(): Promise<void> {
    for (const session of this.hostSessions.values()) session.socket.destroy();
    this.hostSessions.clear();
    await this.publicAddress?.close();
    if (this.game) { await this.game.close(); this.game = undefined; }
    if (this.listener) { await this.listener.close(); this.listener = undefined; }
  }
}

/**
 * Headless identity for the relay. There is no desktop keychain on a typical always-on box, so the private key is
 * stored in an owner-only (0600) file. Protect the relay's disk accordingly.
 */
export async function loadOrCreateRelayIdentity(root: string): Promise<PeerIdentity> {
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'identity.json');
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    const cert = new X509Certificate(data.certPem);
    const fingerprint = createHash('sha256').update(cert.raw).digest('hex');
    if (data.version !== 1 || fingerprint !== data.fingerprint || !cert.checkPrivateKey(createPrivateKey(data.keyPem))) {
      throw new Error('Relay identity certificate/key mismatch');
    }
    return { keyPem: data.keyPem, certPem: data.certPem, fingerprint };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const identity = await createIdentity();
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ version: 1, ...identity })); await handle.sync(); } finally { await handle.close(); }
  return identity;
}

export { DEFAULT_PORT as DEFAULT_RELAY_PORT };
