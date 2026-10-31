import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { OwnershipLedger } from '../dist/src/core/ownership.js';
import { materializeSnapshot } from '../dist/src/core/snapshots.js';
import { validateCall } from '../dist/src/core/ipc-policy.js';

const renderer = 'file:///app/index.html';
const trusted = { senderId: 1, expectedSenderId: 1, isMainFrame: true };

async function setup(prefix) {
  assert.ok(process.env.TMPDIR, 'Hermes scratch TMPDIR is required for isolated profiles');
  await mkdir(process.env.TMPDIR, { recursive: true });
  const root = await mkdtemp(path.join(process.env.TMPDIR, prefix));
  const identity = await createIdentity();
  const profile = path.join(root, 'profile');
  const app = new SeedHostApplication(profile, identity);
  await app.open();
  return { root, identity, app, profile };
}
async function stoppedSource(root, name) {
  const dir = path.join(root, name);
  await mkdir(dir);
  await writeFile(path.join(dir, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(dir, 'world.bin'), name);
  return dir;
}
const exists = async (file) => { try { await access(file); return true; } catch { return false; } };

test('importing a second server keeps the first and makes the newest active', async () => {
  const { root, app } = await setup('library-two-');
  try {
    const alpha = await stoppedSource(root, 'alpha');
    const bravo = await stoppedSource(root, 'bravo');
    await app.importExisting(alpha, true);
    await app.importExisting(bravo, true);
    const state = await app.getState();
    assert.equal(state.servers.length, 2);
    assert.equal(state.server.name, 'bravo');
    assert.ok(state.servers.every((entry) => typeof entry.id === 'string' && entry.id.length > 0));
    assert.deepEqual(state.servers.map((entry) => entry.name).sort(), ['alpha', 'bravo']);
    assert.equal(state.servers.filter((entry) => entry.active).length, 1);
    assert.equal(state.servers.find((entry) => entry.active).name, 'bravo');
    await access(path.join(state.server.serverDir, 'world.bin'));
    await access(path.join(alpha, 'world.bin'));
    await access(path.join(bravo, 'world.bin'));
    const stored = JSON.parse(await readFile(path.join(root, 'profile', 'state.json'), 'utf8'));
    assert.equal(stored.version, 2);
    assert.equal(stored.servers.length, 2);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('library summaries expose validated player ports for every registered server without selection', async () => {
  const { root, app } = await setup('library-ports-');
  try {
    const alpha = await stoppedSource(root, 'alpha');
    const bravo = await stoppedSource(root, 'bravo');
    await writeFile(path.join(alpha, 'server.properties'), 'server-port=25571\n');
    await writeFile(path.join(bravo, 'server.properties'), 'server-port = 25582\n');
    await app.importExisting(alpha, true);
    const alphaManaged = (await app.getState()).server;
    await app.importExisting(bravo, true);
    const state = await app.getState();
    assert.equal(state.server.name, 'bravo');
    assert.deepEqual(state.servers.map(({ name, playerPort }) => ({ name, playerPort })), [
      { name: 'alpha', playerPort: 25571 }, { name: 'bravo', playerPort: 25582 },
    ]);
    // Re-read managed properties, not cached active-server data; invalid and missing files
    // use the validated reader's default even for an inactive library entry.
    await writeFile(path.join(alphaManaged.serverDir, 'server.properties'), 'server-port=65536\n');
    await rm(path.join(state.server.serverDir, 'server.properties'));
    const fallback = await app.getState();
    assert.deepEqual(fallback.servers.map(entry => entry.playerPort), [25565, 25565]);
    assert.equal(fallback.server.id, state.server.id);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('selecting a server switches the active one and the choice survives a restart', async () => {
  const { root, app, identity, profile } = await setup('library-select-');
  try {
    await app.importExisting(await stoppedSource(root, 'alpha'), true);
    await app.importExisting(await stoppedSource(root, 'bravo'), true);
    const alphaId = (await app.getState()).servers.find((entry) => entry.name === 'alpha').id;
    await app.selectServer(alphaId);
    assert.equal((await app.getState()).server.name, 'alpha');
    await app.close();
    const reopened = new SeedHostApplication(profile, identity);
    await reopened.open();
    try {
      const state = await reopened.getState();
      assert.equal(state.server.name, 'alpha');
      assert.equal(state.servers.length, 2);
    } finally { await reopened.close(); }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('deleting a server removes only its managed copies and keeps the originals', async () => {
  const { root, app } = await setup('library-delete-');
  try {
    const alpha = await stoppedSource(root, 'alpha');
    const bravo = await stoppedSource(root, 'bravo');
    await app.importExisting(alpha, true);
    const keep = (await app.getState()).server;
    await app.importExisting(bravo, true);
    const doomed = (await app.getState()).server;
    assert.notEqual(doomed.id, keep.id);
    await app.deleteServer(doomed.id);
    const state = await app.getState();
    assert.equal(state.servers.length, 1);
    assert.equal(state.server.id, keep.id);
    assert.equal(await exists(doomed.serverDir), false);
    assert.equal(await exists(doomed.ledgerFile), false);
    // The content store is shared by every server here: it survives, and the server that stays still restores.
    assert.equal(await exists(doomed.storeDir), true);
    assert.equal(await exists(keep.serverDir), true);
    const restored = path.join(root, 'restored');
    await materializeSnapshot(keep.storeDir, keep.snapshotId, restored);
    assert.equal(await readFile(path.join(restored, 'world.bin'), 'utf8'), 'alpha');
    assert.equal(await exists(path.join(alpha, 'world.bin')), true);
    assert.equal(await exists(path.join(bravo, 'world.bin')), true);
    const stored = JSON.parse(await readFile(path.join(root, 'profile', 'state.json'), 'utf8'));
    assert.deepEqual(stored.servers.map((entry) => entry.id), [keep.id]);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('freeing up space keeps every server in the library and their backups', async () => {
  const { root, app } = await setup('library-cleanup-');
  try {
    await app.importExisting(await stoppedSource(root, 'alpha'), true);
    const alpha = (await app.getState()).server;
    await app.importExisting(await stoppedSource(root, 'bravo'), true);
    const bravo = (await app.getState()).server;
    await writeFile(path.join(bravo.serverDir, 'world.bin'), 'edit');
    await app.createSnapshot();
    const current = (await app.getState()).server;
    await app.cleanUp();
    const after = await app.getState();
    assert.equal(after.servers.length, 2);
    assert.equal(await exists(alpha.serverDir), true, 'another server folder is never a cleanup target');
    assert.equal(await exists(current.serverDir), true);
    const restored = path.join(root, 'kept');
    await materializeSnapshot(current.storeDir, current.snapshotId, restored);
    assert.equal(await readFile(path.join(restored, 'world.bin'), 'utf8'), 'edit');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('deleting the last server returns the app to the empty state', async () => {
  const { root, app } = await setup('library-delete-last-');
  try {
    await app.importExisting(await stoppedSource(root, 'only'), true);
    const only = (await app.getState()).server;
    await app.deleteServer(only.id);
    const state = await app.getState();
    assert.equal(state.server, null);
    assert.deepEqual(state.servers, []);
    assert.equal(await exists(only.serverDir), false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('a server whose custody is not safely held here cannot be deleted or swapped away', async () => {
  const { root, app, identity } = await setup('library-guard-');
  try {
    await app.importExisting(await stoppedSource(root, 'alpha'), true);
    const alpha = (await app.getState()).server;
    await app.importExisting(await stoppedSource(root, 'bravo'), true);
    const bravo = (await app.getState()).server;
    await new OwnershipLedger(alpha.ledgerFile, identity.fingerprint).markUncertain();
    await assert.rejects(app.deleteServer(alpha.id), /recover|uncertain|ownership/i);
    assert.equal((await app.getState()).servers.length, 2);
    const offer = await new OwnershipLedger(bravo.ledgerFile, identity.fingerprint).prepareTransfer('f'.repeat(64), bravo.snapshotId);
    assert.ok(offer.id);
    await assert.rejects(app.selectServer(alpha.id), /handoff|pending|transfer|stop/i);
    assert.equal((await app.getState()).server.id, bravo.id);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('switching is refused while a server is running', async () => {
  const { root, app } = await setup('library-running-');
  try {
    await app.importExisting(await stoppedSource(root, 'alpha'), true);
    await app.importExisting(await stoppedSource(root, 'bravo'), true);
    const alphaId = (await app.getState()).servers.find((entry) => entry.name === 'alpha').id;
    await app.saveProfile({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] });
    await app.startServer(true);
    try { await assert.rejects(app.selectServer(alphaId), /stop the server/i); }
    finally { await app.stopServer(); }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('a single-server state file from before the library still loads and is rewritten as a list', async () => {
  const { root, app, identity, profile } = await setup('library-legacy-');
  try {
    await app.importExisting(await stoppedSource(root, 'legacy'), true);
    await app.close();
    const file = path.join(profile, 'state.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.version = 1;
    saved.server = saved.servers[0];
    delete saved.server.id;
    delete saved.servers;
    delete saved.activeServerId;
    await writeFile(file, JSON.stringify(saved));
    const reopened = new SeedHostApplication(profile, identity);
    await reopened.open();
    try {
      const state = await reopened.getState();
      assert.equal(state.servers.length, 1);
      assert.equal(state.server.name, 'legacy');
      assert.equal(state.servers[0].active, true);
      // The migration is in memory; the next real change writes the list form, without losing the entry.
      await reopened.saveProfile({ executable: process.execPath, args: ['--version'] });
      const rewritten = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(rewritten.version, 2);
      assert.equal(rewritten.servers.length, 1);
      assert.equal(rewritten.activeServerId, rewritten.servers[0].id);
      assert.equal(rewritten.servers[0].serverDir, state.server.serverDir);
      assert.equal(rewritten.servers[0].ledgerFile, state.server.ledgerFile);
      assert.equal(rewritten.servers[0].snapshotId, state.server.snapshotId);
    } finally { await reopened.close(); }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('library IPC accepts only a well-formed server id', () => {
  const id = 'a'.repeat(32);
  assert.deepEqual(validateCall('selectServer', { id }, renderer, renderer, trusted), { id });
  assert.deepEqual(validateCall('deleteServer', { id }, renderer, renderer, trusted), { id });
  for (const bad of [{ id: 'A'.repeat(32) }, { id: 'a'.repeat(31) }, { id: '../escape' }, { id: '' }, { id: 'a'.repeat(33) }]) {
    assert.throws(() => validateCall('selectServer', bad, renderer, renderer, trusted));
    assert.throws(() => validateCall('deleteServer', bad, renderer, renderer, trusted));
  }
  assert.throws(() => validateCall('selectServer', { id, extra: 1 }, renderer, renderer, trusted));
  assert.throws(() => validateCall('deleteServer', { id: 'a'.repeat(32) + '\n' }, renderer, renderer, trusted));
  assert.throws(() => validateCall('deleteServer', undefined, renderer, renderer, trusted));
});

/**
 * Startup refuses a library above the supported size, so a mutation that persists one would make the whole library
 * unopenable. The refusal must happen before any copy or download work.
 */
test('a full library refuses another import without copying or corrupting state', async () => {
  const { root, profile, app, identity } = await setup('library-capacity-');
  try {
    await app.importExisting(await stoppedSource(root, 'seed'), true);
    await app.close();
    const file = path.join(profile, 'state.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    const template = saved.servers[0];
    // A pre-existing library at the documented maximum (200): valid, openable, and already full.
    saved.servers = Array.from({ length: 200 }, (_, index) => ({
      ...template, id: index.toString(16).padStart(32, '0'), name: `world ${index}`,
      serverDir: path.join(profile, 'managed', 'servers', index.toString(16).padStart(32, '0')),
    }));
    saved.activeServerId = saved.servers[saved.servers.length - 1].id;
    await writeFile(file, JSON.stringify(saved));
    const reopened = new SeedHostApplication(profile, identity);
    await reopened.open();
    try {
      assert.equal((await reopened.getState()).servers.length, 200);
      const managed = path.join(profile, 'managed', 'servers');
      const before = (await readdir(managed)).length;
      const overflow = await stoppedSource(root, 'overflow');
      await assert.rejects(reopened.importExisting(overflow, true), /library is full/i);
      assert.equal((await readdir(managed)).length, before, 'no managed copy is created for a refused import');
      assert.equal(JSON.parse(await readFile(file, 'utf8')).servers.length, 200, 'refused import never persists');
      assert.equal(await readFile(path.join(overflow, 'world.bin'), 'utf8'), 'overflow', 'the source folder is untouched');
    } finally { await reopened.close(); }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
