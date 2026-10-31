import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ServerSetupClient, mojangRuntimePlatform } from '../dist/src/core/server-setup.js';

const sha1 = (buffer) => createHash('sha1').update(buffer).digest('hex');

/**
 * Six workers share the runtime download queue. When one fails, the others must be cancelled AND awaited before the
 * staging directory is removed — otherwise a worker that was still reading bytes recreates staging and keeps writing
 * after the setup already failed (the exact waste a low-storage PC cannot afford).
 */
test('a failed Java runtime download drains every worker before staging is removed', async (t) => {
  assert.ok(process.env.TMPDIR, 'Hermes scratch TMPDIR is required');
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'runtime-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtimes');
  const good = Buffer.from('synthetic official runtime file');
  const platform = mojangRuntimePlatform();
  assert.ok(platform, 'this host has a Mojang runtime platform');
  const manifest = Buffer.from(JSON.stringify({
    files: {
      'bin/java.exe': { type: 'file', downloads: { raw: { url: 'https://piston-data.mojang.com/java', sha1: sha1(good), size: good.length } } },
      'bad.bin': { type: 'file', downloads: { raw: { url: 'https://piston-data.mojang.com/bad', sha1: sha1(good), size: good.length } } },
      'late/payload.bin': { type: 'file', downloads: { raw: { url: 'https://piston-data.mojang.com/late', sha1: sha1(good), size: good.length } } },
    },
  }));
  const client = new ServerSetupClient();
  let releaseLate, lateStarted, lateWrote = false;
  const late = new Promise((resolve) => { releaseLate = resolve; });
  const started = new Promise((resolve) => { lateStarted = resolve; });
  client.bytes = async (url, _hosts, _maxBytes, operation) => {
    const target = String(url);
    if (target.endsWith('/all.json')) {
      return Buffer.from(JSON.stringify({ [platform]: { 'audit-runtime': [{ manifest: { url: 'https://piston-meta.mojang.com/runtime-manifest', sha1: sha1(manifest) } }] } }));
    }
    if (target.endsWith('/runtime-manifest')) return manifest;
    if (target.endsWith('/bad')) { await started; return Buffer.alloc(good.length, 0); }
    if (target.endsWith('/late')) {
      lateStarted();
      // Honours the abort the generator must propagate; a plain timeout would let the worker finish on its own.
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { lateWrote = true; resolve(good); }, 150);
        const abort = () => { clearTimeout(timer); reject(new Error('download aborted')); };
        if (operation?.aborted) abort();
        else operation?.addEventListener('abort', abort, { once: true });
      });
    }
    if (target.endsWith('/java')) return good;
    throw new Error(`Unexpected fixture URL ${target}`);
  };
  // A system Java would short-circuit the download entirely.
  const savedPath = process.env.PATH, savedJava = process.env.JAVA_HOME;
  delete process.env.JAVA_HOME; process.env.PATH = '';
  let error;
  try {
    await client.ensureJava(runtimeRoot, 21, 'audit-runtime', new AbortController().signal);
  } catch (caught) { error = caught; }
  finally {
    process.env.PATH = savedPath;
    if (savedJava !== undefined) process.env.JAVA_HOME = savedJava;
  }
  assert.equal(lateWrote, false, 'the pending worker is cancelled, not allowed to finish');
  assert.match(error?.message ?? '', /integrity check failed/i);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const leftovers = await readdir(runtimeRoot).catch(() => []);
  assert.deepEqual(leftovers, [], 'no worker recreates staging after cleanup');
});
