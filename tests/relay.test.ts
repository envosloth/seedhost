import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Writable } from 'node:stream';
import { createServer } from 'node:net';
import path from 'node:path';
import { createIdentity, connectPeer, readFrame, writeFrame, type PeerIdentity } from '../src/core/peer-transport.js';
import { SeedHostApplication } from '../src/core/application.js';
import { OwnershipLedger } from '../src/core/ownership.js';
import { RelayNode } from '../src/core/relay.js';
import { relayStatus, relayRecoverCheckout, openRelayOperation, relayRequest } from '../src/core/relay-client.js';
import { createSnapshot } from '../src/core/snapshots.js';
import { receiveSnapshot, sendSnapshotToPeer } from '../src/core/transfers.js';

const fixture = path.resolve('tools/fake-java-server.mjs');
const quiet = () => {};
const held = async (relay: RelayNode) => { await relay.settled(); return relay.custody(); };

async function workspace(t: TestContext, prefix: string) {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/' + prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(source, 'world.bin'), 'original');
  return { root, source };
}
async function startRelay(t: TestContext, root: string, identity?: PeerIdentity, options: { keepRevisions?: number } = {}) {
  const relay = new RelayNode(path.join(root, 'relay'), identity ?? await createIdentity(), { log: quiet, ...options });
  await relay.open();
  await relay.listen();
  t.after(() => relay.close());
  return relay;
}
/** A host app that trusts the relay (and vice versa) and uses it as its relay. */
async function host(t: TestContext, root: string, name: string, relay: RelayNode, identity?: PeerIdentity, confirm = async () => true) {
  const id = identity ?? await createIdentity();
  const app = new SeedHostApplication(path.join(root, name), id, {
    confirmIncomingHandoff: confirm,
    // Explicit local approval for a synthetic process; never a peer-provided runtime.
    resolveGroupLaunchProfile: async () => ({ executable: process.execPath, args: [fixture, '--lifetime-ms=30000'] }),
  });
  await app.open();
  t.after(() => app.close().catch(() => {}));
  await relay.trust(name, id.fingerprint);
  if (!(await app.getState()).peers.some((peer) => peer.fingerprint === relay.identity.fingerprint)) {
    await app.addPeer({ name: 'Relay', fingerprint: relay.identity.fingerprint, ...relay.endpoint! });
  }
  await app.saveRelay({ fingerprint: relay.identity.fingerprint, parkOnStop: false });
  return { app, identity: id };
}
async function profile(app: SeedHostApplication) {
  await app.saveProfile({ executable: process.execPath, args: [fixture, '--lifetime-ms=30000'] });
}
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
test('low-storage group Start leaves the world available for a different member to start', async (t) => {
  const { root, source } = await workspace(t, 'relay-low-storage-start-');
  const relay = await startRelay(t, root);
  const a = (await host(t, root, 'a', relay)).app;
  const b = (await host(t, root, 'b', relay)).app;
  const c = (await host(t, root, 'c', relay)).app;
  await a.importExisting(source, true);
  await a.parkAtRelay();
  const before = await held(relay);
  const fault = t.mock.method(fsPromises, 'statfs', async () => ({ bavail: 0n, bsize: 4096n }));
  syncBuiltinESMExports();
  try { await assert.rejects(b.startGroup(relay.identity.fingerprint, true), (error: Error) => {
    assert.match(error.message, /Insufficient disk space/);
    assert.doesNotMatch(error.message, /keeps the claim pending/, 'failed downloads must not claim they permanently reserved the group');
    return true;
  }); }
  finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.equal((await b.getState()).server, null, 'failed download never accepted ownership');
  assert.deepEqual(await held(relay), before, 'failed download must not leave a pending checkout');
  await c.startGroup(relay.identity.fingerprint, true);
  assert.equal((await c.getState()).server!.state, 'running');
  assert.equal(await world(c), 'original');
  await c.stopServer();
});

