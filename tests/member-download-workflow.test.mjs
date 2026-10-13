import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Pause the actual pinned TLS reply after admission commits, not an earlier status read.
function pauseHostAcknowledgment(relay) {
  let reached, release;
  const admitted = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const handle = relay.handle.bind(relay);
  let armed = true;
  relay.handle = (socket, source) => {
    const write = socket.write.bind(socket);
    socket.write = (packet, ...args) => {
      if (armed && Buffer.isBuffer(packet) && packet.subarray(4).toString() === '{"type":"relay-host-accepted"}') {
        armed = false; reached(socket);
        void gate.then(() => { if (!socket.destroyed) write(packet, ...args); });
        return true;
      }
      return write(packet, ...args);
    };
    return handle(socket, source);
  };
  return { admitted, release };
}

async function revokeInOtherProcess(relay, fingerprint) {
  const script = `import { RelayNode } from './dist/src/core/relay.js';
    const [root, identity, fingerprint] = JSON.parse(process.argv[1]);
    const node = new RelayNode(root, identity, { log() {} }); await node.open();
    try { await node.untrust(fingerprint); console.log(JSON.stringify({ revoked: true })); }
    catch (error) { console.log(JSON.stringify({ revoked: false, message: error.message })); }
    await node.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([relay.root, relay.identity, fingerprint])], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, err);
  return JSON.parse(out.trim());
}
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { RelayNode } from '../dist/src/core/relay.js';
import { relayHostState, relayStatus } from '../dist/src/core/relay-client.js';
import { randomUUID } from 'node:crypto';

async function fixture(t) {
  const scratch = process.env.TMPDIR;
  assert.ok(scratch?.replaceAll('\\', '/').toLowerCase().includes('hermes/cache/scratch'), 'disposable scratch root required');
  const root = await mkdtemp(path.join(scratch, 'seedhost-member-download-'));
  const relay = new RelayNode(path.join(root, 'relay'), await createIdentity(), { log() {}, name: 'Shared world' });
  const owner = new SeedHostApplication(path.join(root, 'owner'), await createIdentity(), {
    resolveGroupLaunchProfile: async () => ({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] }),
  });
  const member = new SeedHostApplication(path.join(root, 'member'), await createIdentity(), {
    // Locally approved synthetic process, NEVER received from the peer or a renderer.
    resolveGroupLaunchProfile: async () => ({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] }),
  });
  t.after(async () => {
    await member.close(); await owner.close(); await relay.close();
    await rm(root, { recursive: true, force: true });
  });
  await relay.open(); await relay.listen(); await owner.open(); await member.open();
  await relay.trust('Owner', owner.identity.fingerprint);
  await relay.setOwner(owner.identity.fingerprint);
  await owner.addPeer({ name: relay.name, fingerprint: relay.identity.fingerprint, ...relay.endpoint });
  const source = path.join(root, 'source');
  await mkdir(source); await writeFile(path.join(source, 'world.bin'), 'initial');
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  await owner.importExisting(source, true);
  await owner.saveRelay({ fingerprint: relay.identity.fingerprint, parkOnStop: false });
  await member.joinHostingGroup({ code: (await owner.createInvite()).code, name: 'Member' });
  return { root, source, owner, member, relay, pin: relay.identity.fingerprint };
}

test('reproduces first invited member empty-relay defect without moving authority or files', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  const before = await owner.getState();
  const pending = (await member.getState()).pendingGroups;
  await assert.rejects(member.claimPendingGroup(pin), error => {
    console.log('REPRODUCED claimPendingGroup: ' + error.message);
    return error.message === 'The group holds no server yet. Park one on it from the PC that has it.';
  });
  assert.equal(await relay.custody(), null, 'enrollment is not world publication');
  assert.deepEqual((await owner.getState()).server, before.server, 'owner remains unchanged and authorised');
  assert.deepEqual((await member.getState()).pendingGroups, pending);
  assert.equal((await member.getState()).servers.length, 0);
  assert.equal(await readFile(path.join(before.server.serverDir, 'world.bin'), 'utf8'), 'initial');
});

test('a second invited member cannot take a held world or replace an unrelated server', async t => {
  const { root, owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay();
  await member.claimPendingGroup(pin); await relay.settled();
  const other = new SeedHostApplication(path.join(root, 'other'), await createIdentity());
  await other.open(); t.after(() => other.close());
  const source = path.join(root, 'unrelated'); await mkdir(source);
  await writeFile(path.join(source, 'world.bin'), 'unrelated');
  await other.importExisting(source, true);
  await other.joinHostingGroup({ code: (await owner.createInvite()).code, name: 'Other' });
  const before = (await other.getState()).server;
  const custody = await relay.custody();
  await assert.rejects(other.claimPendingGroup(pin), /checked out by Member/);
  assert.deepEqual(await relay.custody(), custody);
  assert.deepEqual((await other.getState()).server, before);
  assert.equal((await other.getState()).servers.length, 1);
  await other.close();
});

// Synthetic fixture bytes and process only; pinned loopback TLS is real.
const fakeProcess = path.resolve('tools/fake-java-server.mjs');
async function configure(app) {
  await app.saveProfile({ executable: process.execPath, args: [fakeProcess, '--lifetime-ms=30000'] });
}
async function bytes(app) {
  const dir = (await app.getState()).server.serverDir;
  return Promise.all(['world.bin', 'mods/example.jar', 'config/example.toml', 'server.properties'].map(name => readFile(path.join(dir, name), 'utf8')));
}
async function editStopped(app, revision) {
  const dir = (await app.getState()).server.serverDir;
  await mkdir(path.join(dir, 'mods'), { recursive: true });
  await mkdir(path.join(dir, 'config'), { recursive: true });
  for (const [name, value] of [['world.bin', `world-${revision}`], ['mods/example.jar', `synthetic-mod-${revision}`], ['config/example.toml', `setting="${revision}"`], ['server.properties', `motd=${revision}\nserver-port=0\n`]]) await writeFile(path.join(dir, name), value);
}

test('current serverless Start does not publish, claim or configure a joined group', async t => {
  const { owner, member, relay } = await fixture(t);
  await owner.parkAtRelay(); await relay.settled();
  const before = await relay.custody();
  await assert.rejects(member.startServer(true), error => {
    console.log('START BLOCKER: ' + error.message);
    return error.message === 'Configure a launch profile first';
  });
  assert.deepEqual(await relay.custody(), before);
  assert.equal((await member.getState()).servers.length, 0);
});

test('explicit stopped Park/Claim seam still preserves complete bytes without executing replicas', async t => {
  const { source, owner, member, relay, pin } = await fixture(t);
  await editStopped(owner, 'A'); const a = await bytes(owner);
  await owner.parkAtRelay(); await relay.settled();
  await member.claimPendingGroup(pin); await relay.settled();
  assert.deepEqual(await bytes(member), a);
  assert.equal((await member.getState()).server.ownership.generation, 2);
  await configure(owner); await configure(member);
  await assert.rejects(owner.startServer(true), /checked out by Member.*unknown/);
  await editStopped(member, 'B'); const b = await bytes(member);
  await member.parkAtRelay(); await relay.settled();
  await owner.claimFromRelay(); await relay.settled();
  assert.deepEqual(await bytes(owner), b);
  assert.equal((await owner.getState()).server.ownership.generation, 4);
  assert.equal((await owner.getState()).server.state, 'offline');
  assert.equal(await readFile(path.join(source, 'world.bin'), 'utf8'), 'initial');
});

test('active holder is not stopped or snapshotted by another member claim', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  await configure(member); await member.startServer(true);
  const before = (await member.getState()).server;
  const custody = await relay.custody();
  await assert.rejects(member.parkAtRelay(), /Stop the server/);
  await assert.rejects(owner.claimFromRelay(), /Member is hosting/);
  assert.equal((await member.getState()).server.state, 'running');
  assert.deepEqual((await member.getState()).server.ownership, before.ownership);
  assert.deepEqual(await relay.custody(), custody);
  await member.stopServer();
});

test('unreachable relay cannot let a stale transferred replica start or overwrite its bytes', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  await editStopped(member, 'B'); await member.parkAtRelay(); await relay.settled();
  await owner.claimFromRelay(); await relay.settled();
  await configure(member);
  const before = (await member.getState()).server;
  const contents = await bytes(member);
  await relay.close();
  await assert.rejects(member.claimFromRelay(), /unreachable/);
  await assert.rejects(member.startServer(true), /unreachable.*unknown/);
  assert.deepEqual((await member.getState()).server, before);
  assert.deepEqual(await bytes(member), contents);
});

test('concurrent explicit claims have one authority winner and leave the loser serverless', async t => {
  const { root, owner, member, relay, pin } = await fixture(t);
  const contender = new SeedHostApplication(path.join(root, 'contender'), await createIdentity());
  await contender.open();
  try {
    await contender.joinHostingGroup({ code: (await owner.createInvite()).code, name: 'Contender' });
    await owner.parkAtRelay(); await relay.settled();
    const outcomes = await Promise.allSettled([member.claimPendingGroup(pin), contender.claimPendingGroup(pin)]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
    await relay.settled();
    const states = await Promise.all([member.getState(), contender.getState()]);
    const winner = states.find(state => state.server?.ownership.state === 'owned');
    const loser = states.find(state => state.server === null);
    assert.ok(winner); assert.ok(loser);
    assert.equal((await relay.custody()).owner, winner.deviceId);
    assert.equal(loser.servers.length, 0); assert.equal(loser.pendingGroups.length, 1);
    assert.equal(winner.server.state, 'offline', 'claim alone does not execute received files');
    console.log('SAFE EXISTING CLAIM RACE: one owner, serverless loser, neither process executed. NOT concurrent Start.');
  } finally { await contender.close(); }
});

test('one-click initial A to B to A preserves unrelated worlds, latest mods/config and deletions across restart', async t => {
  const { root, owner, member, relay, pin } = await fixture(t);
  const unrelated = path.join(root, 'unrelated-start'); await mkdir(unrelated);
  await writeFile(path.join(unrelated, 'world.bin'), 'unrelated original');
  await member.importExisting(unrelated, true);
  const unrelatedSaved = (await member.getState()).server;
  await editStopped(owner, 'A');
  const oldOwnerDir = (await owner.getState()).server.serverDir;
  await writeFile(path.join(oldOwnerDir, 'deleted-by-B.bin'), 'retain only in old A conflict copy');
  relay.publishStoppedInitial = (group, device) => owner.publishStoppedInitialGroup(group, device);
  await member.startGroup(pin, true);
  assert.equal((await member.getState()).servers.length, 2);
  assert.equal(await readFile(path.join(unrelatedSaved.serverDir, 'world.bin'), 'utf8'), 'unrelated original');
  const dir = (await member.getState()).server.serverDir;
  await rm(path.join(dir, 'deleted-by-B.bin'));
  await editStopped(member, 'B'); const expected = await bytes(member);
  await member.stopServer(); await owner.startGroup(pin, true);
  assert.deepEqual(await bytes(owner), expected);
  await assert.rejects(readFile(path.join((await owner.getState()).server.serverDir, 'deleted-by-B.bin')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(oldOwnerDir, 'deleted-by-B.bin'), 'utf8'), 'retain only in old A conflict copy');
  await owner.stopServer(); await member.close();
  const reopened = new SeedHostApplication(member.root, member.identity, {
    resolveGroupLaunchProfile: async () => ({ executable: process.execPath, args: [fakeProcess, '--lifetime-ms=30000'] }),
  });
  await reopened.open();
  try {
    await reopened.startGroup(pin, true);
    assert.deepEqual(await bytes(reopened), expected);
    assert.ok((await reopened.getState()).servers.some(server => server.id === unrelatedSaved.id));
    await reopened.stopServer();
    await reopened.selectServer(unrelatedSaved.id);
    assert.equal((await reopened.getState()).server.serverDir, unrelatedSaved.serverDir);
    assert.equal(await readFile(path.join((await reopened.getState()).server.serverDir, 'world.bin'), 'utf8'), 'unrelated original');
  } finally { await reopened.close(); }
});

test('lost live-host observation after admitted spawn stays unknown without stranding orderly Stop', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay();
  let connections = 0; const sockets = new Set();
  const proxy = createServer(client => {
    if (++connections === 6) { client.destroy(); return; } // Only post-spawn host-running telemetry is disconnected (status, claim status, canonical-title readback, claim, host-start admission, then telemetry).
    const upstream = connect(relay.endpoint.port, '127.0.0.1');
    for (const socket of [client, upstream]) { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); }
    client.pipe(upstream); upstream.pipe(client);
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)); });
  await member.addPeer({ name: relay.name, fingerprint: pin, host: '127.0.0.1', port: proxy.address().port });
  await member.startGroup(pin, true);
  assert.equal((await member.getState()).server.state, 'running');
  assert.equal((await member.checkRelay()).hosting, null);
  await member.stopServer(); await relay.settled();
  assert.equal((await relay.custody()).state, 'owned');
});

test('relay restart loses hosting observation but never releases an unknown holder or allows takeover', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay(); await member.startGroup(pin, true);
  const endpoint = relay.endpoint;
  await relay.close(); await relay.listen({ host: endpoint.host, port: endpoint.port });
  assert.equal((await owner.checkRelay()).hosting, null);
  await assert.rejects(owner.startGroup(pin, true), /checked out by Member.*unknown/);
  assert.equal((await member.getState()).server.state, 'running');
  await member.stopServer();
});

test('concurrent group Starts have one running winner and no loser spawn', async t => {
  const { root, owner, member, relay, pin } = await fixture(t);
  const contender = new SeedHostApplication(path.join(root, 'start-contender'), await createIdentity(), {
    resolveGroupLaunchProfile: async () => ({ executable: process.execPath, args: [fakeProcess, '--lifetime-ms=30000'] }),
  });
  await contender.open();
  try {
    await contender.joinHostingGroup({ code: (await owner.createInvite()).code, name: 'Contender' });
    await owner.parkAtRelay();
    const outcomes = await Promise.allSettled([member.startGroup(pin, true), contender.startGroup(pin, true)]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    await relay.settled();
    const states = await Promise.all([member.getState(), contender.getState()]);
    assert.equal(states.filter(state => state.server?.state === 'running').length, 1);
    assert.equal(states.filter(state => state.server === null).length, 1);
    const winner = states[0].server?.state === 'running' ? member : contender;
    await winner.stopServer();
  } finally { await contender.close(); }
});

test('active group host is observed through authenticated control and another Start neither stops nor snapshots it', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay(); await member.startGroup(pin, true); await relay.settled();
  const before = await relay.custody();
  assert.equal((await member.checkRelay()).hosting, true);
  await assert.rejects(owner.startGroup(pin, true), /hosting.*Member|Member.*hosting/);
  assert.equal((await member.getState()).server.state, 'running');
  assert.deepEqual(await relay.custody(), before);
  await member.stopServer();
});

test('Stop publication failure stays unavailable and ordinary Stop retries after relay recovery', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay(); await member.startGroup(pin, true);
  const endpoint = relay.endpoint;
  await relay.close();
  await assert.rejects(member.stopServer(), /unreachable|Handoff/);
  assert.equal((await member.getState()).server.state, 'offline');
  assert.equal((await relay.custody()).state, 'transferred');
  await relay.listen({ host: endpoint.host, port: endpoint.port });
  await member.stopServer(); await relay.settled();
  assert.equal((await relay.custody()).state, 'owned');
});

test('group Start never executes an arbitrary locally stored non-Java command without a trusted fixture approval', async t => {
  const { root, owner, pin } = await fixture(t);
  const app = new SeedHostApplication(path.join(root, 'non-java'), await createIdentity());
  await app.open();
  try {
    await app.joinHostingGroup({ code: (await owner.createInvite()).code, name: 'Non-Java fixture' });
    await owner.parkAtRelay(); await app.claimPendingGroup(pin); await configure(app);
    await assert.rejects(app.startGroup(pin, true), /Java|java|launch plan/i);
    assert.notEqual((await app.getState()).server.state, 'running');
    await app.stopServer();
  } finally { await app.close(); }
});

test('Start retries a safely stopped local holder after first-use launch setup without stealing authority', async t => {
  const { root, owner, relay, pin } = await fixture(t);
  const local = new SeedHostApplication(path.join(root, 'setup-member'), await createIdentity(), {
    resolveGroupLaunchProfile: async (_dir, profile) => {
      if (!profile.executable) throw new Error('Configure local Java launch profile first');
      return profile; // explicitly approved synthetic local runtime; not gameplay proof
    },
  });
  await local.open();
  try {
    await local.joinHostingGroup({ code: (await owner.createInvite()).code, name: 'Setup member' });
    await owner.parkAtRelay();
    await assert.rejects(local.startGroup(pin, true), /Java|launch profile/);
    const before = (await local.getState()).server;
    assert.equal(before.state, 'offline');
    await configure(local);
    await local.startGroup(pin, true);
    assert.equal((await local.getState()).server.state, 'running');
    await local.stopServer();
  } finally { await local.close(); }
});

test('admitted Start fences cross-process revocation while the pinned acknowledgment is paused', { timeout: 20000 }, async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay();
  const gate = pauseHostAcknowledgment(relay);
  const start = member.startGroup(pin, true);
  let result;
  try {
    await gate.admitted;
    assert.equal(member.process, undefined, 'no process spawned before acknowledgment');
    const pending = JSON.parse(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8'));
    assert.equal(pending.state, 'starting');
    result = await revokeInOtherProcess(relay, member.identity.fingerprint);
  } finally { gate.release(); }
  await start;
  if (result.revoked) await member.stopServer().catch(() => {}); // baseline still needs clean teardown after unauthorized spawn
  // Assert after release so the baseline also exhibits its unauthorized running process.
  assert.equal(result.revoked, false, 'revocation must not commit between admitted Start and spawn');
  assert.match(result.message, /pending.*start|start.*pending/i);
  assert.equal((await member.getState()).server.state, 'running');
  assert.equal((await member.checkRelay()).hosting, true);
  await member.stopServer();
  await member.claimFromRelay(); await relay.settled();
  assert.equal((await revokeInOtherProcess(relay, member.identity.fingerprint)).revoked, true, 'settled stopped holder remains locally revocable');
});

test('acknowledged Start failure before spawn cancels only its reservation and permits normal retry', { timeout: 20000 }, async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay();
  const gate = pauseHostAcknowledgment(relay);
  const start = member.startGroup(pin, true);
  await gate.admitted;
  const assertStopped = member.assertStopped.bind(member);
  let fail = true;
  member.assertStopped = () => { if (fail) { fail = false; throw new Error('deterministic pre-spawn failure'); } return assertStopped(); };
  gate.release();
  await assert.rejects(start, /deterministic pre-spawn failure/);
  assert.equal(member.process, undefined);
  assert.equal((await member.getState()).server.ownership.state, 'owned', 'provably no process must not strand a normal failed Start');
  const observation = JSON.parse(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8'));
  assert.equal(observation.state, 'cancelled');
  await member.startGroup(pin, true);
  await member.stopServer();
});

test('lost admitted acknowledgment cannot be bypassed by recovered local Park', { timeout: 25000 }, async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay();
  const gate = pauseHostAcknowledgment(relay);
  const start = member.startGroup(pin, true);
  const rejected = assert.rejects(start);
  const socket = await gate.admitted;
  socket.destroy(); gate.release(); await rejected;
  assert.equal(member.process, undefined);
  assert.equal((await member.getState()).server.ownership.state, 'uncertain');
  const pending = JSON.parse(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8'));
  const custody = await relay.custody();
  assert.equal(pending.state, 'starting');
  const status = await member.checkRelay();
  assert.equal(status.hosting, null);
  assert.equal(status.pendingStart, true, 'unknown execution is explicit pending recovery, not idle');
  const endpoint = relay.endpoint;
  await relay.close(); await relay.listen(endpoint);
  assert.equal((await member.checkRelay()).pendingStart, true, 'relay restart must retain pending recovery');
  const peer = { fingerprint: pin, ...relay.endpoint };
  const revision = { generation: pending.generation, snapshotId: pending.snapshotId, lineage: pending.lineage, reservation: pending.reservation };
  for (const patch of [{ reservation: randomUUID() }, { generation: pending.generation + 1 }, { snapshotId: '0'.repeat(64) }, { lineage: 'wrong' }]) {
    await assert.rejects(relayHostState(member.identity, peer, 'host-cancel', { ...revision, ...patch }), /mismatch|refused/i);
  }
  await assert.rejects(relayHostState(owner.identity, peer, 'host-cancel', revision), /refused/i);
  await assert.rejects(relayHostState(member.identity, peer, 'host-start', { ...revision, reservation: randomUUID() }), /pending/i);
  await assert.rejects(owner.claimFromRelay(), /checked out|pending|unknown/i);
  assert.equal((await revokeInOtherProcess(relay, member.identity.fingerprint)).revoked, false);
  await assert.rejects(relay.disbandGroup(owner.identity.fingerprint), /pending/i);
  await member.ledger().recoverStopped(true);
  await assert.rejects(member.parkAtRelay(), /pending|declin|recovery|disconnect|closed/i);
  assert.deepEqual(await relay.custody(), custody);
  assert.deepEqual(JSON.parse(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8')), pending);
});

test('malformed durable admission fails closed instead of allowing revocation', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  const custody = await member.ledger().status();
  const valid = { owner: member.identity.fingerprint, generation: custody.generation, snapshotId: custody.snapshotId, lineage: custody.lineage, reservation: randomUUID(), state: 'stopped' };
  for (const patch of [{ generation: 0 }, { generation: -1 }, { lineage: '' }, { lineage: 'bad\nlineage' }, { lineage: 'x'.repeat(513) }, { reservation: '-'.repeat(36) }, { reservation: 42 }, { extra: true }]) {
    await writeFile(path.join(relay.root, 'host-observation.json'), JSON.stringify({ ...valid, ...patch }));
    await assert.rejects(relay.untrust(member.identity.fingerprint), /invalid durable reservation/i, JSON.stringify(patch));
  }
  await writeFile(path.join(relay.root, 'host-observation.json'), JSON.stringify(valid));
});

test('host admission rejects malformed UUID without reserving authority', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  const custody = await member.ledger().status();
  await assert.rejects(relayHostState(member.identity, { fingerprint: pin, ...relay.endpoint }, 'host-start', {
    generation: custody.generation, snapshotId: custody.snapshotId, lineage: custody.lineage, reservation: '-'.repeat(36),
  }), /Invalid hosting reservation/);
  await assert.rejects(readFile(path.join(relay.root, 'host-observation.json')), { code: 'ENOENT' });
});

test('OS ENOENT before spawn cancels acknowledged admission and allows retry', async t => {
  const { root, owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay();
  const resolver = member.options.resolveGroupLaunchProfile;
  member.options.resolveGroupLaunchProfile = async () => ({ executable: path.join(root, 'missing-approved.exe'), args: [] });
  await assert.rejects(member.startGroup(pin, true), /ENOENT/);
  assert.equal(member.process?.pid, undefined);
  assert.equal((await member.getState()).server.ownership.state, 'owned');
  assert.equal(JSON.parse(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8')).state, 'cancelled');
  member.options.resolveGroupLaunchProfile = resolver;
  await member.startGroup(pin, true); await member.stopServer();
});

test('real child exit before readiness never cancels admitted execution', async t => {
  const { root, owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay();
  const marker = path.join(root, 'spawn-evidence.txt');
  member.options.resolveGroupLaunchProfile = async () => ({ executable: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned'); process.exit(7)`] });
  await assert.rejects(member.startGroup(pin, true), /before stdout readiness/);
  assert.equal(await readFile(marker, 'utf8'), 'spawned');
  assert.equal((await member.getState()).server.ownership.state, 'uncertain');
  assert.equal(JSON.parse(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8')).state, 'starting');
  await assert.rejects(member.stopServer(), /uncertain|pending|recovery|ownership/i);
});

