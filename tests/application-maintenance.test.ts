import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createIdentity } from '../src/core/peer-transport.js';
import { SeedHostApplication } from '../src/core/application.js';
import { OwnershipLedger } from '../src/core/ownership.js';
import { validateCall } from '../src/core/ipc-policy.js';
import { createSnapshot, materializeSnapshot } from '../src/core/snapshots.js';

const fixture = path.resolve('tools/fake-java-server.mjs');
async function setup(prefix: string) {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/' + prefix));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(source, 'world.bin'), 'original');
  const identity = await createIdentity();
  const app = new SeedHostApplication(path.join(root, 'profile'), identity);
  await app.open(); await app.importExisting(source, true);
  return { root, identity, app };
}
const renderer = 'file:///app/index.html';
const trusted = { senderId: 1, expectedSenderId: 1, isMainFrame: true };

test('launch profiles default to modpack-friendly start and stop timeouts', async () => {
  const { root, app } = await setup('launch-defaults-');
  try {
    await app.saveProfile({ executable: process.execPath, args: [fixture, '--lifetime-ms=30000'] });
    const profile = (await app.getState()).server!.profile;
    assert.equal(profile.startTimeoutSeconds, 600);
    assert.equal(profile.stopTimeoutSeconds, 180);
    await app.startServer(true);
    const launched = (app as any).process.profile;
    assert.equal(launched.startTimeoutMs, 600_000);
    assert.equal(launched.stopTimeoutMs, 180_000);
    await app.stopServer();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('custom launch timeouts persist and reach the process, and invalid budgets are refused', async () => {
  const { root, identity, app } = await setup('launch-custom-');
  try {
    await app.saveProfile({ executable: process.execPath, args: [fixture, '--lifetime-ms=30000'], startTimeoutSeconds: 1200, stopTimeoutSeconds: 300 });
    for (const bad of [4, 3601, 1.5, '600', null]) {
      await assert.rejects(app.saveProfile({ executable: process.execPath, args: [], startTimeoutSeconds: bad as any }), /timeout/i);
      assert.throws(() => validateCall('saveProfile', { executable: 'java', args: [], stopTimeoutSeconds: bad }, renderer, renderer, trusted), /timeout/i);
    }
    assert.deepEqual(validateCall('saveProfile', { executable: 'java', args: [], startTimeoutSeconds: 900, stopTimeoutSeconds: 120 }, renderer, renderer, trusted),
      { executable: 'java', args: [], startTimeoutSeconds: 900, stopTimeoutSeconds: 120 });
    await app.close();
    const reopened = new SeedHostApplication((app as any).root, identity);
    await reopened.open();
    try {
      await reopened.startServer(true);
      assert.equal((reopened as any).process.profile.startTimeoutMs, 1_200_000);
      assert.equal((reopened as any).process.profile.stopTimeoutMs, 300_000);
      await reopened.stopServer();
    } finally { await reopened.close(); }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('saved state written by the first alpha loads with default timeouts', async () => {
  const { root, identity, app } = await setup('launch-legacy-');
  try {
    await app.close();
    const file = path.join(root, 'profile', 'state.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    // Rewrite the current file as the first alpha wrote it: one server, no id, no launch timeouts.
    saved.version = 1;
    saved.server = { ...saved.servers[0] };
    delete saved.server.id;
    delete saved.servers;
    delete saved.activeServerId;
    saved.server.profile = { executable: process.execPath, args: [fixture] };
    await writeFile(file, JSON.stringify(saved));
    const reopened = new SeedHostApplication(path.join(root, 'profile'), identity);
    await reopened.open();
    assert.equal((await reopened.getState()).server!.profile.startTimeoutSeconds, 600);
    await reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('corrupt saved state is refused without being rewritten', async () => {
  const { root, identity, app } = await setup('state-corrupt-');
  try {
    await app.close();
    const file = path.join(root, 'profile', 'state.json');
    const valid = JSON.parse(await readFile(file, 'utf8'));
    const entry = valid.servers[0];
    for (const corrupt of [
      { ...valid, servers: [{ ...entry, snapshotId: '../escape' }] },
      { ...valid, servers: [{ ...entry, serverDir: 'relative/dir' }] },
      { ...valid, servers: [{ ...entry, ledgerFile: 42 }] },
      { ...valid, servers: [{ ...entry, profile: { executable: 'java', args: 'nogui' } }] },
      { ...valid, servers: [{ ...entry, id: 'not-hex' }] },
      { ...valid, activeServerId: 'f'.repeat(32) },
      { ...valid, peers: [{ name: 'x', fingerprint: 'nope', host: '127.0.0.1', port: 1 }] },
      { ...valid, version: 1 },
    ]) {
      const bytes = JSON.stringify(corrupt);
      await writeFile(file, bytes);
      await assert.rejects(new SeedHostApplication(path.join(root, 'profile'), identity).open(), /saved application state/i);
      assert.equal(await readFile(file, 'utf8'), bytes);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cleanup removes old execution directories and unreferenced revisions but keeps the current one', async () => {
  const { root, identity, app } = await setup('cleanup-');
  try {
    const server = (await app.getState()).server!;
    for (let i = 0; i < 3; i++) {
      await writeFile(path.join(server.serverDir, 'world.bin'), `edit ${i}`);
      await app.createSnapshot();
    }
    // Automatic retention already keeps only the current revision of ordinary history; cleanup still
    // has to remove an unreferenced revision, like one left behind by a failed publication.
    const unreferenced = await createSnapshot(server.serverDir, server.storeDir);
    const stale = path.join(root, 'profile', 'managed', 'servers', 'previous-execution');
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, 'world.bin'), 'old copy');
    const result = await app.cleanUp();
    assert.equal(result.serverDirsRemoved, 1);
    assert.ok(result.snapshotsRemoved >= 1);
    await assert.rejects(access(path.join(server.storeDir, 'snapshots', unreferenced.id + '.json')), /ENOENT/);
    await assert.rejects(access(stale), /ENOENT/);
    const current = (await app.getState()).server!;
    assert.equal(await readFile(path.join(current.serverDir, 'world.bin'), 'utf8'), 'edit 2');
    await materializeSnapshot(current.storeDir, current.snapshotId, path.join(root, 'verify'));
    assert.equal(await readFile(path.join(root, 'verify', 'world.bin'), 'utf8'), 'edit 2');
    await app.saveProfile({ executable: process.execPath, args: [fixture, '--lifetime-ms=30000'] });
    await app.startServer(true);
    await assert.rejects(app.cleanUp(), /stop/i);
    await app.stopServer();
    await new OwnershipLedger(current.ledgerFile, identity.fingerprint).markUncertain();
    await assert.rejects(app.cleanUp(), /uncertain|recover|ownership/i);
    assert.deepEqual(validateCall('cleanUp', undefined, renderer, renderer, trusted), {});
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