test('install-volume disk full after complete definitively declines without pending custody', async (t) => {
  const { root, source } = await workspace(t, 'relay-install-full-');
  const relay = await startRelay(t, root);
  const a = (await host(t, root, 'a', relay)).app;
  const b = (await host(t, root, 'b', relay)).app;
  const c = (await host(t, root, 'c', relay)).app;
  await a.importExisting(source, true);
  await a.parkAtRelay();
  // A verified cached download needs no new transfer bytes, but installation still needs space.
  await cp((await a.getState()).server!.storeDir, path.join(root, 'b', 'managed', 'store'), { recursive: true });
  const fault = t.mock.method(fsPromises, 'statfs', async () => ({ bavail: 0n, bsize: 4096n }));
  syncBuiltinESMExports();
  try { await assert.rejects(b.startGroup(relay.identity.fingerprint, true), /Checkout declined before ownership acceptance: Insufficient disk space/); }
  finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.equal((await b.getState()).server, null, 'no authority or library entry committed');
  assert.equal((await held(relay))!.state, 'owned', 'definitive pre-acceptance refusal releases relay');
  await c.startGroup(relay.identity.fingerprint, true);
  assert.equal((await c.getState()).server!.state, 'running');
  await c.stopServer();
});

test('ENOSPC while installing a returning member preserves its old world and releases checkout', async (t) => {
  const { root, source } = await workspace(t, 'relay-install-enospc-');
  const relay = await startRelay(t, root);
  const a = (await host(t, root, 'a', relay)).app;
  const b = (await host(t, root, 'b', relay)).app;
  const c = (await host(t, root, 'c', relay)).app;
  await a.importExisting(source, true); await a.parkAtRelay();
  await b.claimFromRelay();
  const previous = (await b.getState()).server!;
  await b.parkAtRelay();
  const before = (await b.getState()).server!;
  const createWriteStream = fs.createWriteStream;
  let injected = false;
  const fault = t.mock.method(fs, 'createWriteStream', (filename: Parameters<typeof fs.createWriteStream>[0], ...args: any[]) => {
    const target = String(filename);
    if (target.startsWith(path.join(root, 'b', 'managed', 'servers') + path.sep) && target.includes('.seedhost-staging-')) {
      injected = true;
      return new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('ENOSPC: disk filled during installation'), { code: 'ENOSPC' })); } });
    }
    return createWriteStream(filename, ...args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(b.startGroup(relay.identity.fingerprint, true), /Checkout declined before ownership acceptance: ENOSPC/); }
  finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(injected, true, 'fault reached materialized-file writes, not the disk preflight');
  assert.equal((await b.getState()).server!.serverDir, previous.serverDir);
  assert.deepEqual((await b.getState()).server!.ownership, before.ownership);
  assert.equal(await world(b), 'original', 'previous execution files were retained');
  assert.equal((await held(relay))!.state, 'owned');
  await c.startGroup(relay.identity.fingerprint, true);
  assert.equal((await c.getState()).server!.state, 'running');
  await c.stopServer();
});

test('a decline cannot cancel custody while another checkout stream can still accept', async (t) => {
  const { root, source } = await workspace(t, 'relay-concurrent-decline-');
  const relay = await startRelay(t, root);
  const a = (await host(t, root, 'a', relay)).app;
  const { identity: ib } = await host(t, root, 'b', relay);
  await a.importExisting(source, true); await a.parkAtRelay();
  const other = new RelayNode(path.join(root, 'relay'), relay.identity, { log: quiet });
  await other.open(); await other.listen(); t.after(() => other.close());
  const first = await connectPeer(ib, relay.identity.fingerprint, relay.endpoint!.host, relay.endpoint!.port);
  const second = await connectPeer(ib, other.identity.fingerprint, other.endpoint!.host, other.endpoint!.port);
  t.after(() => { first.destroy(); second.destroy(); });
  const complete = async (socket: typeof first) => {
    await writeFrame(socket, { type: 'relay', version: 1, op: 'claim' });
    const hello = await readFrame(socket) as {fileCount: number; snapshotId: string};
    let count = 0;
    while (count < hello.fileCount) count += (await readFrame(socket) as {files: unknown[]}).files.length;
    await writeFrame(socket, { type: 'need', hashes: [] });
    assert.equal((await readFrame(socket) as {type: string}).type, 'complete');
    return hello.snapshotId;
  };
  try {
    const snapshotId = await complete(first);
    await complete(second);
    await writeFrame(first, { type: 'ack', snapshotId, filesSent: 0, bytesSent: 0, ownershipAccepted: false });
    first.destroy(); await relay.settled();
    assert.equal((await held(relay))!.state, 'offered', 'one decline cannot speak for another callback');
    await writeFrame(second, { type: 'ack', snapshotId, filesSent: 0, bytesSent: 0, ownershipAccepted: true });
    second.destroy(); await other.settled();
    assert.equal((await held(other))!.state, 'transferred');
  } finally { first.destroy(); second.destroy(); }
});

