import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { RelayNode } from '../dist/src/core/relay.js';
import { SeedHostApplication } from '../dist/src/core/application.js';

/**
 * `open()` refuses more than 20 pending hosting groups. Membership enrollment is a mutation, so it must never persist
 * a 21st entry: that would make the entire library unopenable on the next launch.
 */
test('joining more hosting groups than the state format accepts is refused before remote enrollment', async (t) => {
  assert.ok(process.env.TMPDIR, 'Hermes scratch TMPDIR is required for isolated profiles');
  await mkdir(process.env.TMPDIR, { recursive: true });
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'group-capacity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  const identity = await createIdentity();
  const app = new SeedHostApplication(profile, identity);
  await app.open();
  const relays = [];
  try {
    for (let index = 0; index < 20; index++) {
      const relay = new RelayNode(path.join(root, `relay-${index}`), await createIdentity(), { name: `Group ${index}`, log: () => {} });
      relays.push(relay);
      await relay.open();
      await relay.listen({ host: '127.0.0.1', port: 0 });
      const invite = await relay.createInvite();
      const joined = await app.joinHostingGroup({ code: invite.code, name: `member ${index}` });
      assert.equal(joined.pending, true);
    }
    assert.equal((await app.getState()).pendingGroups.length, 20);
    // One more group: refused locally, so the relay never gains this PC as a member.
    const overflow = new RelayNode(path.join(root, 'relay-overflow'), await createIdentity(), { name: 'One too many', log: () => {} });
    relays.push(overflow);
    await overflow.open();
    await overflow.listen({ host: '127.0.0.1', port: 0 });
    const invite = await overflow.createInvite();
    await assert.rejects(app.joinHostingGroup({ code: invite.code, name: 'overflow member' }), /maximum of 20 hosting groups/i);
    assert.equal(overflow.trusted.length, 0, 'a refused join never redeems the invitation');
    assert.equal((await app.getState()).pendingGroups.length, 20);
    await app.close();
    const reopened = new SeedHostApplication(profile, identity);
    await reopened.open();
    try {
      assert.equal((await reopened.getState()).pendingGroups.length, 20, 'the saved profile still opens');
    } finally { await reopened.close(); }
    assert.equal(JSON.parse(await readFile(path.join(profile, 'state.json'), 'utf8')).pendingGroups.length, 20);
  } finally {
    await app.close().catch(() => {});
    for (const relay of relays) await relay.close().catch(() => {});
  }
});