test('settled hosting cannot be handed off after an unverified child stop and local recovery', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay(); await member.startGroup(pin, true);
  const before = await relay.custody();
  const revision = member.groupHostReservation.revision;
  await member.operation('fixture-force-stop', async () => { await member.process.forceStop(); });
  await member.ledger().recoverStopped(true);
  await assert.rejects(relayHostState(member.identity, { fingerprint: pin, ...relay.endpoint }, 'host-cancel', revision), /cannot be resolved/i);
  await assert.rejects(member.parkAtRelay(), /hosting|stop|unresolved|recovery|closed|disconnect/i);
  assert.deepEqual(await relay.custody(), before);
});

test('confirmed recovery snapshots actual spawned exit0 before resolving exact admission and permits next Start', async t => {
  const { root, owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay();
  const resolver = member.options.resolveGroupLaunchProfile;
  const marker = path.join(root, 'exit0-spawn-evidence.txt');
  member.options.resolveGroupLaunchProfile = async () => ({ executable: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned'); require('node:fs').writeFileSync('world.bin', 'child-final'); process.exit(0)`] });
  await assert.rejects(member.startGroup(pin, true), /before stdout readiness/);
  assert.equal(await readFile(marker, 'utf8'), 'spawned');
  assert.equal(member.process.pid, undefined);
  assert.equal((await member.getState()).server.ownership.state, 'uncertain');
  const pending = JSON.parse(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8'));
  const custody = await relay.custody();
  await assert.rejects(member.recoverStopped(false), /Confirm/);
  await assert.rejects(member.stopServer(), /ownership|uncertain|pending/i);
  assert.deepEqual(await relay.custody(), custody);
  assert.deepEqual(JSON.parse(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8')), pending);
  // Observe durable local snapshot at the actual host-stopped reply boundary.
  const handle = relay.handle.bind(relay);
  let stoppedReplies = 0, beforeReply;
  relay.handle = (socket, source) => {
    const write = socket.write.bind(socket);
    socket.write = (packet, ...args) => {
      if (Buffer.isBuffer(packet) && packet.subarray(4).toString() === '{"type":"relay-host-accepted"}') {
        stoppedReplies++;
        beforeReply = (async () => {
          const saved = JSON.parse(await readFile(path.join(member.root, 'state.json'), 'utf8'));
          const local = saved.servers.find(server => server.id === saved.activeServerId);
          const ownership = await member.ledger().status();
          assert.notEqual(local.snapshotId, pending.snapshotId);
          assert.equal(ownership.snapshotId, local.snapshotId);
          assert.equal(ownership.state, 'owned');
          const { readSnapshot } = await import('../dist/src/core/snapshots.js');
          const manifest = await readSnapshot(local.storeDir, local.snapshotId);
          assert.equal(manifest.parentId, pending.snapshotId);
          assert.ok(manifest.files.some(file => file.path === 'world.bin'));
          write(packet, ...args);
        })();
        void beforeReply.catch(() => socket.destroy());
        return true;
      }
      return write(packet, ...args);
    };
    return handle(socket, source);
  };
  try { await member.recoverStopped(true); }
  finally { await beforeReply; relay.handle = handle; }
  assert.equal(stoppedReplies, 1, 'explicit recovery must resolve admission, not just local ownership');
  const recovered = (await member.getState()).server;
  const saved = JSON.parse(await readFile(path.join(member.root, 'state.json'), 'utf8')).servers.find(server => server.id === recovered.id);
  assert.equal(saved.snapshotId, recovered.snapshotId);
  assert.equal(recovered.ownership.snapshotId, recovered.snapshotId);
  assert.equal(recovered.ownership.state, 'owned');
  assert.deepEqual(JSON.parse(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8')), { ...pending, state: 'stopped' });
  await member.parkAtRelay(); await relay.settled();
  assert.equal((await relay.custody()).state, 'owned');
  member.options.resolveGroupLaunchProfile = resolver;
  await member.startGroup(pin, true);
  assert.equal(await readFile(path.join((await member.getState()).server.serverDir, 'world.bin'), 'utf8'), 'child-final');
  await member.stopServer();
});

test('authenticated journal recovery requires confirmation and exact local and remote evidence', async t => {
  for (const kind of ['lost-start-ack', 'restart', 'wrong-revision', 'missing-journal', 'remote-holder']) {
    await t.test(kind, async t => {
      const { owner, member, relay, pin } = await fixture(t);
      await owner.parkAtRelay();
      if (kind === 'lost-start-ack') {
        const gate = pauseHostAcknowledgment(relay);
        const failed = assert.rejects(member.startGroup(pin, true));
        try { (await gate.admitted).destroy(); } finally { gate.release(); }
        await failed;
      } else {
        member.options.resolveGroupLaunchProfile = async () => ({ executable: process.execPath, args: ['-e', 'process.exit(0)'] });
        await assert.rejects(member.startGroup(pin, true), /before stdout readiness/);
      }
      let app = member;
      if (kind === 'restart' || kind === 'missing-journal') {
        await member.close();
        if (kind === 'missing-journal') {
          const id = (await member.getState()).server.id;
          await rm(path.join(member.root, 'admissions', id + '.json'));
        }
        app = new SeedHostApplication(member.root, member.identity);
        await app.open(); t.after(() => app.close());
      }
      if (kind === 'wrong-revision') member.groupHostReservation.revision.generation++;
      if (kind === 'remote-holder') {
        const file = path.join(relay.root, 'host-observation.json');
        const remote = JSON.parse(await readFile(file, 'utf8'));
        await writeFile(file, JSON.stringify({ ...remote, owner: owner.identity.fingerprint }));
      }
      const before = (await app.getState()).server;
      const observation = await readFile(path.join(relay.root, 'host-observation.json'), 'utf8');
      await assert.rejects(app.recoverStopped(false), /Confirm/);
      assert.deepEqual((await app.getState()).server, before);
      assert.equal(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8'), observation);
      if (kind === 'lost-start-ack' || kind === 'restart') {
        const recovery = await app.groupRecoveryStatus();
        assert.equal(recovery.admission.deviceId, member.identity.fingerprint);
        assert.equal(recovery.admission.relayFingerprint, pin);
        assert.deepEqual(recovery.admission.revision, {
          generation: recovery.remote.observation.generation, snapshotId: recovery.remote.observation.snapshotId,
          lineage: recovery.remote.observation.lineage, reservation: recovery.remote.observation.reservation,
        });
        await app.recoverStopped(true);
        const after = (await app.getState()).server;
        assert.equal(after.ownership.state, 'owned');
        assert.equal(after.state, 'offline', 'recovery cannot execute');
        assert.equal(JSON.parse(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8')).state, 'stopped');
      } else {
        await assert.rejects(app.recoverStopped(true), /reservation|admission|exact|custody/i);
        assert.deepEqual((await app.getState()).server, before);
        assert.equal(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8'), observation);
      }
    });
  }
});

test('failed Park preflight stays owned unchanged and confirmed stopped recovery permits subsequent Start', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay();
  const resolver = member.options.resolveGroupLaunchProfile;
  member.options.resolveGroupLaunchProfile = async () => ({ executable: process.execPath, args: ['-e', 'process.exit(0)'] });
  await assert.rejects(member.startGroup(pin, true), /before stdout readiness/);
  await member.ledger().recoverStopped(true); // reproduce old local-only recovery then refused Park
  const before = (await member.getState()).server;
  const custody = await relay.custody();
  const observation = await readFile(path.join(relay.root, 'host-observation.json'), 'utf8');
  await assert.rejects(member.parkAtRelay(), /pending/i);
  assert.deepEqual((await member.getState()).server, before, 'preflight cannot snapshot, offer, or alter owned authority');
  assert.equal(before.ownership.state, 'owned');
  assert.equal(before.ownership.offer, undefined);
  assert.deepEqual(await relay.custody(), custody);
  assert.equal(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8'), observation);
  await member.ledger().markUncertain();
  await member.recoverStopped(true);
  assert.equal((await member.getState()).server.ownership.state, 'owned');
  assert.equal(JSON.parse(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8')).state, 'stopped');
  member.options.resolveGroupLaunchProfile = resolver;
  await member.startGroup(pin, true);
  assert.equal((await member.getState()).server.state, 'running');
  await member.stopServer();
});

test('lost explicit stopped acknowledgment retains uncertainty and exact reservation for confirmed retry', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay();
  member.options.resolveGroupLaunchProfile = async () => ({ executable: process.execPath, args: ['-e', 'process.exit(0)'] });
  await assert.rejects(member.startGroup(pin, true), /before stdout readiness/);
  const reservation = member.groupHostReservation.revision.reservation;
  const gate = pauseHostAcknowledgment(relay);
  const recovery = assert.rejects(member.recoverStopped(true), /unresolved|unreachable/i);
  (await gate.admitted).destroy(); gate.release(); await recovery;
  assert.equal((await member.getState()).server.ownership.state, 'uncertain');
  assert.equal(member.groupHostReservation.revision.reservation, reservation);
  assert.equal(JSON.parse(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8')).state, 'stopped');
  await assert.rejects(member.parkAtRelay(), /ownership/i);
  await member.recoverStopped(true);
  assert.equal((await member.getState()).server.ownership.state, 'owned');
  await member.parkAtRelay();
});

test('explicit stopped recovery refuses a tracked live group process', async t => {
  const { owner, member, pin } = await fixture(t);
  await owner.parkAtRelay(); await member.startGroup(pin, true);
  const before = (await member.getState()).server;
  await assert.rejects(member.recoverStopped(true), /Stop the server/i);
  assert.deepEqual((await member.getState()).server, before);
  await member.stopServer();
});

test('legacy pending admission fences Claim even when recovered custody appears parked', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay(); await relay.settled();
  const custody = await relay.ledger().status();
  const pending = { owner: owner.identity.fingerprint, generation: custody.generation, snapshotId: custody.snapshotId, lineage: custody.lineage, state: 'starting' };
  await writeFile(path.join(relay.root, 'host-observation.json'), JSON.stringify(pending));
  await assert.rejects(member.claimPendingGroup(pin), /pending/i);
  assert.deepEqual(await relay.ledger().status(), custody);
  await assert.rejects(relayHostState(owner.identity, { fingerprint: pin, ...relay.endpoint }, 'host-cancel', { ...pending, reservation: randomUUID() }), /refused|mismatch/i);
  assert.deepEqual(JSON.parse(await readFile(path.join(relay.root, 'host-observation.json'), 'utf8')), pending);
});

test('Start rechecks group membership after local execution approval before spawning', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay();
  const revoker = new RelayNode(relay.root, relay.identity, { log() {} });
  await revoker.open();
  await assert.rejects(member.startGroupWithApproval(pin, async () => {
    await relay.settled(); await revoker.untrust(member.identity.fingerprint); return true;
  }), /untrusted|Invite required|authoriz|refused/i);
  assert.notEqual((await member.getState()).server.state, 'running');
});

// Initial publication is requested only by explicit group Start, never by invitation redemption.
test('empty group refuses initial publication when its bound owner application is closed', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  relay.publishStoppedInitial = () => owner.publishStoppedInitialGroup(pin);
  await owner.close();
  await assert.rejects(member.startGroup(pin, true), /offline|closed|not running/i);
  assert.equal(await relay.custody(), null);
  assert.equal((await member.getState()).servers.length, 0);
});

test('initial group Start refuses a live-writing owner and never snapshots or stops it', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.saveRelay(null); await configure(owner); await owner.startServer(true);
  await owner.saveRelay({ fingerprint: pin, parkOnStop: false });
  relay.publishStoppedInitial = () => owner.publishStoppedInitialGroup(pin);
  const before = (await owner.getState()).server.snapshotId;
  await assert.rejects(member.startGroup(pin, true), /Stop the server/);
  assert.equal((await owner.getState()).server.state, 'running');
  assert.equal((await owner.getState()).server.snapshotId, before);
  assert.equal(await relay.custody(), null);
  await owner.stopServer();
  assert.equal((await relay.custody()).state, 'owned');
});

test('Start bootstraps an empty group after stopped initial publication exceeds five seconds', { timeout: 20000 }, async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await editStopped(owner, 'initial-shared'); const expected = await bytes(owner);
  let entered, release, publication;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  relay.publishStoppedInitial = (group, device) => {
    publication = (async () => {
      entered();
      await gate;
      await owner.publishStoppedInitialGroup(group, device);
    })();
    return publication;
  };
  // Observe rejection immediately: the baseline times out while the callback is gated.
  const outcome = member.startGroup(pin, true).then(() => ({ ok: true }), error => ({ error }));
  try {
    await reached;
    await new Promise(resolve => setTimeout(resolve, 5500));
    assert.equal(member.process, undefined, 'no launch before durable publication or after a timeout');
    assert.equal(owner.process, undefined, 'publication never launches the stopped owner');
    assert.equal(await relay.custody(), null);
    release();
    const result = await outcome;
    if (result.error) {
      assert.equal(member.process, undefined, 'a timed-out Start must not spawn');
      console.log('INITIAL PUBLICATION START ERROR: ' + result.error.message);
      throw result.error;
    }
    assert.equal((await member.getState()).server.state, 'running');
    assert.deepEqual(await bytes(member), expected);
    assert.equal((await owner.getState()).server.ownership.state, 'transferred');
    assert.equal(owner.process, undefined, 'exactly one host');
    assert.equal((await relay.custody()).owner, member.identity.fingerprint);
    await member.stopServer();
  } finally {
    release();
    await outcome;
    await publication; // Socket timeout does not cancel the real owner callback.
    await relay.settled();
  }
});

test('ordinary relay status still times out after five seconds', { timeout: 15000 }, async t => {
  const { member, relay, pin } = await fixture(t);
  const handle = relay.handle.bind(relay);
  relay.handle = (socket, source) => {
    const write = socket.write.bind(socket);
    socket.write = (packet, ...args) => {
      if (Buffer.isBuffer(packet) && packet.subarray(4).toString().startsWith('{"type":"relay-status"')) return true;
      return write(packet, ...args);
    };
    return handle(socket, source);
  };
  const started = performance.now();
  await assert.rejects(relayStatus(member.identity, { fingerprint: pin, ...relay.endpoint }), error =>
    error.code === 'PEER_FRAME_TIMEOUT' && error.message === 'Frame read timed out');
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 4900 && elapsed < 8000, `ordinary status deadline: ${elapsed}ms`);
});

test('nonresponding initial publication has a bounded deadline and never launches after timeout', { timeout: 15000 }, async t => {
  const { owner, member, relay, pin } = await fixture(t);
  let release, publication;
  const gate = new Promise(resolve => { release = resolve; });
  relay.publishStoppedInitial = (group, device) => {
    publication = (async () => { await gate; await owner.publishStoppedInitialGroup(group, device); })();
    return publication;
  };
  const realSetTimeout = globalThis.setTimeout;
  const deadlines = [];
  // Accelerate only the operation-specific timer, not TLS, status, or publication.
  // No production timeout knob or wire change is introduced for this test.
  const timer = t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms > 5000) {
      deadlines.push(ms);
      return realSetTimeout(callback, 100, ...args);
    }
    return realSetTimeout(callback, ms, ...args);
  });
  try {
    await assert.rejects(member.startGroup(pin, true), error =>
      error.code === 'PEER_FRAME_TIMEOUT' && error.message === 'Frame read timed out');
    assert.deepEqual(deadlines, [120000], 'publication is bounded at the transport maximum, not unbounded');
    assert.equal(member.process, undefined);
    assert.equal((await member.getState()).servers.length, 0);
    assert.equal(await relay.custody(), null);
  } finally {
    timer.mock.restore();
    release();
    await publication;
    await relay.settled();
  }
  assert.equal(member.process, undefined, 'late publication is not permission for an automatic launch');
  assert.equal(owner.process, undefined);
  assert.equal((await relay.custody()).owner, pin, 'late callback safely parks, never transfers to timed-out member');
});

// Opt-in unmet acceptance: intentionally RED, not a fake GREEN report.
test('Start-only acceptance: parked serverless member starts with latest complete files under one action', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await editStopped(owner, 'latest'); const expected = await bytes(owner);
  await owner.parkAtRelay(); await relay.settled();
  await member.startGroup(pin, true);
  assert.equal((await member.getState()).server.state, 'running');
  assert.deepEqual(await bytes(member), expected);
  await member.saveRelay({ fingerprint: pin, parkOnStop: false });
  await member.stopServer();
  await relay.settled();
  assert.equal((await relay.custody()).state, 'owned', 'Stop publishes even legacy parkOnStop:false');
  assert.equal((await member.getState()).server.ownership.state, 'transferred');
});

test('Start-only acceptance: an existing stale member replica acquires latest B revision before A execution', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await configure(owner);
  await editStopped(owner, 'A'); await owner.parkAtRelay();
  await member.startGroup(pin, true); await relay.settled();
  await editStopped(member, 'B'); const expected = await bytes(member); // synthetic process never writes files
  await member.stopServer(); await relay.settled();
  await owner.startServer(true);
  assert.equal((await owner.getState()).server.state, 'running');
  assert.deepEqual(await bytes(owner), expected);
  await owner.stopServer();
});