test('owner Start recovers a durable pre-complete checkout after restart and fences its stale sender', async (t) => {
  const { root, source } = await workspace(t, 'relay-owner-recovery-');
  const relay = await startRelay(t, root);
  const { app: a, identity: ia } = await host(t, root, 'a', relay);
  const { identity: ib } = await host(t, root, 'b', relay);
  await relay.setOwner(ia.fingerprint);
  await a.importExisting(source, true);
  await profile(a);
  await a.parkAtRelay();
  const ledger = new OwnershipLedger(path.join(root, 'relay', 'ownership.sqlite'), relay.identity.fingerprint);
  const custody = await ledger.status();
  const abandoned = await ledger.prepareTransfer(ib.fingerprint, custody.snapshotId, true);
  await relay.close();
  await relay.open();
  await relay.listen();
  await a.addPeer({ name: 'Relay', fingerprint: relay.identity.fingerprint, ...relay.endpoint! });
  await a.startGroup(relay.identity.fingerprint, true);
  assert.equal((await a.getState()).server!.state, 'running');
  assert.equal(await ledger.hasWithdrawn(abandoned.id), true);
  await assert.rejects(ledger.markCheckoutAcceptancePossible(abandoned.id, ib.fingerprint), /fenced|changed/);
  await a.stopServer();
});

test('owner member removal recovers only a proven pre-complete checkout', async (t) => {
  const { root, source } = await workspace(t, 'relay-remove-recovery-');
  const relay = await startRelay(t, root);
  const { app: a, identity: ia } = await host(t, root, 'a', relay);
  const { identity: ib } = await host(t, root, 'b', relay);
  await relay.setOwner(ia.fingerprint);
  await a.importExisting(source, true);
  await a.parkAtRelay();
  const ledger = new OwnershipLedger(path.join(root, 'relay', 'ownership.sqlite'), relay.identity.fingerprint);
  const custody = await ledger.status();
  const abandoned = await ledger.prepareTransfer(ib.fingerprint, custody.snapshotId, true);
  await a.removeFriend(ib.fingerprint);
  assert.equal((await held(relay))!.state, 'owned');
  assert.equal(await ledger.hasWithdrawn(abandoned.id), true);
  await assert.rejects(ledger.markCheckoutAcceptancePossible(abandoned.id, ib.fingerprint), /fenced|changed/);
});

