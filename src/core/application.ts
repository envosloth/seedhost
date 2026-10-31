import { mkdir, mkdtemp, readFile, readdir, lstat, realpath, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { defaultSettings, validateSettings, type Settings } from './settings.js';
import { importServer, createSnapshot, materializeSnapshot, readSnapshot, pruneStore, pruneBackupHistory, syncDirectory, type SnapshotManifest } from './snapshots.js';
import { ServerProcess } from './launcher.js';
import { preflightMinecraftPort } from './port-preflight.js';
import { readAdmission, saveAdmission, type AdmissionJournal } from './recovery-journal.js';
import { OwnershipLedger, canAcceptOffer, type TransferOffer } from './ownership.js';
import { receiveSnapshot, requireFreeSpaceFor, sendSnapshotToPeer } from './transfers.js';
import { listenPeer, type PeerIdentity } from './peer-transport.js';
import { addMods, exportClientPack, modsDirectory, ordinaryDirectory, removeMod, type ModKind } from './mods.js';
import { ModrinthClient, assertModTarget, isGameVersion, isModLoader, isProjectKey, type ModSort } from './modrinth.js';
import { indexedMods, modTarget, readModIndex, writeModIndex, type ModVerificationCache } from './mod-index.js';
import { installMod, assertModInstallComplete, type InstallModInput } from './mod-install.js';
import { openRelayOperation, relayRequest, relayStatus, relayInitialPublish, relayHostState, relayWithdrawOffer, relayRecoveryStatus, openRelayHostSession, relayInvite, relayInviteFor, relayRemoveFriend, relayRecoverCheckout, relayFriends, relaySetServerName, relayDisbandGroup, relayDisbandStatus, relayLeaveGroup, joinRelayInvite, validHostEndpoint, type RelayStatus, relayPublic, type RelayHostSession } from './relay-client.js';
import { decodeInvite, type Invite } from './invites.js';
import { friendName, fingerprintOK } from './relay-friends-store.js';
import { initializeOnboardingScope, readOnboarding, saveOnboarding, validateOnboarding, onboardingChecks, type SetupConfiguration } from './onboarding.js';
import { ServerSetupClient, probeJava, type CreateServerInput } from './server-setup.js';
import { validateSimpleProfileInput, validateCustomJavaArgs, withCustomJavaArgs, withoutJvmHeapArgs, type SimpleProfileInput } from './java-arguments.js';
import { findAlwaysOnPC, normalizePairingCode, pairingInvite, type FoundAlwaysOn } from './always-on.js';
import { readGameGateway, saveGameGatewayConfig, validateGameGateway } from './game-gateway-config.js';
import { gatewayStatus, startHostGameGateway } from './game-gateway.js';
import { privateLanAddresses, readServerPort } from './network-info.js';
import { hostname } from 'node:os';
import { listManagedFiles, readManagedText, writeManagedText, resolveServerPath } from './server-files.js';
import { assertServerFileTransactionsComplete } from './server-file-recovery.js';
import { ServerMetrics } from './server-metrics.js';
import { queryLocalMinecraft, type MinecraftStatusResult } from './minecraft-status.js';
import { createSchedule, readScheduleSnapshot, writeSchedules, validateScheduleInput, type ServerSchedule } from './server-scheduler.js';
import { patchServerProperties, readServerProperties, validateServerProperties } from './server-properties.js';
import {
  parseSavedState, validateLaunchProfile, validatePeer, validateRelayConfig, newServerId, isServerId,
  type LaunchProfileInput, type RelayConfig, type SavedPeer, type SavedPendingGroup, type SavedServer, type SavedState,
} from './saved-state.js';

export interface LaunchApproval {
  readonly root: string;
  readonly serverDir: string;
  readonly snapshotId: string;
  readonly profile: { readonly executable: string; readonly args: readonly string[] };
}
export interface CleanUpResult { serverDirsRemoved: number; snapshotsRemoved: number; objectsRemoved: number; bytesFreed: number }
/**
 * The hosting-group context of one library world, for per-server UI/main helpers. `relay.endpoint` is the trusted
 * peer's endpoint; `relay` is null when the world is hosted only by this PC.
 */
export interface ServerGroupInfo {
  serverId: string;
  /** True when this exact world is bound to a hosting group. A pending group is never a property of a world. */
  bound: boolean;
  relay: { fingerprint: string; parkOnStop: boolean; name: string; endpoint: { host: string; port: number } | null } | null;
}
/** Result of accepting an invitation through joinHostingGroup: which local world (if any) the group now belongs to. */
export interface HostingGroupJoinResult { relayName: string; fingerprint: string; serverId: string | null; pending: boolean }
interface ApplicationOptions {
  /** Fail-closed route ownership check, inside the ordinary launch operation lock. */
  beforeServerStart?: (server: { id: string; playerPort: number }) => Promise<void>;
  serverSetup?: ServerSetupClient;
  /** Trusted local embedding seam; never supplied by a peer or exposed as renderer command input. */
  resolveGroupLaunchProfile?: (serverDir: string, localProfile: Readonly<LaunchProfileInput>) => Promise<LaunchProfileInput>;
  /** Optional provider-retirement guard; called under the create operation lock. */
  chooseServerPort?: (id: string, occupied: number[]) => Promise<number>;
  modrinth?: ModrinthClient;
  confirmIncomingHandoff?: (source: string, snapshot: SnapshotManifest, offer: TransferOffer) => Promise<boolean>;
}

/** Revisions kept by cleanup: the current one plus this many ancestors. */
const CLEANUP_ANCESTORS = 2;

export async function groupJavaLaunchArgs(serverDir: string, localArgs: string[] = []): Promise<string[]> {
  const launcher = localArgs.indexOf('-jar');
  if (localArgs.length && launcher < 0) throw new Error('Unsupported local Java launch plan; configure a supported JAR plan for this group');
  const prefix = localArgs.slice(0, Math.max(0, launcher));
  const heap = prefix.filter(arg => /^-Xm[sx]\d+[MG]$/i.test(arg));
  const custom = validateCustomJavaArgs(prefix.filter(arg => !heap.includes(arg)));
  const entries = await readdir(serverDir, { withFileTypes: true });
  if (entries.some(e => e.isFile() && /\.(?:sh|bat|cmd|ps1)$/i.test(e.name))) throw new Error('Group Start does not support a scripted server or launcher argument files; only unambiguous Vanilla/Fabric JAR plans are supported.');
  const candidates = entries.filter(e => e.isFile() && /^(?:server|minecraft_server[._][\w.+-]+|fabric-server-launch)\.jar$/i.test(e.name));
  const allJars = entries.filter(e => e.isFile() && /\.jar$/i.test(e.name));
  const fabric = candidates.find(e => e.name === 'fabric-server-launch.jar');
  const jar = fabric && allJars.every(e => e.name === 'server.jar' || e.name === fabric.name) ? fabric.name : allJars.length === 1 && candidates.length === 1 ? candidates[0]!.name : undefined;
  if (!jar) throw new Error('Group Start requires an unambiguous Vanilla/Fabric server JAR; unsupported layouts cannot use Group Start.');
  return [...heap, ...custom, '-jar', jar, 'nogui'];
}

const isStoppedState = (state: string | undefined) => state === undefined || state === 'offline' || state === 'failed';

/** Only installation strictly before any authority write may produce a definitive decline. */
class IncomingPreAcceptanceDecline extends Error {}

export class SeedHostApplication {
  private opened = false;
  private saved: SavedState = { version: 2, settings: defaultSettings(), servers: [], activeServerId: null, peers: [], pendingGroups: [], activation: null };
  private groupHostSession?: RelayHostSession;
  private groupHostReservation?: AdmissionJournal;
  private gatewayTunnel?: { close: () => Promise<void> };
  private gatewayEpoch = 0;
  private gatewayState: {state: 'off' | 'connecting' | 'ready' | 'error'; detail: string} = { state: 'off', detail: 'No local host tunnel is active' };
  private logs: string[] = [];
  private modVerificationCache: ModVerificationCache = new Map();
  private playerSamples = new Map<string, { identity: string; at: number; pending: Promise<MinecraftStatusResult> }>();
  private busy: string | null = null;
  private operationToken?: symbol;
  private legacyOnboardingScope: { id: string; ledgerKey: string } | null = null;
  private process?: ServerProcess;
  private controlledProcess?: ServerProcess;
  private unexpectedExit?: OwnershipLedger;
  private listener?: { host: string; port: number; close: () => Promise<void> };
  private schedules: ServerSchedule[] = [];
  private scheduleError: string | null = null;
  private scheduleRevision: string | null = null;
  private scheduleTimer?: ReturnType<typeof setInterval>;
  private scheduleTick?: Promise<void>;
  private readonly metrics = new ServerMetrics();

  constructor(readonly root: string, readonly identity: PeerIdentity, private readonly options: ApplicationOptions = {}) {}

  // ---------------------------------------------------------------- state and locking

  async open(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    let text: string | undefined;
    let legacyState = false;
    try { text = await readFile(path.join(this.root, 'state.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (text !== undefined) {
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new Error('Invalid saved application state: state.json is not valid JSON. The file was left unchanged.'); }
      this.saved = parseSavedState(value);
      legacyState = (value as { version: number }).version === 1;
    }
    // Recovery must never abort startup: reconciling is idempotent and the journal is durable, so a ledger that
    // cannot be read right now keeps the journal for a later attempt instead of taking the whole app down.
    // Nothing about ownership is assumed either way.
    if (this.saved.activation) {
      try { await this.reconcileActivation(); }
      catch (error) { this.log('An interrupted claim could not be reconciled yet; the journal is kept for a later attempt. ' + String(error)); }
    }
    this.legacyOnboardingScope = null;
    try {
      const active = this.activeServer();
      const scope = await initializeOnboardingScope(this.root, this.saved.activeServerId, legacyState && active ? this.onboardingLedgerKey(active) : undefined);
      if (scope?.serverId && scope.ledgerKey) this.legacyOnboardingScope = { id: scope.serverId, ledgerKey: scope.ledgerKey };
    }
    catch { this.log('Saved setup progress is unreadable; existing server controls remain available. Original metadata was left unchanged.'); }
    if (this.activeServer()) {
      const ledger = this.ledger();
      // A damaged ledger must never abort startup either: stay readable, keep every journal, and assume nothing.
      const ownership = await ledger.statusOrNull().catch(error => {
        this.log('Ownership record is unreadable; this server stays fenced and nothing is assumed. ' + String(error));
        return undefined;
      });
      if (ownership === undefined) {
        // A pre-journal interrupted claim (state written by an older build) or an externally missing record:
        // keep state readable and leave the ordinary claim retry as the recovery path. Ownership is never assumed.
        this.log('A server entry has no ownership record yet. State stays readable; an ordinary claim retry completes it, and nothing is assumed about ownership.');
      } else if (ownership.state === 'hosting') {
        await ledger.markUncertain();
        this.log('Previous hosting session is uncertain. Confirm that its process stopped before recovery.');
      }
    }
    try { const snapshot = await readScheduleSnapshot(this.root); this.schedules = snapshot.jobs; this.scheduleRevision = snapshot.revision; this.scheduleError = null; }
    catch (error) { this.scheduleError = 'Scheduler disabled: ' + String((error as Error).message).slice(0, 240); this.log(this.scheduleError); }
    if (!this.scheduleTimer && !this.scheduleError) {
      this.scheduleTimer = setInterval(() => { void this.tickServerSchedules().catch(error => this.log('Scheduler: ' + String((error as Error).message))); }, 1000);
      this.scheduleTimer.unref();
    }
    this.opened = true;
  }

  async getState() {
    const id = this.saved.activeServerId ?? 'app';
    let server = null;
    const active = this.activeServer();
    if (active) {
      // A damaged or not-yet-initialized ownership record must never block the whole state read: report it as
      // unknown, which every guarded action already treats as "no local authority on this PC".
      let ownershipError: string | null = null;
      const ownership = await this.ledger().statusOrNull().catch(error => {
        ownershipError = 'Ownership record is unreadable; hosting and transfers stay blocked until it is repaired. ' + String((error as Error).message).slice(0, 240);
        return undefined;
      })
        ?? { version: 1 as const, owner: '', generation: 0, snapshotId: '', state: 'unknown' as const };
      const serverDir = active.serverDir;
      // Optional catalogue state must never block lifecycle/ownership state or graceful shutdown.
      let mods: { server: Awaited<ReturnType<typeof indexedMods>>; client: Awaited<ReturnType<typeof indexedMods>> } = { server: [], client: [] };
      let target: Awaited<ReturnType<typeof modTarget>> = { loader: null, gameVersion: null, detected: true };
      let modsError: string | null = null;
      let modInstallError: string | null = null;
      try { await assertModInstallComplete(serverDir); }
      catch (error) { modInstallError = String((error as Error).message); }
      try {
        if (modInstallError) throw new Error(modInstallError);
        // Empty directories are not represented in snapshots. Restore only when owned.
        if (ownership.state === 'owned' && ownership.owner === this.identity.fingerprint && !this.process?.pid && !this.busy) await ordinaryDirectory(modsDirectory(serverDir, 'server'), true);
        const index = await readModIndex(serverDir);
        mods = { server: await indexedMods(serverDir, 'server', index, this.modVerificationCache), client: await indexedMods(serverDir, 'client', index, this.modVerificationCache) };
        target = await modTarget(serverDir, index);
      } catch (error) {
        modsError = `Mod information unavailable; repair the managed mod index/folders before changing mods. ${String((error as Error).message).slice(0, 240)}`;
      }
      server = { ...active, profile: { ...active.profile, args: [...active.profile.args] },
        state: this.process?.state ?? 'offline', ownership, ownershipError, ownerName: this.nameOf(ownership.owner), mods, modsError, modInstallError, modTarget: target,
        playerPort: await readServerPort(serverDir) };
    }
    const relay = this.relayReadback();
    const gateway = await readGameGateway(this.root);
    if (gateway.error && this.gatewayTunnel) await this.closeGameGateway();
    return {
      version: '0.5.0',
      deviceId: this.identity.fingerprint,
      settings: { ...this.saved.settings },
      server,
      servers: await Promise.all(this.saved.servers.map(async (entry) => {
        let ownerName: string | null = null;
        let state: string = 'unknown';
        try {
          const ownership = entry.id === active?.id && server ? server.ownership : await new OwnershipLedger(entry.ledgerFile, this.identity.fingerprint).status();
          ownerName = this.nameOf(ownership.owner);
          state = entry.id === active?.id ? this.process?.state ?? 'offline' : 'offline';
        } catch { /* An unreadable ledger is unknown, not proof of local ownership. */ }
        return { id: entry.id, name: entry.name, active: entry.id === this.saved.activeServerId, state, ownerName, configured: Boolean(entry.profile.executable && entry.profile.args.length), playerPort: await readServerPort(entry.serverDir),
          group: entry.group ? { fingerprint: entry.group.fingerprint, parkOnStop: entry.group.parkOnStop } : null };
      })),
      relay,
      /** Groups joined without a local world yet; claimPendingGroup turns one into a new library server. */
      pendingGroups: this.saved.pendingGroups.map((entry) => ({ ...this.groupReadback(entry, entry.relayName), since: entry.since })),
      peers: this.saved.peers.map((peer) => ({ ...peer })),
      logs: this.serverLogs(id),
      peerEndpoint: this.listener ? { host: this.listener.host, port: this.listener.port } : null,
      busy: this.busy,
      onboarding: await readOnboarding(this.root, Boolean(active), this.onboardingServerScope(active)),
      newServerOnboarding: await readOnboarding(this.root, false, null),
      gateway: { ...gateway, ...this.gatewayState, ...(gateway.error ? {state: 'error', detail: gateway.error} : {}) },
      lanAddresses: privateLanAddresses(),
      // A friendly default name for this PC in pairings ("DESKTOP-VMCMIP5", "Angels-Laptop").
      deviceName: (hostname().replace(/\.local$/i, '').replace(/[^\w .'-]/g, '').trim() || 'This PC').slice(0, 60),
    };
  }

  /**
   * Finish the recovery of a claim whose new server entry was published before its ownership authority was
   * initialized (the journalled append in `materializeGroupIncoming` / the fresh direct receive). Durable
   * evidence decides the outcome, never a guess: a missing/empty ownership database means no acceptance ever
   * committed, so the append is rolled back exactly like the in-process pre-authority rollback; a recorded
   * acceptance means the claim is durable and only the journal needs clearing.
   */
  private async reconcileActivation(): Promise<void> {
    const activation = this.saved.activation ?? null;
    if (!activation) return;
    const entry = this.saved.servers.find((server) => server.id === activation.serverId) ?? null;
    const row = entry ? await new OwnershipLedger(entry.ledgerFile, this.identity.fingerprint).statusOrNull() : undefined;
    if (entry && row === undefined) {
      this.saved.servers = this.saved.servers.filter((server) => server !== entry);
      if (this.saved.activeServerId === entry.id) {
        // Restore the world the user actually had selected, not merely the first library entry: a crash-recovery
        // rollback must never silently switch which world the library treats as active.
        const previous = activation.previousActiveServerId;
        this.saved.activeServerId = previous && this.saved.servers.some((server) => server.id === previous) ? previous : this.saved.servers[0]?.id ?? null;
      }
      // Defensive only: the normal path removed this group before persisting, so a duplicate can only come from
      // a hand-edited or partially written state file. Never list the same pending group twice.
      if (activation.pending && !this.saved.pendingGroups.some((group) => group.fingerprint === activation.pending!.fingerprint)) {
        this.saved.pendingGroups = [...this.saved.pendingGroups, activation.pending];
      }
      this.saved.activation = null;
      await this.persist();
      this.log('An interrupted claim was rolled back: no ownership was accepted and the shared world was not downloaded. The copied files were kept on disk, and the pending group can be downloaded again.');
      return;
    }
    // The acceptance is durably recorded (or the entry vanished): the journal is spent either way.
    this.saved.activation = null;
    await this.persist();
  }

  private assertStopped(): void {
    if (this.process?.pid || this.process?.state === 'starting' || this.process?.state === 'stopping') {
      throw new Error('Stop the server before this operation');
    }
  }

  async saveOnboarding(input: unknown, alwaysOn?: SetupConfiguration['alwaysOn'], serverId?: string | null): Promise<void> {
    await this.operation('saveOnboarding', async () => {
      const progress = validateOnboarding(input);
      if (serverId !== undefined && serverId !== null) {
        if (!isServerId(serverId)) throw new Error('Invalid server id');
        if (!this.saved.servers.some(entry => entry.id === serverId)) throw new Error('That server is no longer in the library. Refresh and try again.');
        if (this.saved.activeServerId !== serverId) throw new Error('The selected server changed. Refresh before continuing.');
      }
      const active = serverId === null ? null : this.activeServer();
      if (progress.completed && (!active || !active.profile.executable || !active.profile.args.length)) throw new Error('Configure a server and its launch profile before completing setup');
      if (progress.completed) {
        await assertModInstallComplete(active!.serverDir);
        const checks = onboardingChecks(progress, { server: active!, relay: active!.group, gateway: await readGameGateway(this.root), alwaysOn });
        if (checks.ready !== 'complete') throw new Error('Resolve Friends and Always-on PC, or explicitly skip those optional steps before completing setup');
      }
      await saveOnboarding(this.root, progress, this.onboardingServerScope(active));
    });
  }

  private onboardingLedgerKey(server: SavedServer): string {
    return createHash('sha256').update(server.ledgerFile).digest('hex');
  }

  /** Pre-library v1 parsing assigns a fresh in-memory id on each open. Keep only its optional guide stable;
   * never change library ids or persist authoritative state just to migrate progress. */
  private onboardingServerScope(server: SavedServer | null): string | null {
    if (!server) return null;
    const legacy = this.legacyOnboardingScope;
    if (legacy && this.onboardingLedgerKey(server) === legacy.ledgerKey &&
        !this.saved.servers.some(entry => entry.id === legacy.id && this.onboardingLedgerKey(entry) !== legacy.ledgerKey) &&
        this.saved.servers.filter(entry => this.onboardingLedgerKey(entry) === legacy.ledgerKey).length === 1) return legacy.id;
    return server.id;
  }

  private ledger(): OwnershipLedger {
    return new OwnershipLedger(this.requireActive().ledgerFile, this.identity.fingerprint);
  }

  /** The server the app currently shows and acts on. */
  private activeServer(): SavedServer | null {
    if (this.saved.activeServerId === null) return null;
    return this.saved.servers.find((entry) => entry.id === this.saved.activeServerId) ?? null;
  }

  private requireActive(): SavedServer {
    const server = this.activeServer();
    if (!server) throw new Error('No server imported');
    return server;
  }

  private addServer(entry: SavedServer): void {
    const first = this.saved.servers.length === 0;
    this.saved.servers.push(entry);
    this.saved.activeServerId = entry.id;
    if (first) this.adoptPendingGroup(entry);
  }

  /**
   * A group joined (or chosen) while this PC still had no world belongs to the first world added afterwards —
   * ONLY for the explicit legacy single-world continuity (`adoptable`). Modern enrollment (account invitations and
   * joinHostingGroup) stays pending until an explicit download, so an unrelated local world can never be handed
   * to someone else's group implicitly. A world that already existed when the group was joined is never attached.
   */
  private adoptPendingGroup(entry: SavedServer): void {
    if (entry.group || this.saved.pendingGroups.length !== 1) return;
    const pending = this.saved.pendingGroups[0]!;
    if (!pending.adoptable) {
      this.log('A joined hosting group stays pending: it is not attached to ' + entry.name + ' automatically. Download the shared world as a new server when you want a copy here.');
      return;
    }
    entry.group = { fingerprint: pending.fingerprint, parkOnStop: pending.parkOnStop };
    this.saved.pendingGroups = [];
    this.log('The joined hosting group now belongs to ' + entry.name + '. Nothing was downloaded or started.');
  }

  /** Swap the active entry in place; `null` removes it, which is how a rolled-back activation is undone. */
  private replaceActive(entry: SavedServer | null): void {
    const index = this.saved.servers.findIndex((candidate) => candidate.id === this.saved.activeServerId);
    if (entry === null) {
      if (index >= 0) this.saved.servers.splice(index, 1);
      this.saved.activeServerId = this.saved.servers[0]?.id ?? null;
      return;
    }
    if (index >= 0) this.saved.servers[index] = entry; else this.saved.servers.push(entry);
    this.saved.activeServerId = entry.id;
  }

  /** Every revision any server on this PC still needs. The content store is shared, so pruning must consider all of them. */
  private async retainedRevisions(): Promise<string[]> {
    const keep: string[] = [];
    for (const entry of this.saved.servers) {
      keep.push(entry.snapshotId);
      try {
        const state = await new OwnershipLedger(entry.ledgerFile, this.identity.fingerprint).status();
        keep.push(state.snapshotId);
        if (state.offer) keep.push(state.offer.snapshotId);
      } catch { /* an unreadable ledger keeps its recorded revision, nothing more is assumed */ }
    }
    return [...new Set(keep)];
  }

  /** Best-effort only AFTER durable snapshot + ledger + library publication, inside the operation lock. */
  private async retainCompletedBackup(server: SavedServer): Promise<void> {
    try {
      if (this.saved.activation || this.saved.pendingGroups.length) throw new Error('Pending claim or activation requires retained recovery evidence');
      const keep: string[] = [];
      const sameStore = (a: string, b: string) => process.platform === 'win32'
        ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
      for (const entry of this.saved.servers) {
        if (!sameStore(entry.storeDir, server.storeDir)) continue;
        const state = await new OwnershipLedger(entry.ledgerFile, this.identity.fingerprint).status();
        if (!['owned', 'transferred'].includes(state.state) || state.offer) throw new Error('Ownership or pending offer is unresolved');
        if (entry === server && state.snapshotId !== server.snapshotId) throw new Error('Backup metadata is not reconciled');
        const journal = await readAdmission(this.root, entry.id);
        if (journal && !['stopped', 'cancelled'].includes(journal.phase)) throw new Error('Hosting recovery journal is unresolved');
        // The completed revision is protected as `latest`; its own predecessor stays replaceable.
        if (entry !== server) keep.push(entry.snapshotId, state.snapshotId);
      }
      const result = await pruneBackupHistory(server.storeDir, server.snapshotId, [...new Set(keep)]);
      this.log(`Automatic backup retention removed ${result.snapshotsRemoved} old revision(s), ${result.objectsRemoved} unused object(s), ${result.bytesFreed} bytes freed. Operational/conflict copies are retained.`);
    } catch (error) {
      this.log('Backup saved; automatic retention deferred: ' + String((error as Error).message));
    }
  }

  /** Choose which server the app operates on. Custody that is still owed elsewhere is never hidden by switching. */
  async selectServer(id: string): Promise<void> {
    this.assertStopped();
    if (!isServerId(id)) throw new Error('Invalid server id');
    await this.operation('selectServer', async () => {
      const target = this.saved.servers.find((entry) => entry.id === id);
      if (!target) throw new Error('That server is no longer in the library. Refresh and try again.');
      if (this.saved.activeServerId === id) return;
      const current = this.activeServer();
      if (current) {
        // An unreadable record must not lock the library: the handoff guard applies only to a readable state,
        // and switching changes nothing about any ledger.
        const state = await this.ledger().status().catch(() => null);
        if (state === null) this.log('The current server’s ownership record is unreadable; switching anyway. Its record is kept for repair and nothing about ownership is assumed.');
        else if (state.state === 'offered') throw new Error('A handoff of this server is pending. Finish or cancel it before switching servers.');
      }
      this.saved.activeServerId = id;
      await this.persist();
      this.log('Switched to ' + target.name + '. Its own launch profile and backups apply.');
    });
  }

  /** Remove one server from this PC. Only this app's managed copies go; a server whose custody is not safely held here is refused. */
  async deleteServer(id: string): Promise<void> {
    this.assertStopped();
    if (!isServerId(id)) throw new Error('Invalid server id');
    await this.operation('deleteServer', async () => {
      const entry = this.saved.servers.find((candidate) => candidate.id === id);
      if (!entry) throw new Error('That server is no longer in the library. Refresh and try again.');
      const index = this.saved.servers.indexOf(entry);
      let status: Awaited<ReturnType<OwnershipLedger['status']>> | null = null;
      try { status = await new OwnershipLedger(entry.ledgerFile, this.identity.fingerprint).status(); } catch { status = null; }
      if (!status) throw new Error('This server’s ownership record cannot be read, so it cannot be deleted safely. Restore it from a backup first.');
      if (status.state !== 'owned' || status.owner !== this.identity.fingerprint) {
        throw new Error('Only a server whose ownership is safely held by this PC can be deleted. Recover it, or take it back from the other PC, first.');
      }
      // Drop the reference before the files: state never points at a half-deleted server.
      this.saved.servers.splice(index, 1);
      if (this.saved.activeServerId === id) this.saved.activeServerId = this.saved.servers[0]?.id ?? null;
      await this.persist();
      const leftover: string[] = [];
      // The execution folder and the ownership record belong to this server alone.
      try { await rm(entry.serverDir, { recursive: true, force: true }); } catch { leftover.push(entry.serverDir); }
      try { await rm(entry.ledgerFile, { force: true }); } catch { leftover.push(entry.ledgerFile); }
      // The object store is shared by every server here: only its now-unreferenced revisions go.
      let pruned = null;
      try { pruned = await pruneStore(entry.storeDir, { keep: await this.retainedRevisions(), ancestors: CLEANUP_ANCESTORS }); }
      catch (error) { this.log('Deleted ' + entry.name + ', but its backups could not be pruned: ' + String((error as Error).message)); }
      if (leftover.length) this.log('Removed ' + entry.name + ' from the app, but some files could not be deleted: ' + leftover.join(', '));
      else this.log('Deleted ' + entry.name + ', its managed copy and its own backups' + (pruned ? ' (' + (pruned.bytesFreed / 1024 ** 2).toFixed(1) + ' MiB freed)' : '') + '. Other servers and your original folder were not touched.');
    });
  }

  /** Human name for an ownership fingerprint, for status lines and errors. */
  private nameOf(fingerprint: string): string | null {
    if (fingerprint === this.identity.fingerprint) return 'this PC';
    if (this.saved.servers.some((entry) => entry.group?.fingerprint === fingerprint) ||
        this.saved.pendingGroups.some((entry) => entry.fingerprint === fingerprint)) return 'the relay';
    return this.saved.peers.find((peer) => peer.fingerprint === fingerprint)?.name ?? null;
  }

  /**
   * The hosting group governing what the app shows now: the selected world's own binding, or — while this PC still
   * has no world — the single joined group (legacy single-world continuity). Several pending groups are ambiguous
   * and resolve to nothing until one is chosen explicitly.
   */
  private selectedGroup(): { relay: RelayConfig; name?: string } | null {
    const active = this.activeServer();
    if (active) return active.group ? { relay: active.group } : null;
    const pending = this.saved.pendingGroups;
    if (pending.length === 1) return { relay: { fingerprint: pending[0]!.fingerprint, parkOnStop: pending[0]!.parkOnStop }, name: pending[0]!.relayName };
    return null;
  }

  /** Readback for one binding: always names and locates the endpoint through the trusted peer entry. */
  private groupReadback(relay: { fingerprint: string; parkOnStop: boolean }, fallbackName?: string) {
    const peer = this.saved.peers.find((entry) => entry.fingerprint === relay.fingerprint);
    return { fingerprint: relay.fingerprint, parkOnStop: relay.parkOnStop, name: peer?.name ?? fallbackName ?? 'Relay',
      endpoint: peer ? { host: peer.host, port: peer.port } : null };
  }

  /** getState().relay keeps its contract: the selected world's group as { fingerprint, parkOnStop, name }, else null. */
  private relayReadback(): { fingerprint: string; parkOnStop: boolean; name: string } | null {
    const group = this.selectedGroup();
    if (!group) return null;
    const readback = this.groupReadback(group.relay, group.name);
    return { fingerprint: readback.fingerprint, parkOnStop: readback.parkOnStop, name: readback.name };
  }

  private relayPeer(): SavedPeer | undefined {
    const group = this.selectedGroup();
    return group ? this.saved.peers.find((peer) => peer.fingerprint === group.relay.fingerprint) : undefined;
  }

  private requireRelay(): SavedPeer {
    const group = this.selectedGroup();
    if (!group) {
      if (!this.activeServer() && this.saved.pendingGroups.length > 1) {
        throw new Error('This PC has joined more than one hosting group. Choose the group to use first.');
      }
      if (this.activeServer()) {
        throw new Error('This world is not part of a hosting group, so no relay applies to it. Choose a group for this world explicitly; a group joined without a local world is downloaded as a new server instead.');
      }
      throw new Error('No relay is configured. Trust the always-on PC as a peer, then choose it as the relay in Settings.');
    }
    const peer = this.saved.peers.find((entry) => entry.fingerprint === group.relay.fingerprint);
    if (!peer) throw new Error('This hosting group’s always-on PC is missing from trusted peers. Restore its peer entry before continuing.');
    return peer;
  }

  /** The hosting-group context of one library world, for per-server helpers. Read-only; any library server may be asked. */
  async getServerGroup(serverId: string): Promise<ServerGroupInfo> {
    if (!isServerId(serverId)) throw new Error('Invalid server id');
    const server = this.saved.servers.find((entry) => entry.id === serverId);
    if (!server) throw new Error('That server is no longer in the library. Refresh and try again.');
    return { serverId, bound: Boolean(server.group), relay: server.group ? this.groupReadback(server.group) : null };
  }

  private log(line: string): void {
    // Console output is per server: switching servers must never blend two worlds' logs.
    this.logs.push('[' + (this.saved.activeServerId ?? 'app') + '] ' + line.slice(0, 16384));
    if (this.logs.length > 1000) this.logs.shift();
  }

  private serverLogs(id: string): string[] {
    const prefix = '[' + id + '] ';
    return this.logs.filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length));
  }

  /** Atomically replace state.json: write and flush a temporary, rename it, then flush the directory entry. */
  private async persist(): Promise<void> {
    const file = path.join(this.root, 'state.json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(this.saved)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
    await syncDirectory(this.root);
  }

  private async fenceUnexpectedExit(): Promise<void> {
    while (this.unexpectedExit) {
      const ledger = this.unexpectedExit;
      this.unexpectedExit = undefined;
      try { await ledger.markUncertain(); }
      catch (error) { this.unexpectedExit = ledger; throw error; }
    }
  }

  /** One operation at a time. An unexpected server exit is fenced before the operation starts and before it releases. */
  private async operation<T>(name: string, work: (token: symbol) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('An operation is already in progress');
    this.busy = name;
    const token = Symbol(name);
    this.operationToken = token;
    try {
      await this.fenceUnexpectedExit();
      return await work(token);
    } finally {
      try { await this.fenceUnexpectedExit(); }
      finally { this.operationToken = undefined; this.busy = null; }
    }
  }

  // ---------------------------------------------------------------- selected-server dashboard

  private selectedServer(id: string): SavedServer {
    if (!isServerId(id) || this.requireActive().id !== id) throw new Error('The selected server changed. Refresh before continuing.');
    return this.requireActive();
  }

  private samplePlayers(serverId: string, port: number, pid: number): Promise<MinecraftStatusResult> {
    const identity = `${pid}:${port}`, existing = this.playerSamples.get(serverId);
    if (existing?.identity === identity && Date.now() - existing.at < 5000) return existing.pending;
    // Bounded cache; process stop/start explicitly invalidates it. No remote/public probes.
    if (this.playerSamples.size > this.saved.servers.length) this.playerSamples.clear();
    const entry = { identity, at: Date.now(), pending: queryLocalMinecraft(port) };
    this.playerSamples.set(serverId, entry);
    return entry.pending;
  }

  async getServerDashboard(id: string) {
    const server = this.selectedServer(id);
    const sampledProcess = this.process;
    const sampledState = sampledProcess?.state;
    const sampledPid = sampledProcess?.pid;
    const assertCurrent = () => {
      if (this.selectedServer(id) !== server) throw new Error('The selected server changed. Refresh before continuing.');
      if (this.process !== sampledProcess || this.process?.state !== sampledState || this.process?.pid !== sampledPid) throw new Error('Server process changed during dashboard sampling. Refresh before continuing.');
    };
    let settings = {};
    let settingsError: string | null = null;
    try { settings = readServerProperties((await readManagedText(this.root, server.serverDir, 'server.properties', false)).text); }
    catch (error) { settingsError = String((error as Error).message).slice(0, 300); }
    assertCurrent();
    if (sampledState === 'running' && sampledPid !== undefined) {
      const performancePending = this.metrics.sample(sampledPid);
      let players: { online: number | null; max: number | null; sample: Array<{ name: string; id?: string }>; error: string | null };
      try {
        const port = await readServerPort(server.serverDir);
        assertCurrent();
        players = await this.samplePlayers(server.id, port, sampledPid);
      }
      catch { players = { online: null, max: null, sample: [], error: 'Minecraft server status unavailable' }; }
      if (players.online === 0 && players.max === null && players.error === null) players = { online: null, max: null, sample: [], error: 'Minecraft status is unavailable: the running process is not accepting loopback status requests.' };
      const performance = await performancePending;
      assertCurrent();
      return { serverId: id, state: sampledState, performance, players,
        settings, settingsError, schedules: this.schedules.filter(job => job.serverId === id).map(job => ({ ...job })), scheduleError: this.scheduleError, logs: this.serverLogs(id) };
    }
    return { serverId: id, state: this.process?.state ?? 'offline',
      performance: { pid: null, cpuPercent: null, memoryMiB: null, uptimeSeconds: null, sampledAt: Date.now(), error: 'Server is not running' },
      players: { online: null, max: null, sample: [], error: 'Server is not running' },
      settings, settingsError, schedules: this.schedules.filter(job => job.serverId === id).map(job => ({ ...job })), scheduleError: this.scheduleError, logs: this.serverLogs(id) };
  }

  async resolveServerFolder(id: string): Promise<string> {
    const server = this.selectedServer(id);
    const folder = await resolveServerPath(this.root, server.serverDir, '', true);
    if (this.selectedServer(id) !== server) throw new Error('The selected server changed. Refresh before continuing.');
    return folder;
  }

  async listServerFiles(id: string, relative: string) {
    const server = this.selectedServer(id);
    const result = await listManagedFiles(this.root, server.serverDir, relative);
    if (this.selectedServer(id) !== server) throw new Error('The selected server changed. Refresh before continuing.');
    return { serverId: id, ...result };
  }

  async readServerFile(id: string, relative: string) {
    const server = this.selectedServer(id);
    const result = await readManagedText(this.root, server.serverDir, relative, false);
    if (this.selectedServer(id) !== server) throw new Error('The selected server changed. Refresh before continuing.');
    return { serverId: id, ...result };
  }

  private async editableServer(id: string): Promise<SavedServer> {
    this.assertStopped();
    const server = this.selectedServer(id);
    const ownership = await new OwnershipLedger(server.ledgerFile, this.identity.fingerprint).status();
    if (ownership.state !== 'owned' || ownership.owner !== this.identity.fingerprint) throw new Error('Server editing requires safely held local ownership');
    await assertModInstallComplete(server.serverDir);
    return server;
  }

  async writeServerFile(id: string, relative: string, text: string, expectedHash: string) {
    this.selectedServer(id);
    return this.operation('writeServerFile', async () => {
      const server = await this.editableServer(id);
      const result = await writeManagedText(this.root, server.serverDir, relative, text, expectedHash);
      this.log('Saved ' + relative + '. Previous bytes retained in ' + result.backupFile);
      return { serverId: id, ...result };
    });
  }

  async saveServerSettings(id: string, settings: unknown) {
    const patch = validateServerProperties(settings);
    this.selectedServer(id);
    return this.operation('saveServerSettings', async () => {
      const server = await this.editableServer(id);
      const previous = await readManagedText(this.root, server.serverDir, 'server.properties');
      const result = await writeManagedText(this.root, server.serverDir, 'server.properties', patchServerProperties(previous.text, patch), previous.hash);
      this.log('Saved Minecraft properties for ' + server.name + '. They apply on the next start.');
      return { serverId: id, ...result };
    });
  }

  private disableScheduler(error: unknown): Error {
    this.scheduleError = 'Scheduler disabled: ' + String((error as Error).message).slice(0, 240);
    if (this.scheduleTimer) { clearInterval(this.scheduleTimer); this.scheduleTimer = undefined; }
    return new Error(this.scheduleError);
  }

  private async checkScheduleRevision(): Promise<void> {
    if (this.scheduleError) throw new Error(this.scheduleError);
    try {
      const snapshot = await readScheduleSnapshot(this.root);
      if (snapshot.revision !== this.scheduleRevision) throw new Error('Schedule metadata changed. Restore the expected revision before reopening.');
    } catch (error) { throw this.disableScheduler(error); }
  }

  private async persistSchedules(jobs: ServerSchedule[]): Promise<void> {
    try { this.scheduleRevision = await writeSchedules(this.root, jobs, this.scheduleRevision); }
    catch (error) { throw this.disableScheduler(error); }
  }

  async saveServerSchedule(id: string, value: unknown) {
    const input = validateScheduleInput(value);
    this.selectedServer(id);
    return this.operation('saveServerSchedule', async () => {
      await this.checkScheduleRevision();
      const server = this.selectedServer(id);
      const owner = await new OwnershipLedger(server.ledgerFile, this.identity.fingerprint).status();
      if (owner.owner !== this.identity.fingerprint || (owner.state !== 'owned' && owner.state !== 'hosting')) throw new Error('Schedules require safely held local ownership');
      const previous = input.id ? this.schedules.find(job => job.id === input.id && job.serverId === id) : undefined;
      if (input.id && !previous) throw new Error('Schedule not found for this server');
      if (!previous && this.schedules.filter(job => job.serverId === id).length >= 50) throw new Error('This server already has 50 schedules');
      const job = createSchedule(id, input);
      if (previous) { job.lastRunAt = previous.lastRunAt; job.lastOutcome = previous.lastOutcome; }
      const next = previous ? this.schedules.map(old => old === previous ? job : old) : [...this.schedules, job];
      await this.persistSchedules(next);
      this.schedules = next;
      return this.schedules.filter(job => job.serverId === id).map(job => ({ ...job }));
    });
  }

  async managePlayer(id: string, action: string, name: string) {
    if (!['kick', 'whitelist-add', 'whitelist-remove'].includes(action) || typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error('Invalid player action or Minecraft name');
    this.selectedServer(id);
    return this.operation('managePlayer', async () => {
      const server = this.selectedServer(id);
      const ownership = await new OwnershipLedger(server.ledgerFile, this.identity.fingerprint).status();
      if (this.process?.state !== 'running' || ownership.state !== 'hosting' || ownership.owner !== this.identity.fingerprint) throw new Error('Player actions require this owned server running on this PC');
      const command = action === 'kick' ? 'kick ' + name : 'whitelist ' + (action === 'whitelist-add' ? 'add ' : 'remove ') + name;
      this.process.sendCommand(command);
      return { serverId: id, sent: true, command };
    });
  }

  async deleteServerSchedule(id: string, scheduleId: string) {
    this.selectedServer(id);
    return this.operation('deleteServerSchedule', async () => {
      await this.checkScheduleRevision();
      if (!this.schedules.some(job => job.id === scheduleId && job.serverId === id)) throw new Error('Schedule not found for this server');
      const next = this.schedules.filter(job => job.id !== scheduleId || job.serverId !== id);
      await this.persistSchedules(next);
      this.schedules = next;
      return this.schedules.filter(job => job.serverId === id).map(job => ({ ...job }));
    });
  }

  /** App-local scheduling only. Missed intervals collapse to one occurrence, with no automatic server switching. */
  async tickServerSchedules(now = Date.now()): Promise<void> {
    if (this.scheduleTick) return this.scheduleTick;
    if (this.scheduleError || this.busy) return;
    this.scheduleTick = (async () => {
      try { await this.checkScheduleRevision(); } catch { return; }
      for (const job of [...this.schedules].sort((a, b) => a.nextRunAt - b.nextRunAt)) {
        if (this.busy) break;
        if (!job.enabled || job.nextRunAt > now || !this.schedules.includes(job)) continue;
        try { await this.runSchedule(job, now); }
        catch (error) { this.log('Schedule “' + job.name + '”: ' + String((error as Error).message)); }
      }
    })();
    try { await this.scheduleTick; } finally { this.scheduleTick = undefined; }
  }

  private async runSchedule(job: ServerSchedule, now = Date.now()): Promise<void> {
    if (this.scheduleError) throw new Error(this.scheduleError);
    await this.operation('runServerSchedule', async () => {
      await this.checkScheduleRevision();
      validateScheduleInput({ name: job.name, action: job.action, intervalMinutes: job.intervalMinutes, enabled: job.enabled, ...(job.action === 'command' ? { command: job.command } : {}) });
      const running = { ...job, lastRunAt: now, nextRunAt: now + job.intervalMinutes * 60000, lastOutcome: 'Started; completion unconfirmed' };
      const next = this.schedules.map(old => old.id === job.id ? running : old);
      // Claim this occurrence durably before side effects, so restart never replays an uncertain command.
      await this.persistSchedules(next);
      this.schedules = next;
      let failure: unknown;
      try {
        const server = this.saved.servers.find(entry => entry.id === job.serverId);
        if (!server) throw new Error('Scheduled server is no longer in this library');
        const ledger = new OwnershipLedger(server.ledgerFile, this.identity.fingerprint);
        const owner = await ledger.status();
        if (owner.owner !== this.identity.fingerprint || (owner.state !== 'owned' && owner.state !== 'hosting')) throw new Error('Schedule skipped: ownership is not safely held here');
        if (job.action === 'command') {
          if (server.id !== this.saved.activeServerId || this.process?.state !== 'running' || owner.state !== 'hosting') throw new Error('Command schedule requires this server running on this PC');
          this.process.sendCommand(job.command!);
          running.lastOutcome = 'Command sent to the server console; execution is shown in Console';
        } else if (job.action === 'backup') {
          if (server.id === this.saved.activeServerId) this.assertStopped();
          if (owner.state !== 'owned') throw new Error('Backup requires a safely stopped server; no live file copy was attempted');
          await assertModInstallComplete(server.serverDir);
          await assertServerFileTransactionsComplete(server.serverDir);
          const snapshot = await createSnapshot(server.serverDir, server.storeDir, server.snapshotId);
          await ledger.updateSnapshot(snapshot.id);
          server.snapshotId = snapshot.id;
          await this.persist();
          running.lastOutcome = 'Completed backup: ' + snapshot.id;
          this.log('Scheduled backup saved for ' + server.name);
        } else if (job.action === 'stop') {
          if (server.id !== this.saved.activeServerId || this.process?.state !== 'running' || owner.state !== 'hosting') throw new Error('Stop schedule requires this server running on this PC');
          await this.stopServerInsideOperation();
          running.lastOutcome = 'Completed graceful stop and final local backup';
        } else { throw new Error('Invalid server schedule action'); }
      } catch (error) { failure = error; running.lastOutcome = 'Failed: ' + String((error as Error).message).slice(0, 290); }
      await this.persistSchedules(this.schedules);
      if (failure) throw failure;
    });
  }

  async runServerSchedule(id: string, scheduleId: string) {
    this.selectedServer(id);
    const job = this.schedules.find(candidate => candidate.id === scheduleId && candidate.serverId === id);
    if (!job) throw new Error('Schedule not found for this server');
    await this.runSchedule(job);
    return this.schedules.filter(job => job.serverId === id).map(job => ({ ...job }));
  }

  // ---------------------------------------------------------------- server lifecycle

  async createServer(input: CreateServerInput, downloadParent?: string): Promise<{ serverId: string }> {
    this.assertStopped();
    if (!input || input.eulaAccepted !== true) throw new Error('Explicit Minecraft EULA acceptance is required before creating a server');
    input = { ...input }; // Capture consent before the lock's first asynchronous fence.
    return this.operation('createServer', async () => {
      let parent = this.root;
      if (downloadParent !== undefined) {
        if (typeof downloadParent !== 'string' || !path.isAbsolute(downloadParent)) throw new Error('Choose an absolute download folder');
        const selected = path.resolve(downloadParent), stat = await lstat(selected);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Download location must be an ordinary folder, not a link');
        const actual = await realpath(selected);
        const folded = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
        if (folded(actual) !== folded(selected)) throw new Error('Download location must not pass through links or junctions');
        const profile = folded(await realpath(this.root)), destination = folded(actual);
        if (destination === profile || destination.startsWith(profile + path.sep) || profile.startsWith(destination + path.sep)) throw new Error('Download location must be separate from app-owned storage');
        parent = actual;
      }
      const staging = await mkdtemp(path.join(parent, 'server-setup-'));
      const prepared = await (this.options.serverSetup ?? new ServerSetupClient()).prepare(staging, input, { runtimeRoot: path.join(this.root, 'runtimes') });
      if (prepared.loader === 'fabric') {
        await prepared.assertSource();
        const index = await readModIndex(prepared.sourceDir);
        await prepared.assertSource();
        await writeModIndex(prepared.sourceDir, { ...index, target: { loader: 'fabric', gameVersion: prepared.gameVersion } });
      }
      const serverId = newServerId();
      const occupied = await Promise.all(this.saved.servers.map(server => readServerPort(server.serverDir)));
      let port = 25565;
      if (this.options.chooseServerPort) port = await this.options.chooseServerPort(serverId, occupied);
      else while (occupied.includes(port) && port < 65535) port++;
      if (!Number.isInteger(port) || port < 1 || port > 65535 || occupied.includes(port)) throw new Error('No distinct Minecraft port is available for this server');
      await prepared.assertSource();
      if (port !== await readServerPort(prepared.sourceDir)) {
        // Only our new, verified stopped source is changed; no existing world or external route is touched.
        const file = path.join(prepared.sourceDir, 'server.properties');
        const previous = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
        await prepared.assertSource();
        const handle = await open(file, 'wx');
        try { await handle.writeFile(patchServerProperties(previous, { 'server-port': port })); await handle.sync(); } finally { await handle.close(); }
      }
      await prepared.assertSource();
      const result = await importServer(prepared.sourceDir, path.join(this.root, 'managed'));
      const ledgerFile = path.join(this.root, `ownership-${randomUUID()}.sqlite`);
      await new OwnershipLedger(ledgerFile, this.identity.fingerprint).initialize(result.snapshot.id);
      this.addServer({
        id: serverId, name: input.name, serverDir: result.serverDir, storeDir: result.storeDir, snapshotId: result.snapshot.id,
        profile: validateLaunchProfile(prepared.profile), ledgerFile, group: null,
      });
      try { await this.persist(); }
      catch (error) { await new OwnershipLedger(ledgerFile, this.identity.fingerprint).markUncertain(); throw error; }
      if (downloadParent === undefined) await rm(staging, { recursive: true, force: true });
      this.log(downloadParent === undefined ? 'Created a verified managed server. Nothing was started.' : 'Downloaded verified server files into the selected folder and created a separate managed working copy. Nothing was started.');
      return { serverId };
    });
  }

  async importExisting(source: string, confirmedStopped: boolean): Promise<void> {
    this.assertStopped();
    if (!confirmedStopped) throw new Error('Confirm the source server is stopped before importing');
    await this.operation('importServer', async () => {
      const result = await importServer(source, path.join(this.root, 'managed'));
      const ledgerFile = path.join(this.root, `ownership-${randomUUID()}.sqlite`);
      await new OwnershipLedger(ledgerFile, this.identity.fingerprint).initialize(result.snapshot.id);
      this.addServer({
        id: newServerId(), name: path.basename(source), serverDir: result.serverDir, storeDir: result.storeDir, snapshotId: result.snapshot.id,
        profile: validateLaunchProfile({ executable: '', args: [] }, true), ledgerFile, group: null,
      });
      await this.persist();
      this.log('Imported a separate managed copy. Original folder was not modified.');
    });
  }

  async saveProfile(profile: LaunchProfileInput): Promise<void> {
    this.assertStopped();
    await this.operation('saveProfile', async () => {
      if (!this.activeServer()) throw new Error('No server imported');
      this.requireActive().profile = validateLaunchProfile(profile);
      await this.persist();
    });
  }

  async configureSimpleProfile(input: SimpleProfileInput): Promise<void> {
    this.assertStopped();
    input = validateSimpleProfileInput(input);
    await this.operation('configureSimpleProfile', async () => {
      const server = this.activeServer();
      if (!server) throw new Error('No server imported');
      await probeJava(input.javaExecutable);
      let args = [...server.profile.args];
      if (!args.length) {
        const entries = await readdir(server.serverDir, { withFileTypes: true });
        if (entries.some(e => e.isFile() && /\.(?:sh|bat|cmd|ps1)$/i.test(e.name))) throw new Error('Use advanced Launch profile for a scripted server');
        const candidates = entries.filter(e => e.isFile() && /^(?:server|minecraft_server[._][\w.+-]+|fabric-server-launch)\.jar$/i.test(e.name));
        const allJars = entries.filter(e => e.isFile() && /\.jar$/i.test(e.name));
        // A Fabric layout deliberately contains its Vanilla dependency beside its launcher.
        const fabric = candidates.find(e => e.name === 'fabric-server-launch.jar');
        const jar = fabric && allJars.every(e => e.name === 'server.jar' || e.name === fabric.name) ? fabric.name : allJars.length === 1 && candidates.length === 1 ? candidates[0]!.name : undefined;
        if (!jar) throw new Error('Use advanced Launch profile: no unambiguous server JAR command was found');
        args = ['-jar', jar, 'nogui'];
      }
      // JVM argument files may override later command-line heap flags; never claim a RAM change we cannot prove.
      for (const arg of args.filter(a => a.startsWith('@'))) {
        const filename = path.resolve(server.serverDir, arg.slice(1));
        if (!filename.startsWith(server.serverDir + path.sep)) throw new Error('Use advanced Launch profile for external argument files');
        let handle;
        try {
          const stat = await lstat(filename);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Use advanced Launch profile for unsafe argument files');
          handle = await open(filename, 'r');
          const buffer = Buffer.alloc(65537); const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 65536 || /-Xm[sx]|@[\w./\\]/.test(buffer.subarray(0, bytesRead).toString('utf8'))) throw new Error('Use advanced Launch profile: RAM is controlled by an argument file');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        finally { await handle?.close(); }
      }
      args = withoutJvmHeapArgs(args);
      if (input.customJavaArgs) args = withCustomJavaArgs(args, input.customJavaArgs);
      const profile = validateLaunchProfile({ ...server.profile, executable: input.javaExecutable, args: ['-Xms512M', `-Xmx${input.memoryMiB}M`, ...args] });
      const previous = server.profile;
      server.profile = profile;
      try { await this.persist(); } catch (error) { server.profile = previous; throw error; }
    });
  }

  async saveGameGateway(input: unknown): Promise<void> {
    this.assertStopped();
    const config = validateGameGateway(input);
    await this.operation('saveGameGateway', async () => {
      if (config.enabled) this.requireRelay();
      await this.closeGameGateway();
      await saveGameGatewayConfig(this.root, config);
    });
  }

  private async closeGameGateway(): Promise<void> {
    this.gatewayEpoch++;
    const tunnel = this.gatewayTunnel;
    this.gatewayTunnel = undefined;
    this.gatewayState = { state: 'off', detail: 'No local host tunnel is active' };
    try { await tunnel?.close(); } catch (error) { this.log('Gateway cleanup error: ' + String(error)); }
  }

  private async startGameGateway(): Promise<void> {
    const config = await readGameGateway(this.root);
    if (config.error) { this.gatewayState = { state: 'error', detail: config.error }; return; }
    if (!config.enabled) return;
    const epoch = this.gatewayEpoch;
    try {
      const ownership = await this.ledger().status();
      if (this.process?.state !== 'running' || ownership.owner !== this.identity.fingerprint || ownership.state !== 'hosting' || !ownership.lineage) throw new Error('Gateway requires the running local owner');
      const relay = this.requireRelay();
      const custody = await relayStatus(this.identity, relay);
      if (!custody || custody.owner !== this.identity.fingerprint || custody.state !== 'transferred' || custody.pendingTarget !== null || custody.generation !== ownership.generation) throw new Error('Park and Claim once to establish confirmed relay custody before forwarding');
      const tunnel = await startHostGameGateway(this.identity, relay, config.localPort, {
        expectedRoute: { generation: ownership.generation, lineage: ownership.lineage },
        onStatus: status => { if (epoch === this.gatewayEpoch) this.gatewayState = status; },
      });
      if (epoch !== this.gatewayEpoch || this.process?.state !== 'running') await tunnel.close();
      else this.gatewayTunnel = tunnel;
    } catch (error) {
      if (epoch === this.gatewayEpoch) this.gatewayState = { state: 'error', detail: String((error as Error).message).slice(0, 512) };
      this.log('Player gateway unavailable; local server remains running. ' + String((error as Error).message));
    }
  }

  async checkGameGateway() {
    const config = await readGameGateway(this.root);
    if (config.error || !this.relayPeer()) return { enabled: false, host: null, port: null, ready: false, detail: config.error ?? 'No relay is configured' };
    try { return await gatewayStatus(this.identity, this.requireRelay()); }
    catch (error) { return { enabled: false, host: null, port: null, ready: false, detail: String((error as Error).message).slice(0, 512) }; }
  }

  async startServer(approved: boolean): Promise<void> {
    if (!approved) throw new Error('Confirm that you trust the server executables and mods');
    await this.startServerWithApproval(async () => true);
  }

  async startServerWithApproval(confirm: (approval: LaunchApproval) => Promise<boolean>): Promise<void> {
    this.assertStopped();
    const group = this.activeServer()?.group;
    if (group) return this.startGroupWithApproval(group.fingerprint, confirm);
    await this.operation('startServer', () => this.launchInsideOperation(confirm));
  }

  /** Explicit group-targeted execution consent, including membership with no local server. */
  async startGroup(fingerprint: string, approved: boolean): Promise<void> {
    if (!approved) throw new Error('Confirm that you trust the server executables and mods');
    await this.startGroupWithApproval(fingerprint, async () => true);
  }

  async startGroupWithApproval(fingerprint: string, confirm: (approval: LaunchApproval) => Promise<boolean>): Promise<void> {
    if (!fingerprintOK(fingerprint)) throw new Error('Invalid hosting group');
    this.assertStopped();
    await this.operation('startGroup: syncing', async token => {
      const pending = this.saved.pendingGroups.find(group => group.fingerprint === fingerprint);
      const bound = this.saved.servers.filter(server => server.group?.fingerprint === fingerprint);
      if (bound.length > 1) throw new Error('Ambiguous hosting group binding');
      if (pending && bound.length) throw new Error('Conflicting hosting group binding');
      if (!pending && !bound[0]) throw new Error('This PC has not joined that hosting group');
      // Refuse a replacement start BEFORE any custody work: an unresolved admitted start (including a final
      // snapshot whose Stop acknowledgment was lost) still holds the exact reservation the relay can resolve.
      if (bound[0]) await this.assertNoUnresolvedAdmission(bound[0].id);
      const peer = this.saved.peers.find(peer => peer.fingerprint === fingerprint);
      if (!peer) throw new Error('Missing pinned hosting group endpoint');
      // Reject a known local conflict before publishing or cycling this holder's custody.
      if (bound[0]) await preflightMinecraftPort(bound[0].serverDir);
      let initial = await this.reachRelay(peer, 'Hosting status is unknown; nothing was started.');
      if (initial?.state === 'offered' && initial.pendingTarget !== this.identity.fingerprint && (await relayFriends(this.identity, peer)).canManage) {
        await relayRecoverCheckout(this.identity, peer, initial.pendingTarget!);
        initial = await this.reachRelay(peer, 'Recovered checkout readback unavailable; nothing was started.');
      }
      if (!initial) {
        this.busy = 'startGroup: publishing initial stopped server';
        if (bound[0]) {
          this.saved.activeServerId = bound[0].id;
          await this.park();
        } else await relayInitialPublish(this.identity, peer);
      }
      this.busy = 'startGroup: acquiring';
      if (pending) await this.claimIntoNewServer(pending, token);
      else {
        if (!bound[0]) throw new Error('This PC has not joined that hosting group');
        this.saved.activeServerId = bound[0].id;
        await this.persist();
        // Only the still safely-owned stopped holder may publish local edits; legacy uncertain holders remain fenced.
        if (initial?.state === 'transferred' && initial.owner === this.identity.fingerprint) {
          this.busy = 'startGroup: publishing stopped changes';
          await this.park();
        }
        await this.claimBoundServer(this.requireRelay(), token);
      }
      const server = this.requireActive();
      if (this.options.resolveGroupLaunchProfile) {
        server.profile = validateLaunchProfile(await this.options.resolveGroupLaunchProfile(server.serverDir, Object.freeze({ ...server.profile, args: [...server.profile.args] })));
      } else {
        if (!server.profile.executable) throw new Error('Configure an approved local Java runtime and launch profile before starting this group');
        await probeJava(server.profile.executable);
        const args = await groupJavaLaunchArgs(server.serverDir, server.profile.args);
        server.profile = validateLaunchProfile({ ...server.profile, args });
      }
      await this.persist();
      this.busy = 'startGroup: starting';
      await this.launchInsideOperation(confirm);
    });
  }

  private async launchInsideOperation(confirm: (approval: LaunchApproval) => Promise<boolean>): Promise<void> {
      this.playerSamples.clear();
      const server = this.activeServer();
      if (!server?.profile.executable) throw new Error('Configure a launch profile first');
      if (server.group) await this.assertNoUnresolvedAdmission(server.id);
      await assertServerFileTransactionsComplete(server.serverDir);
      await assertModInstallComplete(server.serverDir);
      const original = JSON.stringify(server);
      const approval: LaunchApproval = Object.freeze({
        root: this.root, serverDir: server.serverDir, snapshotId: server.snapshotId,
        profile: Object.freeze({ executable: server.profile.executable, args: Object.freeze([...server.profile.args]) }),
      });
      if (!await confirm(approval)) return;
      // Everything launched below comes from `approval` or from metadata proven identical to what was approved.
      const revalidate = () => {
        this.assertStopped();
        if (this.activeServer() !== server || JSON.stringify(server) !== original) {
          throw new Error('Server lineage or launch profile changed during approval; approve again');
        }
      };
      revalidate();
      const eula = await readFile(path.join(approval.serverDir, 'eula.txt'), 'utf8').catch(() => '');
      if (!/^\s*eula\s*=\s*true\s*$/m.test(eula)) {
        throw new Error('Minecraft EULA acceptance is missing in the managed server copy; review and accept it yourself before launching');
      }
      const ledger = this.ledger();
      if ((await ledger.status()).snapshotId !== approval.snapshotId) throw new Error('Snapshot revision mismatch; reconcile metadata before hosting');
      revalidate();
      await assertModInstallComplete(server.serverDir);
      await assertServerFileTransactionsComplete(server.serverDir);
      await this.options.beforeServerStart?.({ id: server.id, playerPort: await readServerPort(server.serverDir) });
      revalidate();
      await preflightMinecraftPort(server.serverDir);
      revalidate();
      await ledger.startHosting();
      let admissionAttempted = false;
      let admitted = false;
      let spawned = false;
      let revision: { generation: number; snapshotId: string; lineage: string; reservation: string } | undefined;
      try {
        revalidate();
        // Recheck after the ledger's filesystem awaits, then spawn without another await.
        await this.options.beforeServerStart?.({ id: server.id, playerPort: await readServerPort(server.serverDir) });
        revalidate();
        if (server.group) {
          const authority = await ledger.status();
          if (!authority.lineage) throw new Error('Group hosting requires verified lineage');
          revision = { generation: authority.generation, snapshotId: authority.snapshotId, lineage: authority.lineage, reservation: randomUUID() };
          this.groupHostReservation = { version: 1, serverId: server.id, deviceId: this.identity.fingerprint, relayFingerprint: this.requireRelay().fingerprint, revision, attempted: true, acknowledged: false, stopped: false, recoverySnapshot: null, phase: 'attempted' };
          await saveAdmission(this.root, this.groupHostReservation);
          admissionAttempted = true;
          await relayHostState(this.identity, this.requireRelay(), 'host-start', revision);
          admitted = true;
          this.groupHostReservation.acknowledged = true;
          this.groupHostReservation.phase = 'acknowledged';
          await saveAdmission(this.root, this.groupHostReservation);
          revalidate();
        }
        await preflightMinecraftPort(server.serverDir);
        revalidate();
        const launched = new ServerProcess({
          executable: approval.profile.executable, args: [...approval.profile.args], cwd: approval.serverDir,
          startTimeoutMs: server.profile.startTimeoutSeconds * 1000, stopTimeoutMs: server.profile.stopTimeoutSeconds * 1000,
        });
        this.process = launched;
        this.controlledProcess = launched;
        launched.on('line', (line: string) => this.log(line));
        launched.on('state', (state: string) => {
          // 'starting' is emitted synchronously after spawn; even a child that immediately exits
          // counts as launched. ENOENT with no child PID is provably pre-spawn.
          if (launched.pid !== undefined) spawned = true;
          if ((state !== 'offline' && state !== 'failed') || this.process !== launched || this.controlledProcess === launched) return;
          this.groupHostSession?.close(); this.groupHostSession = undefined;
          void this.closeGameGateway();
          this.unexpectedExit = ledger;
          if (!this.busy) void this.operation('processExit', async () => {}).catch((error) => this.log('Ownership recovery error: ' + String(error)));
        });
        await launched.start();
        if (server.group) {
          const authority = await ledger.status();
          if (!authority.lineage) throw new Error('Group hosting requires verified lineage');
          try {
            this.groupHostSession = await openRelayHostSession(this.identity, this.requireRelay(), revision!);
          } catch (error) {
            // Execution was already admitted and the tracked process is running. Lost telemetry is UNKNOWN,
            // not a failed launch or released authority; keep the hosting ledger so orderly Stop can publish.
            this.log('Hosting is running locally, but the group could not observe it: ' + String(error));
          }
        }
        await this.startGameGateway();
      } catch (error) {
        if (!spawned && (!admissionAttempted || admitted)) {
          try {
            // Only acknowledged exact admission and proven no-spawn permits cancellation.
            // A lost host-start acknowledgment remains fenced even on this still-running PC.
            if (admitted) await relayHostState(this.identity, this.requireRelay(), 'host-cancel', revision!);
            await ledger.stopHosting(approval.snapshotId);
            if (this.groupHostReservation) { this.groupHostReservation.phase = 'cancelled'; await saveAdmission(this.root, this.groupHostReservation); }
            this.groupHostReservation = undefined;
          } catch (cancelError) {
            await ledger.markUncertain();
            throw new AggregateError([error, cancelError], 'Start failed; exact admission cancellation is unverified. Explicit recovery required.');
          }
        } else await ledger.markUncertain();
        throw error;
      } finally {
        this.controlledProcess = undefined;
      }
  }

  /**
   * An unresolved admitted start is not replaceable by a new Start: the durable journal holds the exact
   * reservation the relay can still resolve, so a replacement would orphan it. Explicit Stop (`stopServer`)
   * or confirmed stopped-process recovery finishes it first. A resolved journal never blocks later starts.
   */
  private async assertNoUnresolvedAdmission(serverId: string): Promise<void> {
    const reservation = this.groupHostReservation ?? await readAdmission(this.root, serverId);
    if (!reservation || reservation.serverId !== serverId || !reservation.attempted) return;
    if (reservation.phase === 'stopped' || reservation.phase === 'cancelled') return;
    throw new Error('A previous hosting admission for this server is unresolved; finish it with explicit Stop or confirmed stopped-process recovery before starting again');
  }

  /** Called only after graceful Stop or explicit stopped-process confirmation AND durable final snapshot. */
  private async finishGroupHostReservation(serverId: string): Promise<void> {
    const reservation = this.groupHostReservation ?? await readAdmission(this.root, serverId);
    if (!reservation || reservation.serverId !== serverId || !reservation.stopped || reservation.phase === 'stopped' || reservation.phase === 'cancelled') return;
    if (reservation.deviceId !== this.identity.fingerprint) throw new Error('Admission device mismatch');
    this.groupHostReservation = reservation;
    try {
      const peer = this.requireRelay();
      if (peer.fingerprint !== reservation.relayFingerprint) throw new Error('Hosting admission relay mismatch');
      await relayHostState(this.identity, peer, 'host-stopped', reservation.revision);
    }
    catch (error) { throw new Error('Group relay unreachable or stopped admission unresolved; final snapshot is retained. Retry Stop to resolve the exact reservation and publish.', { cause: error }); }
    reservation.phase = 'stopped';
    await saveAdmission(this.root, reservation);
    this.groupHostReservation = undefined;
  }

  sendCommand(command: string): void {
    if (this.busy) throw new Error('An operation is in progress');
    if (!this.process) throw new Error('Server not running');
    this.process.sendCommand(command);
  }

  async stopServer(): Promise<void> {
    await this.operation('stopServer', () => this.stopServerInsideOperation());
  }

  private async stopServerInsideOperation(): Promise<void> {
      this.playerSamples.clear();
      const server = this.activeServer();
      if (!server) throw new Error('No owned process is running');
      if (!this.process?.pid) {
        this.assertStopped();
        if (!server.group) throw new Error('No owned process is running');
        this.busy = 'stopServer: retrying publication';
        await this.finishGroupHostReservation(server.id);
        await this.park();
        await this.retainCompletedBackup(server);
        return;
      }
      await this.closeGameGateway();
      this.controlledProcess = this.process;
      try {
        await this.process.stop();
        this.groupHostSession?.close(); this.groupHostSession = undefined;
        // createSnapshot returns only after objects, the manifest and their directories are flushed,
        // so the ledger never points at a revision that a power cut could lose.
        await assertServerFileTransactionsComplete(server.serverDir);
        const snapshot = await createSnapshot(server.serverDir, server.storeDir, server.snapshotId);
        if (this.groupHostReservation?.serverId === server.id) {
          this.groupHostReservation.stopped = true; this.groupHostReservation.recoverySnapshot = snapshot.id; this.groupHostReservation.phase = 'snapshot-retained';
          await saveAdmission(this.root, this.groupHostReservation);
        }
        await this.ledger().stopHosting(snapshot.id);
        server.snapshotId = snapshot.id;
        await this.persist();
        this.log('Stopped cleanly and committed final snapshot ' + snapshot.id);
      } catch (error) {
        await this.ledger().markUncertain();
        throw error;
      } finally {
        this.controlledProcess = undefined;
      }
      if (server.group) {
        // A captured group Stop includes publication. Failure leaves custody unavailable and is not success.
        this.busy = 'stopServer: publishing';
        await this.finishGroupHostReservation(server.id);
        await this.park();
      }
      await this.retainCompletedBackup(server);
  }

  async createSnapshot(): Promise<void> {
    this.assertStopped();
    await this.operation('createSnapshot', async () => {
      const server = this.activeServer();
      if (!server) throw new Error('No server imported');
      const owner = await this.ledger().status();
      if (owner.state !== 'owned' || owner.owner !== this.identity.fingerprint) throw new Error('Snapshot requires safely held ownership');
      await assertModInstallComplete(server.serverDir);
      await assertServerFileTransactionsComplete(server.serverDir);
      const snapshot = await createSnapshot(server.serverDir, server.storeDir, server.snapshotId);
      await this.ledger().updateSnapshot(snapshot.id);
      server.snapshotId = snapshot.id;
      await this.persist();
      this.log('Verified snapshot ' + snapshot.id);
      await this.retainCompletedBackup(server);
    });
  }

  async listSnapshots(): Promise<Array<{ id: string; parentId: string | null; fileCount: number; bytes: number; current: boolean }>> {
    const server = this.activeServer();
    if (!server) return [];
    const rows: Array<{ id: string; parentId: string | null; fileCount: number; bytes: number; current: boolean }> = [];
    const seen = new Set<string>();
    let id: string | null = server.snapshotId;
    while (id && rows.length < 1000) {
      if (seen.has(id)) throw new Error('Snapshot history contains a cycle');
      seen.add(id);
      let manifest: SnapshotManifest;
      try { manifest = await readSnapshot(server.storeDir, id); }
      catch (error) { if (rows.length && (error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
      rows.push({ id, parentId: manifest.parentId, fileCount: manifest.files.length,
        bytes: manifest.files.reduce((sum, file) => sum + file.size, 0), current: id === server.snapshotId });
      id = manifest.parentId;
    }
    return rows;
  }

  async restoreSnapshot(snapshotId: string): Promise<void> {
    this.assertStopped();
    if (typeof snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotId)) throw new Error('Invalid snapshot revision');
    await this.operation('restoreSnapshot', async () => {
      const server = this.activeServer();
      if (!server) throw new Error('No server imported');
      const ledger = this.ledger(), ownership = await ledger.status();
      if (ownership.state !== 'owned' || ownership.owner !== this.identity.fingerprint || ownership.offer) throw new Error('Restore requires stopped, safely held ownership');
      if (ownership.snapshotId !== server.snapshotId) throw new Error('Snapshot revision mismatch; reconcile metadata before restoring');
      await assertModInstallComplete(server.serverDir);
      if (!(await this.listSnapshots()).some((row) => row.id === snapshotId)) throw new Error('Choose a retained revision from this server’s history');
      const serverDir = path.join(this.root, 'managed', 'servers', randomUUID());
      await materializeSnapshot(server.storeDir, snapshotId, serverDir);
      await assertModInstallComplete(serverDir);
      // Restored data is a NEW revision descending from a verified safety copy, not an authority rewind.
      await assertServerFileTransactionsComplete(server.serverDir);
      const safety = await createSnapshot(server.serverDir, server.storeDir, server.snapshotId);
      await assertServerFileTransactionsComplete(serverDir);
      const restored = await createSnapshot(serverDir, server.storeDir, safety.id);
      const current = await ledger.status();
      if (JSON.stringify(current) !== JSON.stringify(ownership)) throw new Error('Ownership changed while preparing restore; nothing activated');
      this.assertStopped();
      await assertModInstallComplete(server.serverDir);
      let authorityAttempted = false;
      try {
        authorityAttempted = true;
        await ledger.updateSnapshot(safety.id);
        server.snapshotId = safety.id;
        await this.persist();
        await ledger.updateSnapshot(restored.id);
        this.replaceActive({ ...server, serverDir, snapshotId: restored.id });
        await this.persist();
        this.modVerificationCache.clear();
        this.log('Restored world into a separate folder. Previous world and safety revision retained: ' + safety.id);
      } catch (error) {
        if (authorityAttempted) await ledger.markUncertain();
        throw error;
      }
    });
  }

  /** Read-only, authenticated exact evidence. Unreachable authorities throw: unknown is not idle. */
  async groupRecoveryStatus() {
    const server = this.requireActive();
    if (!server.group) throw new Error('No hosting group is bound to this world');
    const admission = await readAdmission(this.root, server.id);
    if (admission && (admission.deviceId !== this.identity.fingerprint || admission.relayFingerprint !== server.group.fingerprint)) throw new Error('Recovery journal binding mismatch');
    const remote = await relayRecoveryStatus(this.identity, this.requireRelay());
    return { serverId: server.id, groupFingerprint: server.group.fingerprint, admission, remote };
  }

  async recoverStopped(confirmedStopped: boolean): Promise<void> {
    this.assertStopped();
    if (!confirmedStopped) throw new Error('Confirm all previous server processes are stopped');
    await this.operation('recoverStopped', async () => {
      const server = this.activeServer();
      if (!server) throw new Error('No server imported');
      const ledger = this.ledger(); let state = await ledger.status();
      if (server.group && state.owner === this.identity.fingerprint && ['offered', 'uncertain'].includes(state.state) && state.offer?.target === this.requireRelay().fingerprint) {
        const receipt = await relayWithdrawOffer(this.identity, this.requireRelay(), state.offer);
        await ledger.reconcileRecoveryOffer(state.offer, this.requireRelay().fingerprint, receipt.disposition);
        state = await ledger.status();
        if (receipt.disposition === 'accepted') { this.log('The relay had already accepted the exact offer. Transfer reconciled; this PC was not restored or started.'); return; }
      }
      if (state.owner !== this.identity.fingerprint || state.state !== 'uncertain' || state.offer) {
        throw new Error('Cannot recover transferred or pending-offer authority. Reconcile with the peer.');
      }
      const reservation = this.groupHostReservation ?? await readAdmission(this.root, server.id);
      if (server.group && (!reservation || reservation.serverId !== server.id ||
          reservation.deviceId !== this.identity.fingerprint || !reservation.attempted ||
          reservation.relayFingerprint !== this.requireRelay().fingerprint ||
          reservation.revision.generation !== state.generation || reservation.revision.lineage !== state.lineage ||
          (!reservation.stopped && reservation.recoverySnapshot !== state.snapshotId && reservation.revision.snapshotId !== state.snapshotId))) {
        // Only this acknowledged admission is recoverable. Restart/lost Start acknowledgment
        // requires a separate authenticated durable recovery handshake, not a guessed UUID.
        throw new Error('Exact acknowledged local hosting reservation is unavailable; group admission recovery is blocked.');
      }
      let cancelledObservation = false;
      if (server.group) {
        const remote = await relayRecoveryStatus(this.identity, this.requireRelay());
        const observation = remote.observation;
        if (!observation || observation.reservation !== reservation!.revision.reservation || observation.generation !== reservation!.revision.generation ||
            observation.snapshotId !== reservation!.revision.snapshotId || observation.lineage !== reservation!.revision.lineage) throw new Error('Exact group admission recovery evidence is unavailable');
        // A durable 'cancelled' observation is authenticated exact evidence that this reservation was
        // explicitly released after its acknowledgment was lost. It is recoverable — but only through
        // the cancellation itself: the protocol refuses host-stopped from a cancelled reservation, so a
        // recovery must never fabricate a stopped state.
        cancelledObservation = observation.state === 'cancelled';
      }
      await assertModInstallComplete(server.serverDir);
      await assertServerFileTransactionsComplete(server.serverDir);
      const snapshot = await createSnapshot(server.serverDir, server.storeDir, state.snapshotId);
      server.snapshotId = snapshot.id;
      await this.persist();
      if (server.group) {
        if (cancelledObservation) { reservation!.recoverySnapshot = snapshot.id; reservation!.phase = 'cancelled'; }
        else { reservation!.stopped = true; reservation!.recoverySnapshot = snapshot.id; reservation!.phase = 'snapshot-retained'; }
        await saveAdmission(this.root, reservation!); this.groupHostReservation = reservation!;
      }
      await ledger.recoverStopped(true);
      await ledger.updateSnapshot(snapshot.id);
      if (server.group) {
        if (cancelledObservation) {
          // Re-acknowledge the exact cancellation (idempotent for the relay's allowed starting/cancelled
          // states) instead of a fabricated 'stopped' the protocol refuses. Local authority returns to this
          // device with the exact verified snapshot; no foreign recovery is attempted or permitted.
          try { await relayHostState(this.identity, this.requireRelay(), 'host-cancel', reservation!.revision); }
          catch (error) {
            await ledger.markUncertain();
            throw new Error('Exact group cancellation acknowledgment is unresolved; the final snapshot is retained. Retry explicit stopped-process recovery.', { cause: error });
          }
          this.groupHostReservation = undefined;
        } else {
          // The original admitted revision remains the protocol target, not the new snapshot.
          // Preserve its UUID for idempotent retry if the stopped acknowledgment is lost.
          reservation!.stopped = true;
          try { await this.finishGroupHostReservation(server.id); }
          catch (error) {
            await ledger.markUncertain();
            throw new Error('Exact group stopped admission unresolved; final snapshot is retained. Retry explicit stopped-process recovery with confirmation.', { cause: error });
          }
        }
      }
      this.log('Explicit stopped-process recovery completed with verified snapshot ' + snapshot.id + '. No uncertain remote takeover was performed.');
    });
  }

  /**
   * Delete old execution directories, interrupted staging, and revisions older than the current one and its two
   * parents. The current server directory and every revision the ledger references are always kept.
   */
  async cleanUp(): Promise<CleanUpResult> {
    this.assertStopped();
    return this.operation('cleanUp', async () => {
      const server = this.activeServer();
      if (!server) throw new Error('No server imported');
      const ownership = await this.ledger().status();
      if (ownership.state === 'hosting' || ownership.state === 'uncertain') {
        throw new Error('Cleanup is blocked while ownership is uncertain or hosting. Recover or stop first.');
      }
      let serverDirsRemoved = 0;
      const serversDir = path.join(this.root, 'managed', 'servers');
      // Folders still used by any library entry are never cleanup targets.
      const inUse = new Set(this.saved.servers.map((entry) => entry.serverDir));
      if ([...inUse].some((dir) => path.dirname(dir) === serversDir)) {
        for (const name of await readdir(serversDir)) {
          const entry = path.join(serversDir, name);
          if (inUse.has(entry)) continue;
          const stat = await lstat(entry);
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unexpected entry in managed servers; refusing cleanup: ${name}`);
          await rm(entry, { recursive: true });
          serverDirsRemoved++;
        }
      }
      for (const name of await readdir(server.storeDir)) {
        if (/^\.(?:staging|transfer)-/u.test(name)) await rm(path.join(server.storeDir, name), { recursive: true, force: true });
      }
      const keep = [...new Set([server.snapshotId, ownership.snapshotId, ...(ownership.offer ? [ownership.offer.snapshotId] : []), ...(await this.retainedRevisions())])];
      const pruned = await pruneStore(server.storeDir, { keep, ancestors: CLEANUP_ANCESTORS });
      this.log(`Cleanup removed ${serverDirsRemoved} old server folder(s), ${pruned.snapshotsRemoved} old revision(s) and ${pruned.objectsRemoved} unused object(s) (${(pruned.bytesFreed / 1024 ** 2).toFixed(1)} MiB of objects).`);
      return { serverDirsRemoved, ...pruned };
    });
  }

  // ---------------------------------------------------------------- mods

  async searchMods(input: { query: string; offset: number; sort?: ModSort }) {
    const server = this.activeServer();
    if (!server) throw new Error('No server imported');
    const index = await readModIndex(server.serverDir);
    const target = await modTarget(server.serverDir, index);
    assertModTarget(target);
    const page = await (this.options.modrinth ?? new ModrinthClient()).search(input.query, input.offset, target, 20, input.sort);
    const mods = [...await indexedMods(server.serverDir, 'server', index), ...await indexedMods(server.serverDir, 'client', index)];
    const installed = new Set(mods.flatMap((mod) => mod.source ? [mod.source.projectId] : []));
    return { ...page, hits: page.hits.map((hit) => ({ ...hit, installed: installed.has(hit.projectId) })) };
  }

  /** Setup guide: browse Fabric mods for a world that does not exist yet. Read-only; nothing is downloaded. */
  async searchSetupMods(input: { query: string; gameVersion: string; offset: number; sort?: ModSort }) {
    if (!input || !isGameVersion(input.gameVersion)) throw new Error('Choose a Minecraft version first');
    return (this.options.modrinth ?? new ModrinthClient()).search(input.query, input.offset, { loader: 'fabric', gameVersion: input.gameVersion }, 20, input.sort);
  }

  /** Setup guide: install the mods picked while creating a Fabric world, each with its required dependencies.
   * One mod that cannot be installed does not stop the others; failures are reported by name. */
  async setupFabricMods(input: { projectIds: string[] }): Promise<{ installed: string[]; failed: Array<{ projectId: string; reason: string }> }> {
    this.assertStopped();
    if (!input || !Array.isArray(input.projectIds) || input.projectIds.length > 50 || !input.projectIds.every(isProjectKey)) throw new Error('Invalid mod selection');
    const projectIds = [...new Set(input.projectIds)];
    return this.operation('setupFabricMods', async () => {
      const server = await this.requireEditableServer();
      const target = await modTarget(server.serverDir, await readModIndex(server.serverDir));
      if (target.loader !== 'fabric') throw new Error('Mods can be added while creating a Fabric world');
      const client = this.options.modrinth ?? new ModrinthClient();
      const installed: string[] = [], failed: Array<{ projectId: string; reason: string }> = [];
      for (const projectId of projectIds) {
        try {
          const result = await installMod(server.serverDir, path.join(this.root, 'mod-downloads'), client, { projectId });
          installed.push(...result.installed.map((mod) => mod.title));
        } catch (error) { failed.push({ projectId, reason: String((error as Error).message).slice(0, 240) }); }
      }
      if (installed.length) this.log(`Installed ${installed.length} verified Modrinth mod(s) for the new world, including required dependencies.`);
      return { installed, failed };
    });
  }

  async saveModTarget(input: { loader: string; gameVersion: string }): Promise<void> {
    this.assertStopped();
    if (!input || !isModLoader(input.loader)) throw new Error('Invalid mod loader');
    if (!isGameVersion(input.gameVersion)) throw new Error('Invalid Minecraft version');
    const target = { loader: input.loader, gameVersion: input.gameVersion };
    await this.operation('saveModTarget', async () => {
      const server = await this.requireEditableServer();
      const index = await readModIndex(server.serverDir);
      await writeModIndex(server.serverDir, { ...index, target });
    });
  }

  async installMod(input: InstallModInput) {
    this.assertStopped();
    return this.operation('installMod', async () => {
      const server = await this.requireEditableServer();
      const result = await installMod(server.serverDir, path.join(this.root, 'mod-downloads'), this.options.modrinth ?? new ModrinthClient(), input);
      if (result.installed.length) this.log(`Installed ${result.installed.length} verified Modrinth mod(s), including required dependencies. They travel with the next snapshot.`);
      return result;
    });
  }

  /** Mods change the world's files, so they follow the same rule as snapshots: stopped, and owned by this PC. */
  private async requireEditableServer(): Promise<SavedServer> {
    const server = this.activeServer();
    if (!server) throw new Error('No server imported');
    const ownership = await this.ledger().status();
    if (ownership.state !== 'owned' || ownership.owner !== this.identity.fingerprint) {
      throw new Error('Mods can only change while this PC safely holds ownership of the stopped server');
    }
    // Fail closed for mod mutations, but never make optional metadata a lifecycle dependency.
    await assertModInstallComplete(server.serverDir);
    await readModIndex(server.serverDir);
    await ordinaryDirectory(modsDirectory(server.serverDir, 'server'), false);
    await ordinaryDirectory(modsDirectory(server.serverDir, 'client'), false);
    return server;
  }

  /** Server mods go into mods/; client mods go into the client pack, which the server never loads. */
  async addMods(kind: ModKind, files: string[]): Promise<string[]> {
    this.assertStopped();
    return this.operation('addMods', async () => {
      const server = await this.requireEditableServer();
      const added = await addMods(server.serverDir, kind, files);
      this.log(`Added ${added.length} ${kind} mod(s): ${added.join(', ')}. ${kind === 'server' ? 'They load on the next start.' : 'Export the client pack to share them with players.'}`);
      return added;
    });
  }

  async removeMod(kind: ModKind, name: string): Promise<void> {
    this.assertStopped();
    await this.operation('removeMod', async () => {
      const server = await this.requireEditableServer();
      const index = await readModIndex(server.serverDir);
      await removeMod(server.serverDir, kind, name);
      if (index.mods.some((mod) => mod.kind === kind && mod.name === name)) await writeModIndex(server.serverDir, { ...index, mods: index.mods.filter((mod) => mod.kind !== kind || mod.name !== name) });
      this.log(`Removed ${kind} mod ${name}. Earlier snapshots still contain it.`);
    });
  }

  /** Read-only, so it is allowed while hosting and on any PC that has the files. */
  async exportClientPack(destination: string): Promise<{ mods: number; bytes: number }> {
    return this.operation('exportClientPack', async () => {
      const server = this.activeServer();
      if (!server) throw new Error('No server imported');
      await assertModInstallComplete(server.serverDir);
      await readModIndex(server.serverDir);
      const result = await exportClientPack(server.serverDir, destination);
      this.log(`Exported ${result.mods} client mod(s) to ${destination}.`);
      return result;
    });
  }

  /** Global, local-only membership overview. Never selects or opens a world, nor contacts a helper. */
  async listHostingGroups(localHelperFingerprints: readonly string[] = []) {
    if (!Array.isArray(localHelperFingerprints) || !localHelperFingerprints.every(fingerprintOK)) throw new Error('Invalid local helper fingerprint');
    const local = new Set(localHelperFingerprints);
    const groups = new Map<string, { fingerprint: string; name: string; serverId: string | null; serverName: string | null; pending: boolean; localAuthority: boolean }>();
    for (const server of this.saved.servers) {
      if (!server.group) continue;
      const fingerprint = server.group.fingerprint;
      if (!fingerprintOK(fingerprint)) throw new Error('Invalid hosting group fingerprint');
      if (!groups.has(fingerprint)) groups.set(fingerprint, { fingerprint, name: this.groupReadback(server.group).name,
        serverId: server.id, serverName: server.name, pending: false, localAuthority: local.has(fingerprint) });
    }
    for (const group of this.saved.pendingGroups) {
      const fingerprint = group.fingerprint;
      if (!fingerprintOK(fingerprint)) throw new Error('Invalid hosting group fingerprint');
      if (!groups.has(fingerprint)) groups.set(fingerprint, { fingerprint, name: this.groupReadback(group, group.relayName).name,
        serverId: null, serverName: null, pending: true, localAuthority: local.has(fingerprint) });
    }
    return [...groups.values()];
  }

  // ---------------------------------------------------------------- friends

  async createInvite() {
    return this.operation('createInvite', () => relayInvite(this.identity, this.requireRelay()));
  }

  /**
   * Legacy invitation protocol, kept backward compatible for internal callers: it never silently replaces the group
   * this PC already belongs to, and it never binds the selected world — a group accepted without an explicit target
   * stays a separate pending group until an explicit download/claim creates its new library server.
   */
  async joinWithInvite({ code, name }: { code: string; name: string }): Promise<{ relayName: string }> {
    this.assertStopped();
    const invite = decodeInvite(code);
    const memberName = friendName(name);
    if (invite.relayFingerprint === this.identity.fingerprint) throw new Error('Cannot join your own relay');
    return this.operation('joinWithInvite', async () => {
      const known = [...new Set([...this.saved.servers.flatMap((entry) => entry.group ? [entry.group.fingerprint] : []),
        ...this.saved.pendingGroups.map((entry) => entry.fingerprint)])];
      if (known.length > 0 && !known.includes(invite.relayFingerprint)) {
        throw new Error('This PC already uses another relay. Clear it explicitly in Settings before joining a different relay.');
      }
      const result = await this.enrollGroup({ code, invite, memberName, target: null, adoptable: true });
      return { relayName: result.relayName };
    });
  }

  /**
   * Accept an invitation for a hosting group and record where it belongs locally. This is the exact seam for main's
   * per-server helper and AccountIntegration:
   * - `serverId` present: only the CURRENTLY SELECTED server may be targeted (a stale id fails closed); the group is
   *   bound to that one world and to nothing else. An id already bound to another group is refused, never replaced.
   * - `serverId` absent or null: membership only. If a local world is already bound to the same group it is returned;
   *   otherwise the group is stored as a separate pending entry. No world is created, downloaded, started or changed.
   * A definitive refusal from the pinned relay surfaces unchanged (`code = 'PEER_AUTHORIZATION_DENIED'`, not retryable),
   * so AccountIntegration can mark the request declined instead of retrying it.
   */
  async joinHostingGroup(input: { code: string; name: string; serverId?: string | null; parkOnStop?: boolean; adoptable?: boolean }): Promise<HostingGroupJoinResult> {
    this.assertStopped();
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.code !== 'string' || typeof input.name !== 'string' ||
        (input.parkOnStop !== undefined && typeof input.parkOnStop !== 'boolean') || (input.adoptable !== undefined && typeof input.adoptable !== 'boolean') ||
        (input.serverId !== undefined && input.serverId !== null && typeof input.serverId !== 'string')) {
      throw new Error('Invalid invite code or friend name');
    }
    const invite = decodeInvite(input.code);
    const memberName = friendName(input.name);
    if (invite.relayFingerprint === this.identity.fingerprint) throw new Error('Cannot join your own relay');
    let target: SavedServer | null = null;
    if (input.serverId !== undefined && input.serverId !== null) {
      if (!isServerId(input.serverId)) throw new Error('Invalid server id');
      target = this.selectedServer(input.serverId);
      if (target.group && target.group.fingerprint !== invite.relayFingerprint) {
        throw new Error('This server already belongs to another hosting group. Clear it explicitly before joining a different group.');
      }
    }
    return this.operation('joinHostingGroup', () => this.enrollGroup({ code: input.code, invite, memberName, target, parkOnStop: input.parkOnStop, adoptable: input.adoptable === true }));
  }

  /** Redeem the pinned invitation, then persist the group's local association atomically (peers + binding or pending). */
  private async enrollGroup(input: { code: string; invite: Invite; memberName: string; target: SavedServer | null; parkOnStop?: boolean; adoptable: boolean }): Promise<HostingGroupJoinResult> {
    const previousPeers = this.saved.peers;
    const previousPending = this.saved.pendingGroups;
    const targetGroup = input.target ? input.target.group : undefined;
    const joined = await joinRelayInvite(this.identity, input.code, input.memberName);
    const peer = validatePeer({ name: joined.relayName, fingerprint: input.invite.relayFingerprint, host: input.invite.host, port: input.invite.port });
    // Re-verify the target after the await: a switch mid-enrollment must never rebind a different world.
    if (input.target && (!this.saved.servers.includes(input.target) || input.target.group !== targetGroup)) {
      throw new Error('The selected server changed. Refresh before continuing.');
    }
    this.saved.peers = [...previousPeers.filter((entry) => entry.fingerprint !== peer.fingerprint), peer];
    let serverId: string | null = null;
    if (input.target) {
      input.target.group = { fingerprint: peer.fingerprint, parkOnStop: targetGroup?.parkOnStop ?? input.parkOnStop ?? true };
      this.saved.pendingGroups = previousPending.filter(group => group.fingerprint !== peer.fingerprint);
      serverId = input.target.id;
    } else {
      const bound = this.saved.servers.find((entry) => entry.group?.fingerprint === peer.fingerprint);
      if (bound) serverId = bound.id;
      else {
        const existing = this.saved.pendingGroups.find((entry) => entry.fingerprint === peer.fingerprint);
        this.saved.pendingGroups = [...this.saved.pendingGroups.filter((entry) => entry.fingerprint !== peer.fingerprint),
          { fingerprint: peer.fingerprint, parkOnStop: existing?.parkOnStop ?? input.parkOnStop ?? true, relayName: joined.relayName,
            since: existing?.since ?? Date.now(), adoptable: existing?.adoptable ?? input.adoptable }];
      }
    }
    try { await this.persist(); }
    catch (error) {
      this.saved.peers = previousPeers;
      this.saved.pendingGroups = previousPending;
      if (input.target) input.target.group = targetGroup ?? null;
      throw new Error('The relay enrolled this PC, but its local settings could not be saved. Retry the same invite on this PC.', { cause: error });
    }
    this.log(`Joined ${joined.relayName} as ${input.memberName}. Nothing was downloaded or started.`);
    return { relayName: joined.relayName, fingerprint: peer.fingerprint, serverId, pending: serverId === null };
  }

  /** One-click pairing with an always-on PC: find it on this network from its short code, join it, and turn on
   * the shared player address for this PC. The code is the only thing the user types. */
  async pairAlwaysOn({ code, name }: { code: string; name: string }, find: (code: string) => Promise<FoundAlwaysOn> = findAlwaysOnPC): Promise<{ relayName: string; gatewayOn: boolean }> {
    this.assertStopped();
    normalizePairingCode(code);
    const found = await find(code);
    if (found.fingerprint === this.identity.fingerprint) throw new Error('That code belongs to this PC. Type it on your gaming PC instead.');
    const invitation = await pairingInvite(code, found);
    // The selected world, when there is one, is the world this user is pairing; otherwise the group stays pending.
    const joined = await this.joinHostingGroup({ code: invitation, name, serverId: this.activeServer()?.id ?? null, adoptable: true });
    let gatewayOn = false;
    if (found.gamePort !== null) {
      try {
        const port = this.activeServer() ? await readServerPort(this.activeServer()!.serverDir) : 25565;
        await this.saveGameGateway({ enabled: true, localPort: port });
        gatewayOn = true;
      } catch (error) { this.log('Paired, but the shared player address could not be turned on: ' + String((error as Error).message)); }
    }
    return { relayName: joined.relayName, gatewayOn };
  }

  /** The always-on PC's public address, controlled from this member PC. */
  async publicAddress(op: 'public-status' | 'public-enable' | 'public-disable') {
    const status = await relayPublic(this.identity, this.requireRelay(), op);
    // The public address reaches whoever hosts only through each host's link to the always-on PC, so the one
    // button turns that link on here as well (only while stopped; it starts with the server).
    if (op !== 'public-disable' && status.state !== 'off' && status.state !== 'error' && status.state !== 'unsupported') {
      const gateway = await readGameGateway(this.root);
      if (!gateway.error && !gateway.enabled && !this.busy && isStoppedState(this.process?.state)) {
        const server = this.activeServer();
        await this.saveGameGateway({ enabled: true, localPort: server ? await readServerPort(server.serverDir) : 25565 }).catch((error) => this.log('Public address is on, but this PC’s link to the always-on PC could not be turned on: ' + String((error as Error).message)));
      }
    }
    return status;
  }

  async createInviteFor(fingerprint: string) {
    return this.operation('createInviteFor', () => relayInviteFor(this.identity, this.requireRelay(), fingerprint));
  }

  /** Self-revocation is authoritative at the pinned relay; local state is cleaned only after durable readback. */
  async leaveGroup(id: string | null, fingerprint: string) {
    if (!fingerprintOK(fingerprint)) throw new Error('Invalid hosting group');
    return this.operation('leaveGroup', async () => {
      this.assertStopped();
      const bound = this.saved.servers.filter(server => server.group?.fingerprint === fingerprint);
      if (bound.length > 1) throw new Error('Another local server uses this group; leave is blocked');
      const server = id === null ? null : this.selectedServer(id);
      if (server ? server.group?.fingerprint !== fingerprint : bound.length !== 0 || !this.saved.pendingGroups.some(group => group.fingerprint === fingerprint)) throw new Error('The server or pending group changed; refresh before leaving');
      if (server) {
        const custody = await new OwnershipLedger(server.ledgerFile, this.identity.fingerprint).status();
        if (custody.state !== 'transferred') throw new Error('Stop and publish or hand off this world before leaving; local custody is unresolved');
      }
      const peer = this.saved.peers.find(entry => entry.fingerprint === fingerprint);
      if (!peer) throw new Error('Pinned group relay is unavailable; local membership retained');
      const previous = server?.group, previousPending = this.saved.pendingGroups;
      await relayLeaveGroup(this.identity, peer);
      if (server && (this.selectedServer(id!) !== server || server.group !== previous)) throw new Error('The selected group changed after leave; refresh to finish cleanup');
      if (server) server.group = null;
      this.saved.pendingGroups = previousPending.filter(group => group.fingerprint !== fingerprint);
      try { await this.persist(); }
      catch (error) {
        if (server) server.group = previous!;
        this.saved.pendingGroups = previousPending;
        throw new Error('Membership was revoked, but local cleanup could not be saved. Retry Leave on this PC.', {cause:error});
      }
      if (server) await this.closeGameGateway();
      return {left:true,serverId:id,fingerprint};
    });
  }

  async checkGroupDisband(id: string, fingerprint: string) {
    const server = await this.editableServer(id);
    if (server.group?.fingerprint !== fingerprint) throw new Error('The selected server’s group changed. Refresh before continuing.');
    if (this.saved.servers.some(other => other !== server && other.group?.fingerprint === fingerprint)) throw new Error('Another local server uses this group. Disbanding is blocked to protect its hosting role.');
    const peer = this.requireRelay();
    let status;
    try { status = await relayDisbandStatus(this.identity, peer); }
    catch (error) { throw new Error('Group-wide disband is unavailable: only the group owner can do this, and the relay must be online and support verified revocation. No local detach was performed.', { cause: error }); }
    if (this.selectedServer(id) !== server || server.group?.fingerprint !== fingerprint) throw new Error('The selected server changed.');
    return status;
  }

  async disbandGroup(id: string, fingerprint: string) {
    return this.operation('disbandGroup', async () => {
      const status = await this.checkGroupDisband(id, fingerprint);
      const server = this.selectedServer(id), previous = server.group;
      if (!status.disbanded) {
        try { await relayDisbandGroup(this.identity, this.requireRelay()); }
        catch (error) { throw new Error('Disband was not verified. The group may already be revoked; check its status before retrying. The local association and all world files are retained.', { cause: error }); }
      }
      await this.editableServer(id);
      if (server.group !== previous) throw new Error('The selected group changed after revocation. Refresh before continuing.');
      const previousPending = this.saved.pendingGroups;
      server.group = null;
      this.saved.pendingGroups = previousPending.filter(group => group.fingerprint !== fingerprint);
      try { await this.persist(); }
      catch (error) { server.group = previous; this.saved.pendingGroups = previousPending; throw new Error('The group is revoked, but its local association could not be saved. Retry to verify revocation and finish local cleanup.', { cause: error }); }
      await this.closeGameGateway();
      return { disbanded: true, serverId: id, fingerprint };
    });
  }

  /**
   * Create an invitation for the group the user APPROVED — a pinned relay fingerprint captured before any
   * awaited directory lookup — instead of whatever happens to be selected when the lookup completes. Refuses
   * stale context: the group must still be one of this PC's groups and, when a server was part of the approval,
   * that server must still carry this exact group.
   */
  async createInviteForGroup(groupFingerprint: string, fingerprint: string, serverId: string | null = null) {
    if (typeof groupFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(groupFingerprint)) throw new Error('Invalid hosting group');
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid peer fingerprint');
    if (serverId !== null && !isServerId(serverId)) throw new Error('Invalid server id');
    return this.operation('createInviteForGroup', async () => {
      const peer = this.saved.peers.find((entry) => entry.fingerprint === groupFingerprint);
      if (!peer) throw new Error('The hosting group changed. Refresh before inviting again.');
      const stillRecorded = this.saved.servers.some((entry) => entry.group?.fingerprint === groupFingerprint) ||
        this.saved.pendingGroups.some((entry) => entry.fingerprint === groupFingerprint);
      if (!stillRecorded) throw new Error('The hosting group changed. Refresh before inviting again.');
      if (serverId !== null && !this.saved.servers.some((entry) => entry.id === serverId && entry.group?.fingerprint === groupFingerprint)) {
        throw new Error('The selected server’s hosting group changed. Refresh before inviting again.');
      }
      return relayInviteFor(this.identity, peer, fingerprint);
    });
  }

  async removeFriend(fingerprint: string) {
    return this.operation('removeFriend', () => relayRemoveFriend(this.identity, this.requireRelay(), fingerprint));
  }

  async listFriends() {
    // Only the relay can report custody for its lineage; a local world may be unrelated.
    return relayFriends(this.identity, this.requireRelay());
  }

  // ---------------------------------------------------------------- settings and peers

  async saveSettings(settings: Settings): Promise<void> {
    await this.operation('saveSettings', async () => {
      this.saved.settings = validateSettings(settings);
      await this.persist();
      if (settings.persistentAddress) this.log('Persistent-address preference saved. Gateway is unconnected; no routing or public availability is established.');
    });
  }

  async addPeer(input: SavedPeer): Promise<void> {
    const peer = validatePeer(input);
    if (peer.fingerprint === this.identity.fingerprint) throw new Error('Cannot trust your own identity as a peer');
    await this.operation('addPeer', async () => {
      await this.closeGameGateway();
      this.saved.peers = this.saved.peers.filter((existing) => existing.fingerprint !== peer.fingerprint);
      this.saved.peers.push(peer);
      await this.persist();
      if (this.listener) {
        // Restart so the listener's pin set includes the new peer.
        const port = this.listener.port;
        await this.listener.close();
        this.listener = undefined;
        await this.listen(port);
      }
      this.log('Saved trusted peer ' + peer.name + '. Fingerprint trust does not establish connectivity.');
    });
  }

  /** Choose (or clear) the always-on group of the SELECTED world. With no world yet, the choice is the PC's single
   *  pending group, which continues onto the first world added later. It must already be a trusted peer. */
  async saveRelay(input: RelayConfig | null): Promise<void> {
    const relay = validateRelayConfig(input);
    if (relay && !this.saved.peers.some((peer) => peer.fingerprint === relay.fingerprint)) {
      throw new Error('The relay must be a trusted peer first: add its fingerprint and endpoint under Peers.');
    }
    if (relay?.fingerprint === this.identity.fingerprint) throw new Error('This PC cannot be its own relay');
    await this.operation('saveRelay', async () => {
      await this.closeGameGateway();
      const active = this.activeServer();
      const previous = active ? active.group : this.saved.pendingGroups;
      const previousPending = this.saved.pendingGroups;
      if (active) {
        active.group = relay ? { ...relay } : null;
        if (relay) this.saved.pendingGroups = previousPending.filter(group => group.fingerprint !== relay.fingerprint);
      } else this.saved.pendingGroups = relay ? [{ fingerprint: relay.fingerprint, parkOnStop: relay.parkOnStop,
        relayName: this.saved.peers.find((peer) => peer.fingerprint === relay.fingerprint)?.name ?? 'Relay', since: Date.now(), adoptable: true }] : [];
      try { await this.persist(); }
      catch (error) {
        if (active) active.group = previous as RelayConfig | null;
        this.saved.pendingGroups = previousPending;
        throw error;
      }
      if (relay) this.log(`Relay set to ${this.relayPeer()?.name ?? 'the relay'}${active ? ` for ${active.name}` : ''}${relay.parkOnStop ? '; the server is parked there after each clean stop' : ''}.`);
      else this.log(active ? `Relay cleared for ${active.name}.` : 'Relay cleared.');
    });
  }

  private async listen(port = 0): Promise<void> {
    this.listener = await listenPeer(this.identity, this.saved.peers.map((peer) => peer.fingerprint),
      (socket, source) => { void this.handleIncoming(socket, source); }, { host: '127.0.0.1', port });
  }

  async startPeerListener(): Promise<void> {
    await this.operation('startPeerListener', async () => {
      if (this.listener) throw new Error('Peer listener already active');
      await this.listen();
      this.log('Peer listener is loopback-only for local testing. No public or LAN connectivity is claimed.');
    });
  }

  // ---------------------------------------------------------------- replication and handoff

  async sendSnapshot(fingerprint: string): Promise<unknown> {
    this.assertStopped();
    return this.operation('sendSnapshot', async () => {
      const peer = this.saved.peers.find((entry) => entry.fingerprint === fingerprint), server = this.activeServer();
      if (!peer || !server) throw new Error('Missing peer or imported server');
      if (this.isRelay(peer)) throw new Error('The relay stores the server only through Park; a plain snapshot send is not accepted.');
      const ownership = await this.ledger().status();
      if (ownership.owner !== this.identity.fingerprint || ownership.state !== 'owned') throw new Error('Snapshot send requires safely held ownership');
      const result = await sendSnapshotToPeer(this.identity, peer, server.storeDir, server.snapshotId);
      this.log(`Peer confirmed verified snapshot ${server.snapshotId}; ${result.filesSent} files / ${result.bytesSent} bytes transferred directly. Hosting ownership unchanged.`);
      return result;
    });
  }

  /**
   * Hand hosting to a trusted peer. The first attempt captures a final snapshot and durably fences this device with an
   * offer. If the attempt fails for any reason other than an explicit decline, the same offer can be retried: the
   * recipient re-acknowledges an offer it already committed instead of applying it twice.
   * Handing off to the configured relay is the same as parking on it.
   */
  async handoff(fingerprint: string): Promise<void> {
    this.assertStopped();
    await this.operation('handoff', async () => {
      const peer = this.saved.peers.find((entry) => entry.fingerprint === fingerprint);
      if (!peer) throw new Error('Missing peer or imported server');
      await this.transferOwnership(peer);
    });
  }

  /** Park the stopped server on the always-on relay, so any trusted PC can claim it later, even while this one is off. */
  async parkAtRelay(): Promise<void> {
    this.assertStopped();
    await this.operation('parkAtRelay', () => this.park());
  }

  /** Same-PC helper callback: resolve only the durable enrolled world, never an arbitrary path. */
  async publishStoppedInitialGroup(fingerprint: string, owner = this.identity.fingerprint): Promise<void> {
    if (!this.opened) throw new Error('The bound group owner application is offline or closed');
    if (!fingerprintOK(fingerprint) || owner !== this.identity.fingerprint) throw new Error('Initial publication owner mismatch');
    this.assertStopped();
    await this.operation('publishStoppedInitialGroup', async () => {
      const bindings = this.saved.servers.filter(server => server.group?.fingerprint === fingerprint);
      if (bindings.length !== 1) throw new Error('Initial publication requires one enrolled managed world');
      const previous = this.saved.activeServerId;
      this.saved.activeServerId = bindings[0]!.id;
      try {
        const peer = this.requireRelay();
        const members = await relayFriends(this.identity, peer);
        if (members.owner !== owner) throw new Error('Initial publication requires the enrolled group owner');
        if (await this.reachRelay(peer, 'Initial publication is unavailable.')) return;
        await this.park();
      } finally { this.saved.activeServerId = previous; await this.persist(); }
    });
  }

  /**
   * Best-effort join-address telemetry for the ACTIVE host session: the verified public address (or null to
   * clear). Never fails hosting — a missing session is a quiet no-op and any transport failure is logged.
   */
  async publishHostEndpoint(endpoint: { address: string; verifiedAt: number } | null): Promise<void> {
    const session = this.groupHostSession;
    if (!session) return;
    try {
      if (endpoint !== null && !validHostEndpoint(endpoint)) throw new Error('Invalid join address');
      await session.sendEndpoint(endpoint);
    } catch (error) {
      this.log('Join address telemetry could not be published: ' + String((error as Error)?.message ?? error).slice(0, 300));
    }
  }

  private async park(): Promise<void> {
    await this.transferOwnership(this.requireRelay());
  }

  private isRelay(peer: SavedPeer): boolean {
    return peer.fingerprint === this.selectedGroup()?.relay.fingerprint;
  }

  private async reachRelay(relay: SavedPeer, consequence: string): Promise<RelayStatus | null> {
    try { return await relayStatus(this.identity, relay); }
    catch (error) {
      if (/^Relay refused/.test((error as Error).message)) throw error;
      throw new Error(`The relay is unreachable (${(error as Error).message}). ${consequence}`, { cause: error });
    }
  }

  private async transferOwnership(peer: SavedPeer): Promise<void> {
    const server = this.activeServer();
    if (!server) throw new Error('Missing peer or imported server');
    const relay = this.isRelay(peer);
    // Capture the selected server and its title before any await. Hosting members cannot overwrite the owner title.
    const canonicalName = server.name;
    const target = relay ? 'the relay' : 'the recipient';
    const ledger = this.ledger(), state = await ledger.status();
    let offer: TransferOffer;
    if (state.state === 'offered' && state.owner === this.identity.fingerprint && state.offer) {
      if (state.offer.target !== peer.fingerprint) {
        throw new Error(`A handoff is pending to another peer (${this.nameOf(state.offer.target) ?? 'unknown'}). Retry that peer; a pending offer cannot be redirected.`);
      }
      offer = state.offer;
      this.log(`Retrying the pending handoff of ${offer.snapshotId} to ${target}. This PC stays fenced until it answers.`);
    } else {
      if (state.state !== 'owned' || state.owner !== this.identity.fingerprint) throw new Error('Handoff requires safely held ownership');
      await assertModInstallComplete(server.serverDir);
      // Fencing is only worth it if the relay can actually take the server right now.
      if (relay) {
        const status = await this.reachRelay(peer, 'The server stays on this PC; nothing was changed.');
        if (status && status.pendingStart !== false) throw new Error('Group hosting Start admission is pending or unknown; resolve the exact reservation before Park. Nothing was changed.');
        // Publish the owner-authored canonical title only after local safety checks and a confirmed
        // reachable relay, so unreachable relays keep the wrapped refusal above instead of leaking
        // raw transport errors and local fences stay ahead of any network work.
        const members = await relayFriends(this.identity, peer);
        if (members.owner === this.identity.fingerprint) await relaySetServerName(this.identity, peer, canonicalName);
      }
      await assertServerFileTransactionsComplete(server.serverDir);
      const snapshot = await createSnapshot(server.serverDir, server.storeDir, server.snapshotId);
      await ledger.updateSnapshot(snapshot.id);
      server.snapshotId = snapshot.id;
      await this.persist();
      offer = await ledger.prepareTransfer(peer.fingerprint, snapshot.id);
      this.log(`Source fenced before offering ownership to ${target}. A failed or unanswered attempt keeps it fenced until a retry succeeds or ${target} declines.`);
    }
    let result: Awaited<ReturnType<typeof sendSnapshotToPeer>>;
    try {
      result = await sendSnapshotToPeer(this.identity, peer, server.storeDir, offer.snapshotId, offer,
        relay ? { preface: relayRequest('park') } : {});
    } catch (error) {
      const action = relay ? 'Park on the relay again' : 'Retry the handoff to the same peer';
      throw new Error(`Handoff did not complete (${(error as Error).message}). This PC stays fenced because ${target} may have accepted. ${action}; it will not be applied twice.`, { cause: error });
    }
    if (!result.ownershipAccepted) {
      // A pinned acknowledgment with ownershipAccepted:false is sent only when the recipient committed nothing.
      await ledger.cancelTransfer(offer.id, peer.fingerprint);
      if (relay) {
        const status = await relayStatus(this.identity, peer).catch(() => null);
        const holder = status ? ` It holds generation ${status.generation}${status.ownerName ? `, checked out by ${status.ownerName}` : ''}.` : '';
        this.log('The relay declined the server. Ownership was restored on this PC.');
        throw new Error(`The relay declined the server: this PC's copy is not the newest it has seen.${holder} Ownership was restored on this PC.`);
      }
      this.log('Recipient declined the handoff. Ownership was restored on this PC.');
      throw new Error('Recipient declined the handoff. Ownership was restored on this PC; you can host or offer again.');
    }
    await ledger.confirmTransfer(offer.id, peer.fingerprint);
    this.log(relay
      ? `Parked ${offer.snapshotId} on the relay. Any trusted PC can claim it, even while this one is off.`
      : 'Recipient confirmed verified revision and ownership. Hosting is now blocked on this device.');
  }

  /**
   * Take the server from the RELAY BOUND TO THE SELECTED WORLD. Clicking Claim is the consent, so no second dialog is
   * shown. A claim whose acknowledgment is lost is completed by claiming again; the relay keeps it pending for this PC
   * only. Before any world exists, the single joined group is downloaded into a new library server instead.
   */
  async claimFromRelay(): Promise<void> {
    this.assertStopped();
    const active = this.activeServer();
    if (!active) {
      const pending = this.saved.pendingGroups;
      if (pending.length === 1) {
        const group = pending[0]!;
        await this.operation('claimFromRelay', (token) => this.claimIntoNewServer(group, token));
        return;
      }
      if (pending.length > 1) throw new Error('This PC has joined more than one hosting group. Choose the group to download first.');
    }
    const relay = this.requireRelay();
    await this.operation('claimFromRelay', token => this.claimBoundServer(relay, token));
  }

  private async claimBoundServer(relay: SavedPeer, token: symbol): Promise<void> {
      const me = this.identity.fingerprint;
      const status = await this.reachRelay(relay, 'Nothing was changed.');
      if (!status) throw new Error('The relay holds no server yet. Park one on it from the PC that has it.');
      if (status.state === 'transferred') {
        if (status.owner === me) throw new Error('This PC already holds the server; there is nothing to claim.');
        if (status.hosting) throw new Error(`Start refused: ${status.ownerName ?? 'another PC'} is hosting this group. Nobody else may start or take over.`);
        throw new Error(`The server is checked out by ${status.ownerName ?? 'another PC'}. Hosting status is unknown; only verified stopped publication makes this group available.`);
      }
      if (status.state === 'offered' && status.pendingTarget !== me) {
        throw new Error(`The server is pending checkout to ${status.pendingName ?? 'another PC'}; that PC must retry its claim first.`);
      }
      const canonicalName = (await relayFriends(this.identity, relay)).serverMetadata?.name;
      const socket = await openRelayOperation(this.identity, relay, 'claim');
      let activation: Promise<boolean> | undefined;
      let accepted = false;
      let decline: IncomingPreAcceptanceDecline | undefined;
      try {
        await receiveSnapshot(socket, relay.fingerprint, path.join(this.root, 'managed', 'store'), async (snapshot, source, offer) => {
          try { accepted = await this.considerIncoming(socket, token, snapshot, source, offer, (pending) => { activation = pending; }, { approved: true, canonicalName }); }
          catch (error) { if (!(error instanceof IncomingPreAcceptanceDecline)) throw error; decline = error; }
          return accepted;
        });
      } catch (error) {
        throw new Error(`Claim did not complete (${(error as Error).message}). Nothing was started. A failed download does not grant ownership. If acceptance may have completed, retry this PC's exact claim to reconcile it safely; it is never applied twice.`, { cause: error });
      } finally {
        await activation?.catch((error) => this.log('Claim activation failed: ' + String(error)));
        socket.destroy();
      }
      if (decline) throw decline;
      if (!accepted) throw new Error('The relay sent no ownership offer; nothing changed.');
      this.log('Claimed the server from the relay. Configure this PC\'s launch profile and approve executable/mod trust before starting.');
  }

  /**
   * Download a joined group's world on request, even while OTHER unrelated worlds are in the library: the newest
   * revision is materialized into a NEW library server bound to that group. Existing worlds are never replaced.
   */
  async claimPendingGroup(fingerprint: string): Promise<void> {
    this.assertStopped();
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid hosting group');
    const pending = this.saved.pendingGroups.find((entry) => entry.fingerprint === fingerprint);
    if (!pending) {
      const bound = this.saved.servers.filter((entry) => entry.group?.fingerprint === fingerprint);
      if (bound.length === 1 && this.saved.activeServerId === bound[0]!.id) { await this.claimFromRelay(); return; }
      if (bound.length > 0) throw new Error('That hosting group is already part of this library. Select its server and use Claim instead.');
      throw new Error('This PC has not joined that hosting group. Accept its invitation first.');
    }
    await this.operation('claimPendingGroup', (token) => this.claimIntoNewServer(pending, token));
  }

  /** Claim the group's world into a NEW library server. Never touches the files or ledger of any existing world. */
  private async claimIntoNewServer(group: SavedPendingGroup, token: symbol): Promise<void> {
    const me = this.identity.fingerprint;
    const peer = this.saved.peers.find((entry) => entry.fingerprint === group.fingerprint);
    if (!peer) throw new Error('This hosting group’s always-on PC is missing from trusted peers. Restore its peer entry before claiming.');
    const status = await this.reachRelay(peer, 'Nothing was changed.');
    if (!status) throw new Error('The group holds no server yet. Park one on it from the PC that has it.');
    if (status.state === 'transferred') {
      if (status.owner === me) throw new Error('This PC already holds the server; there is nothing to claim.');
      if (status.hosting) throw new Error(`Start refused: ${status.ownerName ?? 'another PC'} is hosting this group. Nobody else may start or take over.`);
      throw new Error(`The server is checked out by ${status.ownerName ?? 'another PC'}. Hosting status is unknown; only verified stopped publication makes this group available.`);
    }
    if (status.state === 'offered' && status.pendingTarget !== me) {
      throw new Error(`The server is pending checkout to ${status.pendingName ?? 'another PC'}; that PC must retry its claim first.`);
    }
    const canonicalName = (await relayFriends(this.identity, peer)).serverMetadata?.name;
    const socket = await openRelayOperation(this.identity, peer, 'claim');
    let activation: Promise<boolean> | undefined;
    let accepted = false;
    let decline: IncomingPreAcceptanceDecline | undefined;
    try {
      await receiveSnapshot(socket, peer.fingerprint, path.join(this.root, 'managed', 'store'), async (snapshot, source, offer) => {
        try { accepted = await this.considerIncoming(socket, token, snapshot, source, offer, (pending) => { activation = pending; }, { approved: true, appendGroup: group, canonicalName }); }
        catch (error) { if (!(error instanceof IncomingPreAcceptanceDecline)) throw error; decline = error; }
        return accepted;
      });
    } catch (error) {
      throw new Error(`Claim did not complete (${(error as Error).message}). Nothing was started. A failed download does not grant ownership. If acceptance may have completed, retry this PC's exact claim to reconcile it safely; it is never applied twice.`, { cause: error });
    } finally {
      await activation?.catch((error) => this.log('Claim activation failed: ' + String(error)));
      socket.destroy();
    }
    if (decline) throw decline;
    if (!accepted) throw new Error('The group sent no ownership offer; nothing changed.');
    this.log('Claimed the group’s world into a new library server. Configure this PC’s launch profile and approve executable/mod trust before starting.');
  }

  /** What the relay currently holds and who has it checked out. Read-only. */
  async checkRelay(): Promise<RelayStatus | null> {
    return this.reachRelay(this.requireRelay(), 'Nothing was changed.');
  }

  private async handleIncoming(socket: TLSSocket, source: string): Promise<void> {
    try {
      await this.operation('receiveSnapshot', async (token) => {
        let activation: Promise<boolean> | undefined;
        try {
          await receiveSnapshot(socket, source, path.join(this.root, 'managed', 'store'),
            (snapshot, authenticatedSource, offer) => this.considerIncoming(socket, token, snapshot, authenticatedSource, offer,
              (pending) => { activation = pending; }));
        } finally {
          // Drain only activation, not a potentially abandoned native dialog, before releasing the operation.
          await activation?.catch((error) => this.log('Incoming activation failed: ' + String(error)));
        }
      });
    } catch (error) {
      this.log('Peer receive failed: ' + String(error));
    } finally {
      socket.destroy();
    }
  }

  private async materializeIncomingBeforeAuthority(storeDir: string, serverDir: string, snapshot: SnapshotManifest): Promise<void> {
    try {
      await requireFreeSpaceFor(serverDir, snapshot.files.reduce((sum, file) => sum + file.size, 0));
      await materializeSnapshot(storeDir, snapshot.id, serverDir);
    } catch (error) {
      throw new IncomingPreAcceptanceDecline(`Checkout declined before ownership acceptance: ${(error as Error).message}`, { cause: error });
    }
  }

  /**
   * Decide on a verified incoming snapshot. Returning false is a definitive decline (nothing was committed);
   * throwing leaves the sender fenced because authority may or may not have committed.
   * `approved` means the user already consented by starting this transfer (a relay claim).
   */
  private async considerIncoming(socket: TLSSocket, token: symbol, snapshot: SnapshotManifest, authenticatedSource: string,
    offer: TransferOffer | undefined, track: (activation: Promise<boolean>) => void,
    { approved = false, appendGroup = null, canonicalName }: { approved?: boolean; appendGroup?: SavedPendingGroup | null; canonicalName?: string } = {}): Promise<boolean> {
    this.log('Received verified snapshot ' + snapshot.id + ' from ' + (this.nameOf(authenticatedSource) ?? authenticatedSource) + '. Replication alone does not grant hosting ownership.');
    if (!offer) return false;
    if (appendGroup) return this.materializeGroupIncoming(socket, token, snapshot, authenticatedSource, offer, track, appendGroup, canonicalName);
    const previous = this.activeServer(), original = JSON.stringify(this.activeServer());
    let originalAuthority: string | undefined;
    if (previous) {
      const ledger = this.ledger();
      if (offer.target === this.identity.fingerprint && await ledger.hasAccepted(offer.id)) {
        this.log('Re-acknowledged handoff ' + offer.id + ', which this PC already accepted.');
        return true;
      }
      const state = await ledger.statusOrNull();
      this.assertStopped();
      originalAuthority = JSON.stringify(state);
      // The tolerant read exists so state retrieval and claim recovery survive a damaged or absent ledger
      // (see reconcileActivation) - never so an incoming offer can manufacture authority over a world whose
      // local authority is unknown. A missing record is refused explicitly instead of reaching the
      // "no state means accept" branch of canAcceptOffer.
      if (state === undefined) {
        // A missing record is not permission to accept an offer nobody asked for: an unsolicited handoff over a
        // world whose local authority is unknown is still refused. A claim this PC itself started (the user
        // pressed Claim) is the documented recovery path for an interrupted pre-authority append, so it may
        // complete - the relay only offers it to a device it authorises, and the local world is retained.
        if (!approved) throw new Error('This PC has no ownership record for the selected server, so this handoff cannot be verified. Verified replica retained without activation; recover or re-import this server first.');
        this.log('This PC had no ownership record for the selected server; the claim you started applies the offered revision.');
      }
      if (!canAcceptOffer(state, offer, authenticatedSource, this.identity.fingerprint)) {
        throw new Error('Incoming ownership conflicts with this server. Verified replica retained without activation.');
      }
    }
    this.assertStopped();
    const revalidate = (expected: SavedServer | null = previous, metadata: string = original) => {
      try {
        if (this.operationToken !== token || socket.destroyed || socket.readableEnded || socket.writableEnded) throw new Error('Incoming session or operation has ended');
        this.assertStopped();
        if (this.activeServer() !== expected || JSON.stringify(this.activeServer()) !== metadata) throw new Error('Incoming server lineage changed during approval');
      } catch (error) {
        this.log('Incoming handoff activation refused: ' + String(error));
        throw error;
      }
    };
    if (!approved && (!this.options.confirmIncomingHandoff || !await this.options.confirmIncomingHandoff(authenticatedSource, snapshot, offer))) return false;
    revalidate();
    if (previous) {
      const current = await this.ledger().statusOrNull();
      revalidate();
      if (JSON.stringify(current) !== originalAuthority) throw new Error('Incoming ownership changed during approval');
    }
    const storeDir = path.join(this.root, 'managed', 'store');
    const serverDir = path.join(this.root, 'managed', 'servers', randomUUID());
    await this.materializeIncomingBeforeAuthority(storeDir, serverDir, snapshot);
    revalidate();
    const ledgerFile = previous?.ledgerFile ?? path.join(this.root, `ownership-${randomUUID()}.sqlite`);
    const profile = previous ? { ...previous.profile, args: [...previous.profile.args] } : validateLaunchProfile({ executable: '', args: [] }, true);
    const candidate: SavedServer = { id: previous?.id ?? newServerId(), name: previous?.group?.fingerprint === authenticatedSource && canonicalName !== undefined ? canonicalName : previous?.name ?? 'Received server', serverDir, storeDir, snapshotId: snapshot.id, profile, ledgerFile, group: previous?.group ?? null };
    const activation = (async () => {
      let authorityAttempted = false;
      this.replaceActive(candidate);
      // A fresh direct receive journals its append too, so an interruption between the state write and the
      // ownership transaction is distinguishably pre-authority on restart.
      if (!previous) this.saved.activation = { serverId: candidate.id, pending: null, previousActiveServerId: null };
      const candidateMetadata = JSON.stringify(candidate);
      try {
        // Record the candidate (and any activation journal) before authority. Missing/mismatched ledgers fail closed on restart.
        await this.persist();
        revalidate(candidate, candidateMetadata);
        if (previous) {
          const current = await new OwnershipLedger(ledgerFile, this.identity.fingerprint).statusOrNull();
          revalidate(candidate, candidateMetadata);
          if (JSON.stringify(current) !== originalAuthority) throw new Error('Incoming ownership changed before activation');
        }
        authorityAttempted = true;
        await new OwnershipLedger(ledgerFile, this.identity.fingerprint).acceptTransfer(offer, authenticatedSource, snapshot.id);
        if (!previous) { this.saved.activation = null; await this.persist(); }
        else if (this.saved.activation?.serverId === candidate.id) {
          // A retried claim that started as a journalled fresh append just committed; the journal is spent.
          this.saved.activation = null;
          await this.persist();
        }
        // Once authority may have committed, a lost acknowledgment must never roll it back.
        this.log('Accepted ownership of ' + snapshot.id + '. Previous server files retained. Configure a local launch profile and approve executable/mod trust before starting.');
        return true;
      } catch (error) {
        if (!authorityAttempted) { if (!previous) this.saved.activation = null; this.replaceActive(previous); await this.persist(); }
        else this.log('Ownership acceptance may have committed; candidate retained for explicit reconciliation.');
        throw error;
      }
    })();
    track(activation);
    return activation;
  }

  /**
   * Claim a group's world into a NEW library server: append-only and independent of the selected world, whose files and
   * ledger are never read or replaced. The entry is recorded before authority; a pre-authority failure rolls the whole
   * append back, while authority that may have committed is retained for explicit reconciliation.
   */
  private async materializeGroupIncoming(socket: TLSSocket, token: symbol, snapshot: SnapshotManifest, authenticatedSource: string,
    offer: TransferOffer, track: (activation: Promise<boolean>) => void, group: SavedPendingGroup, canonicalName?: string): Promise<boolean> {
    // Clicking Claim is this PC's consent; there is no second dialog and no read of the selected world's ledger.
    this.assertStopped();
    const previousActive = this.saved.activeServerId;
    const previousPending = this.saved.pendingGroups;
    const storeDir = path.join(this.root, 'managed', 'store');
    const serverDir = path.join(this.root, 'managed', 'servers', randomUUID());
    await this.materializeIncomingBeforeAuthority(storeDir, serverDir, snapshot);
    const candidate: SavedServer = { id: newServerId(), name: canonicalName ?? 'Shared server (name unavailable)', serverDir, storeDir, snapshotId: snapshot.id,
      profile: validateLaunchProfile({ executable: '', args: [] }, true), ledgerFile: path.join(this.root, `ownership-${randomUUID()}.sqlite`),
      group: { fingerprint: group.fingerprint, parkOnStop: group.parkOnStop } };
    const assertSession = () => {
      if (this.operationToken !== token || socket.destroyed || socket.readableEnded || socket.writableEnded) throw new Error('Incoming session or operation has ended');
      this.assertStopped();
    };
    const revalidate = () => {
      assertSession();
      if (!this.saved.servers.includes(candidate) || this.saved.activeServerId !== candidate.id) throw new Error('Claimed server entry changed during activation');
    };
    assertSession();
    const activation = (async () => {
      let authorityAttempted = false;
      this.saved.servers.push(candidate);
      this.saved.activeServerId = candidate.id;
      this.saved.pendingGroups = this.saved.pendingGroups.filter((entry) => entry.fingerprint !== group.fingerprint);
      // Journal the append so a crash between this write and the ownership transaction has durable, unambiguous
      // recovery evidence: journal + no ledger row = nothing was accepted and the append rolls back on restart.
      this.saved.activation = { serverId: candidate.id, pending: group, previousActiveServerId: previousActive };
      try {
        // Record the new server and its journal before authority. Missing/mismatched ledgers fail closed on restart.
        await this.persist();
        revalidate();
        authorityAttempted = true;
        await new OwnershipLedger(candidate.ledgerFile, this.identity.fingerprint).acceptTransfer(offer, authenticatedSource, snapshot.id);
        // The acceptance is durable; the journal is spent.
        this.saved.activation = null;
        await this.persist();
        this.log('Accepted ownership of ' + snapshot.id + ' as a new library server. Existing worlds were not changed. Configure a local launch profile and approve executable/mod trust before starting.');
        return true;
      } catch (error) {
        if (!authorityAttempted) {
          this.saved.servers = this.saved.servers.filter((entry) => entry !== candidate);
          this.saved.activeServerId = previousActive;
          this.saved.pendingGroups = previousPending;
          this.saved.activation = null;
          await this.persist();
        } else this.log('Ownership acceptance may have committed; the new server entry is retained for explicit reconciliation.');
        throw error;
      }
    })();
    track(activation);
    return activation;
  }

  async close(): Promise<void> {
    if (this.busy) throw new Error('An operation is in progress; wait before closing');
    clearInterval(this.scheduleTimer); this.scheduleTimer = undefined;
    if (this.scheduleTick) await this.scheduleTick;
    await this.closeGameGateway();
    if (this.process?.pid) await this.stopServer();
    if (this.listener) { await this.listener.close(); this.listener = undefined; }
    this.groupHostSession?.close(); this.groupHostSession = undefined;
    this.opened = false;
  }
}
