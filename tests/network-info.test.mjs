import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { privateLanAddresses, readServerPort } from '../dist/src/core/network-info.js';

test('only private, non-internal IPv4 addresses are offered as LAN join addresses', () => {
  const interfaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    wg0: [{ address: '10.8.0.2', family: 'IPv4', internal: false }],
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    wan: [{ address: '203.0.113.9', family: 'IPv4', internal: false }],
    tailscale0: [{ address: '100.97.20.84', family: 'IPv4', internal: false }],
  };
  assert.deepEqual(privateLanAddresses(interfaces), ['192.168.1.20', '10.8.0.2']);
});

test('server port comes from server.properties, defaulting to 25565', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seedhost-port-'));
  assert.equal(await readServerPort(dir), 25565);
  await writeFile(path.join(dir, 'server.properties'), '#comment\nmotd=hi\nserver-port=25570\n');
  assert.equal(await readServerPort(dir), 25570);
  await writeFile(path.join(dir, 'server.properties'), 'server-port=banana\n');
  assert.equal(await readServerPort(dir), 25565);
});

/**
 * Public-tunnel reservations and launch admission must agree with the port the JVM actually binds. Java properties
 * allow a colon separator, escaped keys and repeat keys where the LAST value wins, so a "first simple match" reader
 * can hand a safety guard a different port than the server uses.
 */
test('every reader agrees on the effective Minecraft port for valid Java property forms', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seedhost-port-effective-'));
  const { readServerProperties } = await import('../dist/src/core/server-properties.js');
  const forms = {
    'repeat keys (last wins)': 'server-port=25565\nserver-port=25566\n',
    'colon separator': 'server-port:25566\n',
    'escaped key': 'server\\u002dport=25566\n',
    'spaced separator': 'server-port : 25566\n',
  };
  for (const [label, text] of Object.entries(forms)) {
    await writeFile(path.join(dir, 'server.properties'), text);
    assert.equal(readServerProperties(text)['server-port'], '25566', label);
    assert.equal(await readServerPort(dir), 25566, `${label} must report the effective port`);
  }
});

/**
 * The public-route guard reserves raw Minecraft ports per world. It must be given the SAME effective port the JVM
 * binds; otherwise a world can be launched onto a port another world's retained public tunnel already owns.
 */
test('the public port reservation guard sees the effective bound port', async () => {
  const { createHash } = await import('node:crypto');
  const { mkdir } = await import('node:fs/promises');
  const { PerServerPublicAddresses } = await import('../dist/src/core/public-address.js');
  const root = await mkdtemp(path.join(tmpdir(), 'seedhost-port-guard-'));
  const world = path.join(root, 'world-b');
  await mkdir(world);
  // A retained, locally disconnected route still owns 25566 for another world.
  const reservation = path.join(root, 'public-servers', createHash('sha256').update('world-a').digest('hex'), 'public-address');
  await mkdir(reservation, { recursive: true });
  await writeFile(path.join(reservation, 'playit.json'), JSON.stringify({
    version: 1, enabled: false, serverId: 'world-a', tunnelName: 'retained-world-a', target: { host: '127.0.0.1', port: 25566 },
  }));
  const manager = new PerServerPublicAddresses(root, {});
  try {
    for (const text of ['server-port=25565\nserver-port=25566\n', 'server-port:25566\n', 'server\\u002dport=25566\n']) {
      await writeFile(path.join(world, 'server.properties'), text);
      const port = await readServerPort(world);
      assert.equal(port, 25566);
      await assert.rejects(manager.assertCanStart({ id: 'world-b', playerPort: port }), /reserved by another public server/, text);
    }
  } finally { await manager.close(); }
});