test('legacy and acceptance-possible checkouts refuse owner recovery, Start and removal', async (t) => {
  for (const phase of ['legacy', 'acceptance-possible']) await t.test(phase, async (t) => {
    const { root, source } = await workspace(t, 'relay-unknown-checkout-');
    const relay = await startRelay(t, root);
    const { app: a, identity: ia } = await host(t, root, 'a', relay);
    const { identity: ib } = await host(t, root, 'b', relay);
    await relay.setOwner(ia.fingerprint);
    await a.importExisting(source, true);
    await profile(a);
    await a.parkAtRelay();
    const ledger = new OwnershipLedger(path.join(root, 'relay', 'ownership.sqlite'), relay.identity.fingerprint);
    const custody = await ledger.status();
    const offer = await ledger.prepareTransfer(ib.fingerprint, custody.snapshotId, phase !== 'legacy');
    if (phase !== 'legacy') await ledger.markCheckoutAcceptancePossible(offer.id, ib.fingerprint);
    const before = await ledger.status();
    const peer = { fingerprint: relay.identity.fingerprint, ...relay.endpoint! };
    await assert.rejects(relayRecoverCheckout(ib, peer, ib.fingerprint), /Only the group owner/);
    await assert.rejects(relayRecoverCheckout(ia, peer, ib.fingerprint), /possible or unknown/);
    await assert.rejects(a.startGroup(relay.identity.fingerprint, true), /possible or unknown/);
    await assert.rejects(a.removeFriend(ib.fingerprint), /possible or unknown/);
    assert.deepEqual(await ledger.status(), before);
    assert.notEqual((await a.getState()).server!.state, 'running');
    assert.equal(await ledger.hasWithdrawn(offer.id), false);
  });
});

test('independent relay cancellation fences a sender paused immediately before complete', async (t) => {
  const { root, source } = await workspace(t, 'relay-completion-race-');
  const relay = await startRelay(t, root);
  const { app: a, identity: ia } = await host(t, root, 'a', relay);
  const { identity: ib } = await host(t, root, 'b', relay);
  await relay.setOwner(ia.fingerprint);
  await a.importExisting(source, true);
  await a.parkAtRelay();
  const other = new RelayNode(path.join(root, 'relay'), relay.identity, { log: quiet });
  await other.open(); await other.listen(); t.after(() => other.close());
  const socket = await connectPeer(ib, relay.identity.fingerprint, relay.endpoint!.host, relay.endpoint!.port);
  try {
    await writeFrame(socket, { type: 'relay', version: 1, op: 'claim' });
    const hello = await readFrame(socket) as { fileCount: number };
    let count = 0;
    while (count < hello.fileCount) count += (await readFrame(socket) as { files: unknown[] }).files.length;
    const ledger = new OwnershipLedger(path.join(root, 'relay', 'ownership.sqlite'), relay.identity.fingerprint);
    const offer = (await ledger.status()).offer!;
    await assert.rejects(relayRecoverCheckout(ib, { fingerprint: other.identity.fingerprint, ...other.endpoint! }, ib.fingerprint), /Only the group owner/);
    await relayRecoverCheckout(ia, { fingerprint: other.identity.fingerprint, ...other.endpoint! }, ib.fingerprint);
    await writeFrame(socket, { type: 'need', hashes: [] });
    assert.equal((await readFrame(socket) as { type: string }).type, 'error', 'cancelled sender emits no complete frame');
    await relay.settled();
    assert.equal((await ledger.status()).state, 'owned');
    assert.equal(await ledger.hasWithdrawn(offer.id), true);
  } finally { socket.destroy(); }
});

test('a failed ownership commit is not misclassified as an installation decline', async (t) => {
  const { root, source } = await workspace(t, 'relay-commit-unknown-');
  const relay = await startRelay(t, root);
  const { app: a, identity: ia } = await host(t, root, 'a', relay);
  const { app: b, identity: ib } = await host(t, root, 'b', relay);
  await relay.setOwner(ia.fingerprint);
  await a.importExisting(source, true); await a.parkAtRelay();
  const accept = OwnershipLedger.prototype.acceptTransfer;
  const fault = t.mock.method(OwnershipLedger.prototype, 'acceptTransfer', async function (this: OwnershipLedger, ...args: Parameters<OwnershipLedger['acceptTransfer']>) {
    await accept.apply(this, args);
    if (this.deviceId === ib.fingerprint) throw new Error('Simulated failure after durable ownership commit');
  });
  try { await assert.rejects(b.claimFromRelay(), /after durable ownership commit/); }
  finally { fault.mock.restore(); }
  assert.equal((await b.getState()).server!.ownership.state, 'owned');
  assert.equal((await held(relay))!.state, 'offered');
  await assert.rejects(a.claimFromRelay(), /pending checkout/);
  await assert.rejects(a.startGroup(relay.identity.fingerprint, true), /possible or unknown/);
  await assert.rejects(a.removeFriend(ib.fingerprint), /possible or unknown/);
  await b.claimFromRelay();
  assert.equal((await held(relay))!.state, 'transferred');
});

const world = async (app: SeedHostApplication) => readFile(path.join((await app.getState()).server!.serverDir, 'world.bin'), 'utf8');

test('ordinary group Start and mandatory Stop carry the latest server while the previous holder is off', async (t) => {
  const { root, source } = await workspace(t, 'relay-roundtrip-');
  const relay = await startRelay(t, root);
  const ia = await createIdentity();
  let a = (await host(t, root, 'a', relay, ia)).app;
  await a.importExisting(source, true);
  await profile(a);
  await a.startServer(true);
  await writeFile(path.join((await a.getState()).server!.serverDir, 'world.bin'), 'edited on A');
  await a.stopServer();
  const parked = (await a.getState()).server!;
  assert.equal(parked.ownership.state, 'transferred');
  assert.equal((await held(relay))!.generation, 3);
  await a.close();
  const b = (await host(t, root, 'b', relay)).app;
  assert.equal((await b.getState()).server, null);
  await b.startGroup(relay.identity.fingerprint, true);
  assert.equal((await b.getState()).server!.state, 'running');
  assert.equal(await world(b), 'edited on A');
  await writeFile(path.join((await b.getState()).server!.serverDir, 'world.bin'), 'edited on B');
  await b.stopServer();
  assert.equal((await held(relay))!.generation, 5);
  a = (await host(t, root, 'a', relay, ia)).app;
  await a.startServer(true);
  assert.equal((await a.getState()).server!.ownership.generation, 6);
  assert.equal(await world(a), 'edited on B');
  assert.equal(await readFile(path.join(source, 'world.bin'), 'utf8'), 'original');
  await a.stopServer();
});

test('claims are refused while another PC has the server checked out, and the relay reports who has it', async (t) => {
  const { root, source } = await workspace(t, 'relay-checked-out-');
  const relay = await startRelay(t, root);
  const a = (await host(t, root, 'a', relay)).app;
  const { app: b, identity: ib } = await host(t, root, 'b', relay);
  await a.importExisting(source, true);
  await assert.rejects(b.claimFromRelay(), /holds no server/i);
  await a.parkAtRelay();
  await b.claimFromRelay();
  await assert.rejects(a.claimFromRelay(), /checked out by b\b/i, 'the error names the holder');
  assert.equal((await a.getState()).server!.ownership.state, 'transferred');
  const status = await a.checkRelay();
  assert.equal(status!.owner, ib.fingerprint);
  assert.equal(status!.ownerName, 'b');
  assert.equal(status!.state, 'transferred');
  await assert.rejects(b.claimFromRelay(), /already holds/i);
});

test('a lost claim acknowledgment is resolved by retrying the claim, and blocks other PCs meanwhile', async (t) => {
  const { root, source } = await workspace(t, 'relay-lost-ack-');
  const relay = await startRelay(t, root);
  const a = (await host(t, root, 'a', relay)).app;
  const { app: b, identity: ib } = await host(t, root, 'b', relay);
  const c = (await host(t, root, 'c', relay)).app;
  await a.importExisting(source, true);
  await a.parkAtRelay();
  const accept = OwnershipLedger.prototype.acceptTransfer;
  OwnershipLedger.prototype.acceptTransfer = async function (...args: Parameters<OwnershipLedger['acceptTransfer']>) {
    await accept.apply(this, args);
    if (this.deviceId === ib.fingerprint) throw new Error('Fixture: claim acknowledgment lost after durable commit');
  };
  try { await assert.rejects(b.claimFromRelay(), /retry/i); }
  finally { OwnershipLedger.prototype.acceptTransfer = accept; }
  assert.equal((await b.getState()).server!.ownership.state, 'owned', 'B durably accepted');
  assert.equal((await held(relay))!.pendingTarget, ib.fingerprint);
  await assert.rejects(c.claimFromRelay(), /pending.*\bb\b/i);
  await b.claimFromRelay(); // retry: re-acknowledged, not re-applied
  assert.equal((await b.getState()).server!.ownership.generation, 2);
  assert.equal((await held(relay))!.state, 'transferred');
});

test('parking on a relay that already acknowledged-but-lost a claim treats the new park as proof of acceptance', async (t) => {
  const { root, source } = await workspace(t, 'relay-implicit-');
  const relay = await startRelay(t, root);
  const a = (await host(t, root, 'a', relay)).app;
  const { app: b, identity: ib } = await host(t, root, 'b', relay);
  await a.importExisting(source, true);
  await a.parkAtRelay();
  const accept = OwnershipLedger.prototype.acceptTransfer;
  OwnershipLedger.prototype.acceptTransfer = async function (...args: Parameters<OwnershipLedger['acceptTransfer']>) {
    await accept.apply(this, args);
    if (this.deviceId === ib.fingerprint) throw new Error('Fixture: lost');
  };
  try { await assert.rejects(b.claimFromRelay()); } finally { OwnershipLedger.prototype.acceptTransfer = accept; }
  assert.equal((await held(relay))!.state, 'offered');
  await b.parkAtRelay();
  assert.deepEqual((await held(relay)), { owner: relay.identity.fingerprint, state: 'owned', generation: 3,
    snapshotId: (await b.getState()).server!.snapshotId, pendingTarget: null });
});

test('an unreachable relay never fences a stopped holder and group Start refuses unknown status', async (t) => {
  const { root, source } = await workspace(t, 'relay-unreachable-');
  const relay = await startRelay(t, root);
  const a = (await host(t, root, 'a', relay)).app;
  await a.importExisting(source, true);
  await profile(a);
  await a.saveRelay({ fingerprint: relay.identity.fingerprint, parkOnStop: true });
  await a.startServer(true);
  await a.stopServer();
  assert.equal((await a.getState()).server!.ownership.owner, relay.identity.fingerprint, 'park-on-stop parked it');
  await a.claimFromRelay();
  await a.addPeer({ name: 'Relay', fingerprint: relay.identity.fingerprint, host: '127.0.0.1', port: await closedPort() });
  await assert.rejects(a.parkAtRelay(), /unreachable.*stays on this PC/i);
  assert.equal((await a.getState()).server!.ownership.state, 'owned', 'no offer was prepared');
  await assert.rejects(a.startServer(true), /unreachable.*unknown/i);
  const state = await a.getState();
  assert.equal(state.server!.ownership.state, 'owned');
  assert.equal(state.server!.state, 'offline');
});

test('the relay declines a different server, even with a higher generation, and the host keeps it', async (t) => {
  const { root, source } = await workspace(t, 'relay-foreign-');
  const relay = await startRelay(t, root);
  const a = (await host(t, root, 'a', relay)).app;
  const { app: c } = await host(t, root, 'c', relay);
  await a.importExisting(source, true);
  await a.parkAtRelay();
  await a.claimFromRelay(); // relay: transferred to A at generation 2
  const other = path.join(root, 'other');
  await mkdir(other);
  await writeFile(path.join(other, 'world.bin'), 'a different world');
  await c.importExisting(other, true);
  const ledger = new OwnershipLedger((await c.getState()).server!.ledgerFile, (c as any).identity.fingerprint);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync((await c.getState()).server!.ledgerFile);
  const state = await ledger.status();
  db.prepare('UPDATE ownership SET data = ? WHERE id = 1').run(JSON.stringify({ ...state, generation: 50 }));
  db.close();
  await assert.rejects(c.parkAtRelay(), /declined.*not the newest/i);
  assert.equal((await c.getState()).server!.ownership.state, 'owned', 'C keeps its own server');
  const custody = (await held(relay))!;
  assert.equal(custody.state, 'transferred');
  assert.equal(custody.generation, 2);
});

test('relay configuration must name a trusted peer and survives restart', async (t) => {
  const { root } = await workspace(t, 'relay-config-');
  const identity = await createIdentity();
  const app = new SeedHostApplication(path.join(root, 'a'), identity);
  await app.open();
  await assert.rejects(app.saveRelay({ fingerprint: 'a'.repeat(64), parkOnStop: false }), /trusted peer/i);
  await assert.rejects(app.parkAtRelay(), /no relay/i);
  await app.addPeer({ name: 'Mini PC', fingerprint: 'a'.repeat(64), host: '127.0.0.1', port: 47625 });
  await app.saveRelay({ fingerprint: 'a'.repeat(64), parkOnStop: true });
  await app.close();
  const reopened = new SeedHostApplication(path.join(root, 'a'), identity);
  await reopened.open();
  assert.deepEqual((await reopened.getState()).relay, { fingerprint: 'a'.repeat(64), name: 'Mini PC', parkOnStop: true });
  await reopened.saveRelay(null);
  assert.equal((await reopened.getState()).relay, null);
  await reopened.close();
});

test('the relay keeps a bounded history and never prunes the revision it holds', async (t) => {
  const { root, source } = await workspace(t, 'relay-history-');
  const relay = await startRelay(t, root, undefined, { keepRevisions: 2 });
  const a = (await host(t, root, 'a', relay)).app;
  await a.importExisting(source, true);
  for (let i = 0; i < 4; i++) {
    await writeFile(path.join((await a.getState()).server!.serverDir, 'world.bin'), `edit ${i}`);
    await a.parkAtRelay();
    await a.claimFromRelay();
  }
  await a.parkAtRelay();
  const manifests = await readdir(path.join(root, 'relay', 'store', 'snapshots'));
  assert.equal(manifests.length, 2);
  assert.ok(manifests.includes(`${(await held(relay))!.snapshotId}.json`));
});

test('the relay refuses devices it does not trust', async (t) => {
  const { root } = await workspace(t, 'relay-untrusted-');
  const relay = await startRelay(t, root);
  const stranger = await createIdentity();
  await assert.rejects(relayStatus(stranger, { fingerprint: relay.identity.fingerprint, ...relay.endpoint! }), /disconnect|closed|reject/i);
  await assert.rejects(connectPeer(stranger, 'f'.repeat(64), relay.endpoint!.host, relay.endpoint!.port), /pin|fingerprint/i);
});

/**
 * Retrying an offer the relay already accepted is a documented, idempotent recovery path. It must stay an
 * acknowledgment: replaying older history may never promote those revisions into the retention head, and the
 * revision custody holds now must survive every retry so another member can still claim it.
 */
async function replayRetentionScenario(t: TestContext, keepRevisions: number) {
  const { root, source } = await workspace(t, `relay-replay-retention-${keepRevisions}-`);
  const relay = await startRelay(t, root, undefined, { keepRevisions });
  const a = await createIdentity(), b = await createIdentity(), c = await createIdentity();
  for (const [name, identity] of [['a', a], ['b', b], ['c', c]] as const) await relay.trust(name, identity.fingerprint);
  await relay.setOwner(a.fingerprint);
  const peer = { fingerprint: relay.identity.fingerprint, ...relay.endpoint! };
  const stores = new Map([[a.fingerprint, path.join(root, 'store-a')], [b.fingerprint, path.join(root, 'store-b')], [c.fingerprint, path.join(root, 'store-c')]]);
  const ledgers = new Map([[a.fingerprint, new OwnershipLedger(path.join(root, 'a.sqlite'), a.fingerprint)], [b.fingerprint, new OwnershipLedger(path.join(root, 'b.sqlite'), b.fingerprint)]]);
  const first = await createSnapshot(source, stores.get(a.fingerprint)!);
  await ledgers.get(a.fingerprint)!.initialize(first.id);
  const records: Array<{ identity: PeerIdentity; store: string; snapshotId: string; offer: Awaited<ReturnType<OwnershipLedger['prepareTransfer']>> }> = [];
  let latest = first.id;
  for (let revision = 0; revision <= keepRevisions; revision++) {
    const holder = revision === 0 ? a : (revision % 2 === 1 ? b : a);
    const ledger = ledgers.get(holder.fingerprint)!;
    if (revision > 0) {
      const claim = await openRelayOperation(holder, peer, 'claim');
      try {
        await receiveSnapshot(claim, peer.fingerprint, stores.get(holder.fingerprint)!, async (snapshot, from, offer) => {
          await ledger.acceptTransfer(offer!, from, snapshot.id); return true;
        });
      } finally { claim.destroy(); }
      await relay.settled();
    }
    await writeFile(path.join(source, 'world.bin'), `revision ${revision}`);
    const snapshot = await createSnapshot(source, stores.get(holder.fingerprint)!);
    await ledger.updateSnapshot(snapshot.id);
    const offer = await ledger.prepareTransfer(peer.fingerprint, snapshot.id);
    const sent = await sendSnapshotToPeer(holder, peer, stores.get(holder.fingerprint)!, snapshot.id, offer, { preface: relayRequest('park') });
    assert.equal(sent.ownershipAccepted, true);
    await ledger.confirmTransfer(offer.id, peer.fingerprint);
    await relay.settled();
    records.push({ identity: holder, store: stores.get(holder.fingerprint)!, snapshotId: snapshot.id, offer });
    latest = snapshot.id;
  }
  const before = await relay.custody();
  assert.equal(before?.snapshotId, latest, 'the relay holds the newest parked revision');
  // Exact retries of older, already accepted parks — the recovery path this protocol documents.
  for (const record of records.slice(0, -1)) {
    const replayed = await sendSnapshotToPeer(record.identity, peer, record.store, record.snapshotId, record.offer, { preface: relayRequest('park') });
    assert.equal(replayed.ownershipAccepted, true);
    await relay.settled();
  }
  assert.deepEqual(await relay.custody(), before, 'an accepted replay never changes the revision custody holds');
  const snapshots = path.join(root, 'relay', 'store', 'snapshots');
  const held = JSON.parse(await readFile(path.join(snapshots, `${latest}.json`), 'utf8')) as { files: Array<{ hash: string }> };
  await access(path.join(snapshots, `${latest}.json`));
  for (const file of held.files) await access(path.join(root, 'relay', 'store', 'objects', file.hash));
  // A different member can still claim the newest bytes after every replay.
  const storeC = stores.get(c.fingerprint)!;
  const ledgerC = new OwnershipLedger(path.join(root, 'c.sqlite'), c.fingerprint);
  const claim = await openRelayOperation(c, peer, 'claim');
  let claimed: string | undefined;
  try {
    await receiveSnapshot(claim, peer.fingerprint, storeC, async (snapshot, from, offer) => {
      await ledgerC.acceptTransfer(offer!, from, snapshot.id); claimed = snapshot.id; return true;
    });
  } finally { claim.destroy(); }
  await relay.settled();
  assert.equal(claimed, latest);
  const bytes = JSON.parse(await readFile(path.join(storeC, 'snapshots', `${latest}.json`), 'utf8')) as { files: Array<{ hash: string }> };
  const worldObject = bytes.files.find((file) => file.hash === (held.files.find((candidate) => candidate.hash === file.hash)?.hash));
  assert.ok(worldObject);
  await access(path.join(storeC, 'objects', worldObject.hash));
}
test('accepted replays of older parks never remove the revision the relay holds', async (t) => {
  for (const keepRevisions of [1, 10]) await t.test(`keep ${keepRevisions}`, (sub) => replayRetentionScenario(sub, keepRevisions));
});
