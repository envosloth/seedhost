import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

// Headed Electron + REAL renderer, TEST-ONLY deterministic bridge; no backend/network/Minecraft claims.
let app, page, root;
const errors = [];
before(async () => {
  const scratch = process.env.TMPDIR || (process.platform === 'win32' && path.join(process.env.LOCALAPPDATA, 'hermes/cache/scratch'));
  if (!scratch) throw new Error('Hermes scratch TMPDIR required');
  root = await mkdtemp(path.join(scratch, 'seed-dashboard-renderer-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('tools/dashboard-fixture-main.cjs'), '--profile-root=' + root], env });
  page = await app.firstWindow(); page.setDefaultTimeout(7000);
  page.on('pageerror', e => errors.push(e.message));
});
after(async () => { if (app) { app.process().kill(); await app.close().catch(() => {}); } });
async function reset() {
  await page.bringToFront(); await page.evaluate(() => window.dashboardFixture.reset()); await page.reload();
  await page.waitForFunction(() => document.querySelector('#splash').hidden);
}
async function click(selector) { await page.bringToFront(); await page.locator(selector).click(); }
const fixture = () => page.evaluate(() => window.dashboardFixture.read());
const settle = () => page.waitForFunction(() => document.querySelector('#activity-message').textContent === 'Ready');
async function set(value) { await page.evaluate(v => window.dashboardFixture.set(v), value); await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await settle(); }

test('slow actions display an animated loading status until verified completion', async () => {
  await reset(); const f=await fixture();f.state.relay={name:'Group',fingerprint:'c'.repeat(64),parkOnStop:false};
  await set({state:f.state,holdGroupOp:true}); await click('#server-list [data-action="open"][data-id="alpha"]');await click('#peers-tab');
  try {
    await click('#disband-group');await page.waitForFunction(()=>window.dashboardFixture.read().groupHeld);
    assert.equal(await page.locator('#action-loading').isVisible(),true,'a held real renderer action has visible progress');
    assert.match(await page.locator('#action-loading').textContent(), /disband|working/i);
    assert.equal(await page.locator('#action-loading').getAttribute('role'),'status');
    assert.notEqual(await page.locator('#action-loading .loading-spinner').evaluate(el=>getComputedStyle(el).animationName),'none');
  } finally { await page.evaluate(()=>window.dashboardFixture.release()); }
  await settle();await page.waitForFunction(()=>document.querySelector('#action-loading').hidden);
  assert.match(await page.locator('#disband-feedback').textContent(),/Verified disband/);
});

test('account actions show progress inside the setup modal and clear it after a rejected request', async () => {
  await reset(); const f=await fixture();f.state.onboarding.step='friends';
  await set({state:f.state,accountStatus:{configured:true,signedIn:true,online:true,username:'alex',detail:'Signed in'},holdFriendOp:'accountFriendSend',failFriendOp:'accountFriendSend'});
  await page.evaluate(()=>window.dispatchEvent(new Event('seedhost-account-changed')));await click('#nav-setup');
  await page.locator('#setup-friend-username').fill('taylor');
  try {
    await click('#setup-friend-send');await page.waitForFunction(()=>window.dashboardFixture.read().heldFriend);
    assert.equal(await page.locator('#setup-dialog [data-loading-context="dialog"]').isVisible(),true,'native modal progress cannot live behind the inert backdrop');
    assert.equal(await page.locator('#setup-friend-send').isDisabled(),true);
  } finally {await page.evaluate(()=>window.dashboardFixture.release());}
  await page.waitForFunction(()=>document.querySelector('#setup-friend-feedback').textContent.includes('TEST failure'));
  await page.waitForFunction(()=>document.querySelector('#action-loading').hidden);
  assert.equal(await page.locator('#setup-dialog [data-loading-context="dialog"]').isHidden(),true);
  assert.equal(await page.locator('#setup-friend-send').isEnabled(),true);
});

test('overlapping metadata loads keep progress visible until every load settles', async () => {
  await reset();await page.evaluate(()=>window.dashboardFixture.set({holdCalls:['listServerVersions','discoverJava']}));
  try {
    await click('#nav-setup');await page.waitForFunction(()=>Object.keys(window.dashboardFixture.read().heldCalls||{}).length===2);
    assert.equal(await page.locator('#setup-dialog [data-loading-context="dialog"]').isVisible(),true);
    await page.evaluate(()=>window.dashboardFixture.releaseCall('listServerVersions'));
    await page.waitForFunction(()=>!window.dashboardFixture.read().heldCalls?.listServerVersions);
    assert.equal(await page.locator('#action-loading').isVisible(),true,'one completed request must not clear another pending request');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.locator('#action-loading .loading-spinner').evaluate(el=>getComputedStyle(el).animationName),'none');
  } finally {
    await page.evaluate(()=>{window.dashboardFixture.releaseCall('listServerVersions');window.dashboardFixture.releaseCall('discoverJava');});
    await page.emulateMedia({reducedMotion:'no-preference'});
  }
  await page.waitForFunction(()=>document.querySelector('#action-loading').hidden);
});

test('manual performance refresh shows loading while automatic sampling stays quiet', async () => {
  await reset();await click('#server-list [data-action="open"][data-id="alpha"]');await click('#operate-tab');
  await page.waitForFunction(()=>document.querySelector('#dashboard-status').textContent==='Updated from this server');
  await page.evaluate(()=>window.dashboardFixture.set({holdCalls:['getServerDashboard']}));
  try {
    await click('#dashboard-refresh');await page.waitForFunction(()=>window.dashboardFixture.read().heldCalls?.getServerDashboard);
    assert.equal(await page.locator('#action-loading').isVisible(),true);
  } finally {await page.evaluate(()=>window.dashboardFixture.releaseCall('getServerDashboard'));}
  await page.waitForFunction(()=>document.querySelector('#action-loading').hidden);
});

test('public-address actions keep a loading animation while the backend is pending', async () => {
  await reset();await click('#server-list [data-action="open"][data-id="alpha"]');await click('#tunnels-tab');
  await page.evaluate(()=>window.dashboardFixture.set({holdCalls:['publicAddressEnable']}));
  try {
    await click('#public-go');await page.waitForFunction(()=>window.dashboardFixture.read().heldCalls?.publicAddressEnable);
    assert.equal(await page.locator('#action-loading').isVisible(),true);
    assert.match(await page.locator('#action-loading').textContent(),/public address/i);
  } finally {await page.evaluate(()=>window.dashboardFixture.releaseCall('publicAddressEnable'));}
  await page.waitForFunction(()=>document.querySelector('#action-loading').hidden);
});

test('manual friend-inbox refresh has progress without animating routine account polling', async () => {
  await reset();await page.evaluate(()=>window.dashboardFixture.set({accountStatus:{configured:true,signedIn:true,online:true,username:'alex',detail:'Signed in'}}));
  await page.evaluate(()=>window.dispatchEvent(new Event('seedhost-account-changed')));await click('#friends-tab');
  await page.waitForFunction(()=>!document.querySelector('#friend-requests-refresh').disabled);
  await page.evaluate(()=>window.dashboardFixture.set({holdCalls:['accountFriendRequests']}));
  try {
    await click('#friend-requests-refresh');await page.waitForFunction(()=>window.dashboardFixture.read().heldCalls?.accountFriendRequests);
    assert.equal(await page.locator('#action-loading').isVisible(),true);
  } finally {await page.evaluate(()=>window.dashboardFixture.releaseCall('accountFriendRequests'));}
  await page.waitForFunction(()=>document.querySelector('#action-loading').hidden);
});

test('disband refuses a forged success with unchanged group readback', async () => {
  await reset();const f=await fixture();f.state.relay={name:'Group',fingerprint:'c'.repeat(64),parkOnStop:false};await set({state:f.state,disbandReadbackMismatch:true});await click('#server-list [data-action="open"][data-id="alpha"]');await click('#peers-tab');await click('#disband-group');
  await page.waitForFunction(()=>document.querySelector('#disband-feedback').textContent.includes('could not be confirmed'));
  assert.doesNotMatch(await page.locator('#disband-feedback').textContent(),/Verified disband/);assert.ok((await fixture()).state.relay);
});

test('disband stale A-B-A completion cannot overwrite the newer group feedback', async () => {
  await reset();const f=await fixture();f.state.relay={name:'Group',fingerprint:'c'.repeat(64),parkOnStop:false};await set({state:f.state,holdGroupOp:true});await click('#server-list [data-action="open"][data-id="alpha"]');await click('#peers-tab');await click('#disband-group');
  await page.waitForFunction(()=>window.dashboardFixture.read().groupHeld);
  await page.evaluate(()=>{const f=window.dashboardFixture.read(),a=f.state,b=structuredClone(a);b.server=f.serverMap.bravo;b.servers.forEach(s=>s.active=s.id==='bravo');window.seedDashboard.update(b,false);window.seedDashboard.update(a,false);document.querySelector('#disband-feedback').textContent='Newer group feedback';window.dashboardFixture.release();});await settle();
  assert.equal(await page.locator('#disband-feedback').textContent(),'Newer group feedback');
});

test('clearing a numeric property never silently saves zero', async () => {
  await reset();await click('#server-list [data-action="open"][data-id="alpha"]');await click('#server-settings-tab');
  await page.locator('#property-spawn-protection').fill('12');await page.locator('#property-spawn-protection').fill('');await click('#properties-save');await settle();
  assert.equal((await fixture()).calls.some(c=>c.method==='saveServerSettings'),false);
});

test('Multi-host disband captures selected group, cancellation retains it, and verifies local readback', async () => {
  await reset();const f=await fixture();f.state.relay={name:'Group',fingerprint:'c'.repeat(64),parkOnStop:false};await set({state:f.state,cancelMethod:'disbandGroup'});
  await click('#server-list [data-action="open"][data-id="alpha"]');await click('#peers-tab');
  assert.equal(await page.locator('#disband-group').isEnabled(),true);await click('#disband-group');await settle();
  assert.equal((await fixture()).state.relay.fingerprint,'c'.repeat(64));assert.doesNotMatch(await page.locator('#disband-feedback').textContent(),/Verified disband/);
  await page.evaluate(()=>window.dashboardFixture.set({cancelMethod:null}));await click('#disband-group');
  await page.waitForFunction(()=>document.querySelector('#disband-feedback').textContent.includes('Verified disband'));
  assert.equal((await fixture()).state.relay,null);const call=(await fixture()).calls.find(c=>c.method==='disbandGroup');assert.deepEqual(call.payload,{id:'alpha',fingerprint:'c'.repeat(64)});
});

test('Multi-host offers explicit optional always-on enable and disable without opening the wizard', async () => {
  await reset();await click('#server-list [data-action="open"][data-id="alpha"]');await click('#peers-tab');
  assert.equal(await page.locator('#multi-always-on-enable').isVisible(),true);assert.equal(await page.locator('#multi-always-on-disable').isVisible(),true);
  assert.match(await page.locator('#multi-always-on-help').textContent(),/optional|off by default/i);
  await click('#multi-always-on-enable');await settle();assert.ok((await fixture()).calls.some(c=>c.method==='alwaysOnEnable'));
  assert.equal(await page.locator('#setup-dialog').isVisible(),false);
  await click('#multi-always-on-disable');await settle();assert.ok((await fixture()).calls.some(c=>c.method==='alwaysOnDisable'));
});

test('signed-in guide sends and accepts friends inline while preserving progress and navigation', async () => {
  await reset(); const f=await fixture(); f.state.onboarding.step='friends';
  await set({state:f.state,accountStatus:{configured:true,signedIn:true,online:true,username:'alex',detail:'Signed in'},accountFriendRequests:[{id:'request-sam',from:'sam'}]});
  await page.evaluate(()=>window.dispatchEvent(new Event('seedhost-account-changed')));await click('#nav-setup');
  await page.waitForFunction(()=>!document.querySelector('#setup-friends').hidden);
  assert.equal(await page.locator('#setup-friend-add-form').isVisible(),true);
  await page.locator('#setup-friend-username').fill('taylor'); await click('#setup-friend-send');
  await page.waitForFunction(()=>document.querySelector('#setup-friend-feedback').textContent.includes('sent to @taylor'));
  assert.equal(await page.locator('#setup-dialog').isVisible(),true);
  await click('#setup-friend-request-list [data-friend-accept="request-sam"]');
  await page.waitForFunction(()=>document.querySelector('#setup-friend-feedback').textContent.includes('now friends'));
  assert.ok((await fixture()).accountFriends.some(f=>f.username==='sam'));
  assert.equal(await page.locator('#setup-dialog').isVisible(),true);
  assert.equal((await fixture()).calls.some(c=>c.method==='accountSend'||c.method==='accountStartGroup'),false);
  await click('#setup-back');await settle();assert.equal(await page.locator('#setup-runtime').isVisible(),true);
  await click('#setup-next');await settle();await click('#setup-next');await settle();
    assert.equal((await fixture()).state.onboarding.friendsConfigured,'accepted');
});

test('Hardcore and safe additional controls save only edited fields and verify readback', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="alpha"]'); await click('#server-settings-tab');
  for (const id of ['hardcore', 'allow-flight', 'spawn-protection']) assert.equal(await page.locator('#property-' + id).count(), 1);
  await page.locator('#property-hardcore').check(); await page.locator('#property-allow-flight').check(); await page.locator('#property-spawn-protection').fill('0');
  await click('#properties-save'); await page.waitForFunction(() => document.querySelector('#properties-feedback').textContent.includes('Verified'));
  const saved=(await fixture()).calls.find(c=>c.method==='saveServerSettings');
  assert.deepEqual(saved.payload.settings,{hardcore:true,'spawn-protection':0,'allow-flight':true});
});

test('performance rounds measured floats to at most two decimals and rejects nonfinite or missing samples', async () => {
  await reset(); const f=await fixture(); f.dashboard.alpha.performance={pid:123,cpuPercent:12.3456789,memoryMiB:512.987654,uptimeSeconds:61.98765};
  await set({dashboard:f.dashboard}); await click('#server-list [data-action="open"][data-id="alpha"]'); await click('#operate-tab');
  await page.waitForFunction(()=>document.querySelector('#performance-cpu').textContent!=='Unavailable');
  assert.equal(await page.locator('#performance-cpu').textContent(),'12.35%'); assert.equal(await page.locator('#performance-memory').textContent(),'512.99 MiB');
  f.dashboard.alpha.performance={pid:null,cpuPercent:null,memoryMiB:null,uptimeSeconds:null}; await set({dashboard:f.dashboard});await click('#dashboard-refresh');
  await page.waitForFunction(()=>document.querySelector('#performance-cpu').textContent==='Unavailable');
  assert.equal(await page.locator('#performance-memory').textContent(),'Unavailable');
});

test('performance scales large measured memory to GiB without changing unavailable samples', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="alpha"]'); await click('#operate-tab');
  for (const [memoryMiB, expected] of [[1200, '1.2 GiB'], [1024, '1 GiB'], [16384, '16 GiB'], [1023, '1023 MiB'], [0, '0 MiB'], [null, 'Unavailable'], [-1, 'Unavailable']]) {
    const f=await fixture(); f.dashboard.alpha.performance={pid:123,cpuPercent:0,memoryMiB,uptimeSeconds:10};
    await set({dashboard:f.dashboard}); await click('#dashboard-refresh');
    await page.waitForFunction(expected=>document.querySelector('#performance-memory').textContent===expected, expected);
    assert.equal(await page.locator('#performance-memory').textContent(), expected);
  }
});

test('Friends and Multi-host keep one account card in the Friends page without moving it between contexts', async () => {
  await reset(); await click('#friends-tab');
  assert.equal(await page.locator('#friend-code, #invite-code, #create-invite, #friends-intent-join, #friends-intent-invite').count(), 0, 'manual enrollment is removed, not hidden');
  assert.match(await page.locator('#account-directory-note').textContent(), /shared directory.*usernames/i);
  assert.equal(await page.locator('#account-open').isDisabled(), true);
  assert.equal(await page.locator('#friends-panel #account-card').isVisible(), true);
  assert.equal(await page.locator('#friends-panel #account-card').count(), 1);
  await click('#home-tab'); await click('#server-list [data-action="open"][data-id="alpha"]'); await click('#peers-tab');
  assert.equal(await page.locator('#peers-panel #hosting-card').isVisible(), true);
  assert.equal(await page.locator('#peers-panel #friends-controls').isVisible(), true);
  assert.equal(await page.locator('#peers-panel #account-card').count(), 0, 'the ordinary account card is never moved into hosting');
  assert.equal(await page.locator('#account-card').count(), 1);
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('#account-card')?.closest('#friends-panel'))), true);
  await click('#home-tab'); await click('#friends-tab');
  assert.equal(await page.locator('#friends-panel #account-card').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('failed local uncertain ownership requires recovery, never self-takeover or invented hosting', async () => {
  await reset(); const f = await fixture();
  f.state.server.state = 'failed'; f.state.server.ownerName = 'This PC';
  f.state.server.ownership = { state: 'uncertain', owner: f.state.deviceId };
  f.state.relay = { name: 'Group', fingerprint: 'c'.repeat(64), parkOnStop: true };
  await set({state:f.state}); await click('#server-list [data-action="open"][data-id="alpha"]');
  assert.doesNotMatch(await page.locator('#server-action-hint').textContent(), /hosting.*right now|take over/i);
  assert.match(await page.locator('#server-action-hint').textContent(), /No server process is tracked here\. Confirm previous processes are stopped & recover local ownership/i);
  assert.doesNotMatch(await page.locator('#server-action-hint').textContent(), /This server is stopped/i);
  assert.equal(await page.locator('#recover-ownership').isVisible(), true);
  assert.equal(await page.locator('#recover-ownership').isEnabled(), true);
  await click('#peers-tab');
  assert.equal(await page.locator('#claim-relay').count(), 0, 'no self-takeover action exists; explicit stopped-process recovery remains available');
  assert.doesNotMatch(await page.locator('#relay-help').textContent(), /is hosting|take over/i);
  assert.match(await page.locator('#relay-help').textContent(), /No server process is tracked here.*Confirm previous processes are stopped.*recover/i);
  for (const state of ['unknown', 'transferred', 'offered']) {
    f.state.server.ownership = {state,owner:'d'.repeat(64)};
    await set({state:f.state});
    assert.doesNotMatch(await page.locator('#relay-help').textContent(), /is hosting/i, state);
    assert.doesNotMatch(await page.locator('#server-action-hint').textContent(), /hosting.*right now/i, state);
  }
});

test('the guide links to the Friends page without moving the account card or group controls', async () => {
  await reset(); const f = await fixture(); f.state.onboarding.step = 'friends'; await set({state:f.state});
  await click('#server-list [data-action="open"][data-id="alpha"]'); await click('#peers-tab');
  await click('#nav-setup');
  await page.waitForFunction(() => !document.querySelector('#setup-friends').hidden);
  assert.equal(await page.locator('#setup-friends-slot #account-card').count(), 0, 'the guide never adopts the account card');
  assert.equal(await page.locator('#setup-friends #friends-controls').count(), 0, 'group controls stay in their workspace');
  assert.equal(await page.locator('#peers-panel #account-card').count(), 0);
  await click('#setup-open-friends');
  await page.waitForFunction(() => !document.querySelector('#setup-dialog').open);
  assert.equal(await page.locator('#friends-panel').isVisible(), true, 'Open Friends lands on the Friends page');
  assert.equal(await page.locator('#friends-panel #account-card').count(), 1);
  assert.equal(await page.locator('#account-card').count(), 1);
  await click('#home-tab'); await click('#friends-tab');
  assert.equal(await page.locator('#friends-panel #account-card').isVisible(), true);
});

test('Start and stopped recovery explain trust inline without another consent control', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="alpha"]');
  assert.match(await page.locator('#server-start-trust').textContent(), /Start.*executes.*configured Java.*server.*mods/i);
  assert.equal(await page.locator('#server-start-trust').isVisible(), true);
  const f = await fixture(); f.state.server.state = 'failed'; f.state.server.ownership = {state:'uncertain',owner:f.state.deviceId};
  await set({state:f.state});
  assert.match(await page.locator('#server-recovery-reminder').textContent(), /previous.*Java.*server processes.*stopped/i);
  assert.equal(await page.locator('#server-recovery-reminder').isVisible(), true);
});

// Each feature below is added and run RED before its implementation.
test('global Friends and Settings sit below Home, outside server-only navigation', async () => {
  await reset();
  assert.equal(await page.locator('#friends-tab').count(), 1, 'global Friends destination exists');
  assert.deepEqual(await page.locator('.nav-tabs > button').evaluateAll(nodes => nodes.filter(n => !n.hidden).map(n => n.id)), ['home-tab', 'friends-tab', 'settings-tab']);
  await click('#friends-tab');
  assert.equal(await page.locator('#friends-panel #account-card').isVisible(), true);
  assert.equal(await page.locator('#friends-panel #friends-controls').count(), 0, 'hosting controls stay out of the ordinary Friends page');
  assert.equal(await page.locator('#peers-panel #friends-controls').count(), 1);
  assert.equal(await page.locator('#server-workspace-header').isVisible(), false);
  await page.locator('#friends-tab').press('ArrowDown');
  assert.equal(await page.locator('#settings-panel').isVisible(), true);
  await page.locator('#settings-tab').press('Home');
  await click('#server-list [data-action="open"][data-id="alpha"]');
  assert.equal(await page.locator('#settings-tab').isVisible(), false, 'app settings do not appear inside server workspace');
  assert.equal(await page.locator('#friends-tab').isVisible(), false);
  assert.equal(await page.locator('#server-settings-tab').isVisible(), true);
  assert.equal(await page.locator('#peers-tab .nav-text').textContent(), 'Multi-host');
  assert.equal(await page.locator('#peers-panel #account-card').count(), 0);
  await click('#home-tab');
  await click('#friends-tab');
  assert.equal(await page.locator('#friends-panel').isVisible(), true);
  await page.evaluate(() => window.dashboardFixture.set({ state: { ...window.dashboardFixture.read().state, server: null, servers: [] } }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await settle();
  assert.equal(await page.locator('#friends-panel').isVisible(), true, 'Friends also works without a server');
  await click('#settings-tab');
  assert.equal(await page.locator('#settings-panel').isVisible(), true);
});
test('bottom-left Profile works signed out and preserves the current page', async () => {
  await reset();
  assert.equal(await page.locator('.sidebar-footer #profile-open').count(), 1, 'Profile button stays in sidebar footer');
  await click('#profile-open');
  assert.equal(await page.locator('#profile-dialog').isVisible(), true);
  assert.equal(await page.locator('#account-profile-form').isVisible(), false);
  assert.equal(await page.locator('#profile-signin').isDisabled(), true, 'unconfigured directory cannot sign in');
  await page.locator('#profile-dialog').press('Escape');
  assert.equal(await page.locator('#home-panel').isVisible(), true);
});

test('Profile verifies account update readback, clears password inputs, and reports service refusals', async () => {
  await reset();
  const status = { configured: true, signedIn: true, online: true, username: 'fixture_user', detail: 'Signed in' };
  await page.evaluate(s => { window.dashboardFixture.set({ accountStatus: s }); window.dispatchEvent(new Event('seedhost-account-changed')); }, status);
  await page.waitForFunction(() => document.querySelector('#account-heading').textContent === '@fixture_user');
  await click('#profile-open');
  assert.equal(await page.locator('#profile-username').inputValue(), 'fixture_user');
  await page.locator('#profile-username').fill('updated_user');
  await page.locator('#profile-current-password').fill('test-only-current');
  await page.locator('#profile-new-password').fill('test-only-new');
  await page.locator('#profile-confirm-password').fill('mismatch');
  await click('#profile-save');
  assert.match(await page.locator('#account-profile-feedback').textContent(), /match/i);
  assert.equal((await fixture()).calls.some(c => c.method === 'accountUpdateProfile'), false);
  await page.locator('#profile-confirm-password').fill('test-only-new');
  await click('#profile-save');
  await page.waitForFunction(() => document.querySelector('#account-profile-feedback').textContent.includes('Saved'));
  assert.equal(await page.locator('#profile-current-password').inputValue(), '');
  assert.equal(await page.locator('#profile-new-password').inputValue(), '');
  assert.equal(await page.locator('#profile-confirm-password').inputValue(), '');
  assert.equal(await page.locator('#account-heading').textContent(), '@updated_user');
  await page.evaluate(() => window.dashboardFixture.set({ fail: 'accountUpdateProfile' }));
  await page.locator('#profile-current-password').fill('test-only-current');
  await page.locator('#profile-username').fill('refused_user');
  await click('#profile-save');
  await page.waitForFunction(() => document.querySelector('#account-profile-feedback').textContent.includes('TEST failure'));
  assert.equal(await page.locator('#profile-current-password').inputValue(), '');
  assert.equal(await page.locator('#account-heading').textContent(), '@updated_user');
  await page.locator('#profile-new-password').fill('discarded-synthetic');
  await page.locator('#profile-dialog').press('Escape');
  // Escape closes through the browser's task-scheduled dialog machinery; wait for the discard instead of racing it.
  await page.waitForFunction(() => document.querySelector('#profile-new-password').value === '');
  assert.equal(await page.locator('#profile-new-password').inputValue(), '');
});

test('cached signed-in and offline accounts retain a visible reauthentication path', async () => {
  await reset();
  await page.evaluate(() => { window.dashboardFixture.set({accountStatus:{configured:true,signedIn:true,online:false,username:'cached_user',detail:'Account service unavailable'}});window.dispatchEvent(new Event('seedhost-account-changed')); });
  await page.waitForFunction(() => document.querySelector('#account-heading').textContent === '@cached_user');
  await click('#profile-open');
  assert.equal(await page.locator('#profile-signin').isVisible(),true,'offline cached session cannot trap sign-in recovery');
  assert.equal(await page.locator('#profile-signin').isEnabled(),true);
  await click('#profile-signin');
  assert.equal(await page.locator('#account-dialog').isVisible(),true);
  assert.equal(await page.locator('#profile-dialog').isVisible(),false);
  assert.equal(await page.locator('#account-submit').textContent(),'Sign in');
});

test('Profile rejects a mismatched account response rather than reporting saved', async () => {
  await reset();
  await page.evaluate(() => { window.dashboardFixture.set({accountStatus:{configured:true,signedIn:true,online:true,username:'fixture_user',detail:'Signed in'},profileResponseMismatch:true}); window.dispatchEvent(new Event('seedhost-account-changed')); });
  await page.waitForFunction(() => document.querySelector('#account-heading').textContent === '@fixture_user');
  await click('#profile-open');
  await page.locator('#profile-username').fill('not_confirmed');
  await page.locator('#profile-current-password').fill('test-only-current');
  await click('#profile-save');
  await page.waitForFunction(() => document.querySelector('#account-profile-feedback').textContent.includes('did not confirm'));
  assert.equal(await page.locator('#account-heading').textContent(), '@fixture_user');
  assert.equal(await page.locator('#profile-current-password').inputValue(), '');
});

test('hosting invitations explain private control routes and stale-endpoint recovery before accepting', async () => {
  await reset();
  await page.evaluate(() => { window.dashboardFixture.set({accountStatus:{configured:true,signedIn:true,online:true,username:'fixture_user',detail:'Signed in'},accountRequests:[{id:'test-request',from:'owner',group:'Test group',controlEndpoint:{host:'192.168.1.50',port:8443,privateRoute:true,reachability:'unverified'}}]}); window.dispatchEvent(new Event('seedhost-account-changed')); });
  await click('#server-list [data-action="open"][data-id="alpha"]');
  await click('#home-tab');
  await click('#friends-tab');
  await page.waitForFunction(() => document.querySelector('#hosting-request-list').textContent.includes('Test group'));
  const text=await page.locator('#hosting-request-list').textContent();
  assert.match(text,/192\.168\.1\.50:8443/);
  assert.match(text,/private.*same network|same network.*private/i);
  assert.match(text,/Minecraft.*address.*not|not.*Minecraft.*address/i);
  assert.match(text,/unverified/i);
  assert.match(text,/restart.*decline.*new invitation/is);
});

test('Home begins with selectable server cards from the library and explicit one-running limit', async () => {
  await reset(); console.log('TEST-ONLY renderer: Home/library selection');
  assert.equal(await page.locator('#home-panel').count(), 1, 'Home exists');
  assert.equal(await page.locator('#home-panel').isVisible(), true, 'fresh renderer opens Home');
  assert.equal(await page.locator('#server-list .server-row').count(), 2);
  assert.match(await page.locator('#server-list').textContent(), /Mossy Hollow.*Sky Islands/s);
  assert.match(await page.locator('#server-list').textContent(), /Unknown/i, 'unknown owner is not inferred');
  assert.match(await page.locator('#home-concurrency').textContent(), /one server.*time/i);
  await click('#server-list [data-action="open"][data-id="bravo"]');
  await page.waitForFunction(() => document.querySelector('#server-name').textContent === 'Sky Islands');
  assert.equal((await fixture()).state.server.id, 'bravo');
  assert.equal(await page.locator('#operate-panel').isVisible(), true);
  await click('#home-tab');
  assert.equal(await page.locator('#home-panel').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('server sections are hidden on Home until a server is opened, then hidden again on return', async () => {
  await reset();
  const sections = ['operate', 'console', 'players', 'backups', 'scheduler', 'peers', 'mods', 'tunnels', 'server-settings', 'server-files'];
  for (const section of sections) assert.equal(await page.locator('#' + section + '-tab').isVisible(), false, section + ' must not appear on library Home');
  assert.equal(await page.locator('#server-workspace-header').isVisible(), false);
  await click('#server-list [data-action="open"][data-id="alpha"]');
  for (const section of sections) assert.equal(await page.locator('#' + section + '-tab').isVisible(), true, section + ' appears in opened server workspace');
  await click('#home-tab');
  for (const section of sections) assert.equal(await page.locator('#' + section + '-tab').isVisible(), false, section + ' hides when returning Home');
  assert.equal(await page.locator('#home-stop-first').isVisible(), false);
  await page.screenshot({ path: path.join(root, 'home-without-server-options.png') });
  console.log('SCREENSHOT=' + path.join(root, 'home-without-server-options.png'));
});

test('running server can be stopped from Home without opening its workspace or switching worlds', async () => {
  await reset(); const f = await fixture(); f.state.server.state = 'running'; f.state.server.ownership.state = 'hosting'; f.state.servers[0].state = 'running';
  await set({ state: f.state });
  await click('#server-list [data-action="open"][data-id="alpha"]');
  await click('#home-tab');
  assert.equal(await page.locator('#home-panel').isVisible(), true);
  assert.equal(await page.locator('#server-list [data-action="open"][data-id="bravo"]').isDisabled(), true, 'cannot switch while process runs');
  assert.equal(await page.locator('#server-list [data-action="open"][data-id="alpha"]').isEnabled(), true, 'can reopen the active world');
  assert.match(await page.locator('#home-selection-hint').textContent(), /Stop.*Mossy Hollow.*before.*switch/i);
  assert.equal(await page.locator('#home-stop-first').isEnabled(), true);
  await click('#home-stop-first');
  const afterStop = await fixture();
  assert.ok(afterStop.calls.some(c => c.method === 'stopServer'), 'Home must invoke the real stop action');
  assert.equal(await page.locator('#home-stop-first').textContent(), 'Stop server');
  assert.equal(await page.locator('#home-panel').isVisible(), true, 'stopping does not navigate away from Home');
  assert.equal(await page.locator('#operate-panel').isVisible(), false, 'stopping does not open the server workspace');
  assert.equal((await fixture()).calls.some(c => c.method === 'selectServer' && c.payload.id === 'bravo'), false);
});

test('Performance renders authoritative samples, never invented zeros, with selected-server dashboard request', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="alpha"]');
  assert.equal(await page.locator('#operate-tab .nav-text').textContent(), 'Performance');
  assert.equal(await page.locator('#performance-cpu').count(), 1, 'performance metrics exist');
  await page.waitForFunction(() => document.querySelector('#dashboard-status')?.textContent.includes('Updated'));
  assert.equal(await page.locator('#performance-cpu').textContent(), 'Unavailable');
  const f = await fixture(); f.dashboard.alpha.performance = { pid: 123, cpuPercent: 12.5, memoryMiB: 512, uptimeSeconds: 61, sampledAt: 1720000000000, error: null };
  await set({ dashboard: f.dashboard }); await click('#dashboard-refresh');
  await page.waitForFunction(() => document.querySelector('#performance-cpu').textContent === '12.5%');
  assert.equal(await page.locator('#performance-memory').textContent(), '512 MiB');
  assert.equal(await page.locator('#performance-uptime').textContent(), '61 s');
  assert.equal(await page.locator('#performance-pid').textContent(), '123');
  // A dashboard response that lands after the user switches worlds must never render into the new one.
  const g = await fixture();
  g.dashboard.alpha.performance = { pid: 111, cpuPercent: 33, memoryMiB: 100, uptimeSeconds: 5, sampledAt: 1720000000000, error: null };
  g.dashboard.bravo.performance = { pid: 222, cpuPercent: 77, memoryMiB: 200, uptimeSeconds: 9, sampledAt: 1720000000001, error: null };
  await set({ dashboard: g.dashboard, holdDashboard: null });
  await page.evaluate(() => window.dashboardFixture.set({ holdDashboard: 'alpha' }));
  await click('#dashboard-refresh');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 60)));
  await click('#home-tab'); await click('#server-list [data-action="open"][data-id="bravo"]');
  await page.evaluate(() => window.dashboardFixture.release()); await settle();
  await page.waitForFunction(() => document.querySelector('#performance-cpu').textContent === '77%');
  assert.equal(await page.locator('#performance-cpu').textContent(), '77%', 'late bravo/alpha responses never cross servers');
  assert.equal(await page.locator('#performance-pid').textContent(), '222');
  assert.ok((await fixture()).calls.some(c => c.method === 'getServerDashboard' && c.payload.id === 'alpha'));
  await page.screenshot({ path: path.join(root, 'performance.png') });
  console.log('TEST-ONLY Electron Performance screenshot: ' + path.join(root, 'performance.png'));
});

test('every per-server section lays out at the minimum window size without clipping or overlap', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="alpha"]');
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setFullScreen(false); w.setContentSize(1000, 700); });
  await page.waitForFunction(() => innerWidth <= 1000);
  const audit = () => page.evaluate(() => {
    const problems = [];
    const describe = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '');
    const visible = (e) => { const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; for (let n = e; n; n = n.parentElement) { const s = getComputedStyle(n); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false; } return !e.closest('[hidden],#splash,dialog:not([open])'); };
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) problems.push('page scrolls horizontally');
    for (const scroller of document.querySelectorAll('.page:not([hidden]), .sidebar')) if (scroller.scrollWidth > scroller.clientWidth + 1) problems.push('horizontal overflow in ' + describe(scroller));
    const nodes = [...document.querySelectorAll('button,input:not([type=radio]),textarea,select,.badge,h1,h2,h3,summary,label,.chip,.led,.kbd,.metric dd')].filter((e) => visible(e) && !e.closest('dialog'));
    for (const e of nodes) { const r = e.getBoundingClientRect(); if (r.right > innerWidth + 1 || r.left < -1) problems.push('outside viewport: ' + describe(e)); }
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.contains(b) || b.contains(a)) continue;
      if ((a.tagName === 'LABEL' && a.control === b) || (b.tagName === 'LABEL' && b.control === a)) continue;
      const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
      const w = Math.min(x.right, y.right) - Math.max(x.left, y.left), h = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
      if (w > 1.5 && h > 1.5) problems.push('overlap: ' + describe(a) + ' × ' + describe(b));
    }
    return problems;
  });
  for (const name of ['home', 'friends', 'settings', 'operate', 'console', 'players', 'backups', 'scheduler', 'peers', 'mods', 'tunnels', 'server-settings', 'server-files']) {
    if (name !== 'home' && !await page.locator('#' + name + '-tab').isVisible()) { await click('#home-tab'); await click('#server-list [data-action="open"][data-id="alpha"]'); }
    await click('#' + name + '-tab');
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
    assert.deepEqual(await audit(), [], 'layout problems in ' + name);
    await page.screenshot({ path: path.join(root, 'section-' + name + '.png') });
  }
  console.log('TEST-ONLY Electron layout screenshots: ' + root);
});

test('Console uses selected-server logs and preserves guarded process command submission', async () => {
  await reset(); const f = await fixture(); f.state.server.state = 'running'; f.state.server.ownership.state = 'hosting'; await set({ state: f.state });
  await click('#server-list [data-action="open"][data-id="alpha"]'); await click('#console-tab');
  await page.waitForFunction(() => document.querySelector('#console-lines').textContent.includes('alpha log'));
  assert.equal(await page.locator('#operate-panel').isVisible(), false);
  await page.bringToFront(); await page.locator('#server-command').fill('say hello'); await click('#send-command'); await settle();
  assert.ok((await fixture()).calls.some(c => c.method === 'sendCommand' && c.payload.command === 'say hello'));
  assert.equal(await page.locator('#server-command').inputValue(), '');
});

test('Players shows sampled names and sends guarded kick/whitelist actions to this server', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="alpha"]');
  assert.equal(await page.locator('#players-tab').count(), 1, 'Players navigation exists'); await click('#players-tab');
  assert.match(await page.locator('#players-count').textContent(), /Unavailable/);
  assert.equal(await page.locator('#player-submit').isDisabled(), true, 'stopped server cannot manage players');
  const f = await fixture(); f.state.server.state = 'running'; f.state.server.ownership.state = 'hosting'; f.dashboard.alpha.players = { online: 1, max: 20, sample: [{ name: 'Alex' }], error: null };
  await set({ state: f.state, dashboard: f.dashboard }); await click('#dashboard-refresh');
  await page.waitForFunction(() => document.querySelector('#players-list').textContent.includes('Alex'));
  assert.match(await page.locator('#players-count').textContent(), /1.*20/);
  await click('#players-list button[data-player="Alex"]'); await settle();
  await page.waitForFunction(() => !document.querySelector('#players-list').textContent.includes('Alex'));
  await page.bringToFront(); await page.locator('#player-name').fill('Steve'); await click('#player-submit'); await settle();
  const calls = (await fixture()).calls.filter(c => c.method === 'managePlayer');
  assert.deepEqual(calls.map(c => c.payload), [{ id: 'alpha', action: 'kick', name: 'Alex' }, { id: 'alpha', action: 'whitelist-add', name: 'Steve' }]);
});

test('Backups relocates the real history/actions and follows the selected world after switching', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="bravo"]');
  assert.equal(await page.locator('#backups-tab').count(), 1, 'Backups navigation exists'); await click('#backups-tab');
  assert.equal(await page.locator('#backups-panel #snapshot-history').isVisible(), true);
  assert.equal(await page.locator('#backups-panel #create-snapshot').count(), 1);
  await page.waitForFunction(() => document.querySelector('#snapshot-list').textContent.includes('bravo-backup'));
  await click('#create-snapshot'); await settle();
  assert.equal((await fixture()).state.server.snapshotId, 'bravo-backup-new');
  await click('#home-tab'); await click('#server-list [data-action="open"][data-id="alpha"]'); await click('#backups-tab');
  await page.waitForFunction(() => document.querySelector('#snapshot-list').textContent.includes('alpha-backup'));
  assert.doesNotMatch(await page.locator('#snapshot-list').textContent(), /bravo/);
});

test('Scheduler creates, edits, runs and deletes a real per-server schedule with read-back', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="alpha"]');
  assert.equal(await page.locator('#scheduler-tab').count(), 1, 'Scheduler navigation exists'); await click('#scheduler-tab');
  assert.match(await page.locator('#scheduler-help').textContent(), /app.*open/i);
  await page.bringToFront(); await page.locator('#schedule-name').fill('World backup'); await page.locator('#schedule-interval').fill('30'); await click('#schedule-save');
  await page.waitForFunction(() => document.querySelector('#schedule-feedback').textContent.includes('Verified'));
  assert.match(await page.locator('#schedule-list').textContent(), /World backup.*30/s);
  await click('#schedule-list [data-job-action="edit"]'); await page.bringToFront(); await page.locator('#schedule-interval').fill('45'); await click('#schedule-save');
  await page.waitForFunction(() => document.querySelector('#schedule-list').textContent.includes('45'));
  await click('#schedule-list [data-job-action="run"]'); await page.waitForFunction(() => document.querySelector('#schedule-list').textContent.includes('TEST-only ran'));
  await click('#schedule-list [data-job-action="delete"]'); await page.waitForFunction(() => document.querySelector('#schedule-feedback').textContent.includes('Verified removal'));
  assert.equal((await fixture()).dashboard.alpha.schedules.length, 0);
  const calls = (await fixture()).calls.filter(c => c.method === 'saveServerSchedule');
  assert.equal(calls[0].payload.id, 'alpha'); assert.deepEqual(calls[0].payload.schedule, { name: 'World backup', action: 'backup', intervalMinutes: 30, enabled: true });
  assert.equal(calls[1].payload.schedule.id, 'job-1');
});

test('new dashboard text controls retain the existing themed input styling', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="alpha"]'); await click('#scheduler-tab');
  const styles = await page.evaluate(() => {
    const text = getComputedStyle(document.querySelector('#schedule-name'));
    const number = getComputedStyle(document.querySelector('#schedule-interval'));
    return { textRadius: text.borderRadius, numberRadius: number.borderRadius, textWidth: document.querySelector('#schedule-name').getBoundingClientRect().width, numberWidth: document.querySelector('#schedule-interval').getBoundingClientRect().width };
  });
  assert.equal(styles.textRadius, styles.numberRadius, 'text and numeric controls must use the same theme');
  assert.ok(Math.abs(styles.textWidth - styles.numberWidth) < 2, 'text input fills its form column');
});

test('Multi-host reuses group/relay controls, explicitly distinguishes app-wide group from selected-world handoff', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="alpha"]');
  assert.equal(await page.locator('#peers-tab .nav-text').textContent(), 'Multi-host'); await click('#peers-tab');
  assert.match(await page.locator('#multi-host-scope').textContent(), /selected server.*group/i);
  assert.equal(await page.locator('#peers-panel #relay-card').count(), 1);
  assert.equal(await page.locator('#peers-panel #hosting-card').count(), 1);
  assert.equal(await page.locator('#peers-panel #friends-controls').count(), 1);
  assert.equal(await page.locator('#peers-panel #account-card').count(), 0);
  await click('#home-tab'); await click('#friends-tab');
  assert.equal(await page.locator('#friends-panel #friends-controls').count(), 0);
  assert.equal(await page.locator('#friends-panel #account-card').count(), 1);
  assert.equal(await page.locator('#friend-code, #invite-code').count(), 0);
  await click('#home-tab'); await click('#server-list [data-action="open"][data-id="alpha"]'); await click('#peers-tab');
  const f = await fixture(); f.state.relay = { name: 'Shared relay', fingerprint: 'c'.repeat(64), parkOnStop: false }; f.state.peers = [{ name: 'Shared relay', fingerprint: 'c'.repeat(64), host: '127.0.0.1', port: 1234 }];
  await set({ state: f.state });
  assert.equal(await page.locator('#park-relay').isEnabled(), true);
  await click('#park-relay'); await settle(); assert.ok((await fixture()).calls.some(c => c.method === 'parkAtRelay'));
});

test('Mods retains Modrinth search and local JAR actions inside its per-server section', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="bravo"]');
  assert.equal(await page.locator('#mods-tab').count(), 1, 'Mods navigation exists'); await click('#mods-tab');
  assert.equal(await page.locator('#mods-details').evaluate(n => n.tagName), 'SECTION');
  assert.equal(await page.locator('#mods-panel #mod-browser').isVisible(), true);
  assert.equal(await page.locator('#mods-panel #add-server-mods').isEnabled(), true);
  await click('#add-server-mods'); await settle();
  assert.ok((await fixture()).calls.some(c => c.method === 'addMods' && c.payload.kind === 'server'));
  await page.bringToFront(); await page.locator('#mod-query').fill('Lithium'); await click('#search-mods');
  await page.waitForFunction(() => window.dashboardFixture.read().calls.some(c => c.method === 'searchMods' && c.payload.query === 'Lithium'));
  assert.equal(await page.locator('#mods-details').count(), 1, 'original controls not duplicated');
});

test('Tunnels retains public/playit/gateway controls with per-server Playit addresses', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="alpha"]');
  assert.equal(await page.locator('#tunnels-tab').count(), 1, 'Tunnels navigation exists'); await click('#tunnels-tab');
  for (const id of ['public-card', 'playit-panel', 'player-gateway']) assert.equal(await page.locator('#tunnels-panel #' + id).count(), 1, 'relocated ' + id);
  assert.equal(await page.locator('#home-panel #join-help, #home-panel .marquee').count(), 0, 'the recap and join widgets are gone from Home');
  const tunnelsScope = await page.locator('#tunnels-scope').textContent();
  assert.match(tunnelsScope, /each server has its own playit address/i);
  assert.match(tunnelsScope, /not proof of public reachability/i);
  assert.doesNotMatch(tunnelsScope, /app-wide/i, 'addresses are per server, not one app-wide route');
  await click('#playit-panel summary'); await click('#playit-check');
  await page.waitForFunction(() => window.dashboardFixture.read().calls.some(c => c.method === 'playitCheck'));
  assert.equal(await page.locator('#public-go').isVisible(), true);
});

test('Server settings reads properties, sends only changed allowed keys, verifies read-back and blocks running edits', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="bravo"]');
  assert.equal(await page.locator('#server-settings-tab').count(), 1, 'Server settings navigation exists'); await click('#server-settings-tab');
  assert.equal(await page.locator('#server-settings-panel #profile-form').count(), 1, 'existing launch profile retained');
  await page.waitForFunction(() => document.querySelector('#property-motd').value === 'bravo world');
  await page.bringToFront(); await page.locator('#property-motd').fill('Weekend world'); await page.locator('#property-max-players').fill('12'); await click('#properties-save');
  await page.waitForFunction(() => document.querySelector('#properties-feedback').textContent.includes('Verified'));
  const call = (await fixture()).calls.find(c => c.method === 'saveServerSettings');
  assert.deepEqual(call.payload, { id: 'bravo', settings: { motd: 'Weekend world', 'max-players': 12 } });
  const f = await fixture(); f.state.server.state = 'running'; f.state.server.ownership.state = 'hosting'; await set({ state: f.state });
  assert.equal(await page.locator('#property-motd').isDisabled(), true);
  assert.match(await page.locator('#properties-help').textContent(), /stop/i);
});

test('Server settings handles actual properties text values and preserves unsaved checkbox edits during polling', async () => {
  await reset();
  const f = await fixture();
  f.dashboard.alpha.settings = { motd: 'alpha world', 'max-players': '20', pvp: 'true', 'white-list': 'false' };
  await set({ dashboard: f.dashboard });
  await click('#server-list [data-action="open"][data-id="alpha"]');
  await click('#server-settings-tab');
  await page.waitForFunction(() => document.querySelector('#property-max-players').value === '20');
  assert.equal(await page.locator('#property-pvp').isChecked(), true, 'actual server.properties stores booleans as strings');
  await page.bringToFront(); await page.locator('#property-pvp').uncheck();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await settle();
  await click('#dashboard-refresh');
  assert.equal(await page.locator('#property-pvp').isChecked(), false, 'polling cannot discard an unsaved checkbox edit');
  await page.bringToFront(); await page.locator('#property-max-players').fill('12');
  await click('#properties-save');
  await page.waitForFunction(() => document.querySelector('#properties-feedback').textContent.includes('Verified'));
  const save = (await fixture()).calls.find(c => c.method === 'saveServerSettings');
  assert.deepEqual(save.payload, { id: 'alpha', settings: { 'max-players': 12, pvp: false } }, 'only edited keys are submitted');
});

test('Server files opens the selected managed directory without in-app browsing', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="alpha"]'); await click('#server-files-tab');
  await page.waitForFunction(() => window.dashboardFixture.read().calls.some(c => c.method === 'openServerFolder'));
  assert.deepEqual((await fixture()).calls.find(c => c.method === 'openServerFolder').payload, { id: 'alpha' });
  assert.equal(await page.locator('#file-editor, #file-list').count(), 0);
  assert.equal((await fixture()).calls.some(c => c.method === 'listServerFiles'), false);
});
test('Server files reports native folder refusal inline and offers retry', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="alpha"]');
  await set({fail:'openServerFolder'});
  await click('#server-files-tab'); await page.waitForFunction(() => document.querySelector('#file-feedback').textContent.includes('TEST failure for openServerFolder'));
  assert.equal(await page.locator('#file-feedback').isVisible(), true);
  assert.equal(await page.locator('#file-open-folder').isEnabled(), true);
});
test('Server files ignores a delayed failure after switching to another server', async () => {
  await reset(); await click('#server-list [data-action="open"][data-id="alpha"]');
  await set({holdCalls:['openServerFolder']});
  await click('#server-files-tab'); await page.waitForFunction(() => !!window.dashboardFixture.read().heldCalls?.openServerFolder);
  await set({holdCalls:[]});
  await click('#home-tab'); await click('#server-list [data-action="open"][data-id="bravo"]'); await click('#server-files-tab');
  await page.waitForFunction(() => document.querySelector('#file-feedback').textContent.includes('Opened'));
  await set({fail:'openServerFolder'}); await page.evaluate(() => window.dashboardFixture.releaseCall('openServerFolder'));
  assert.doesNotMatch(await page.locator('#file-feedback').textContent(), /TEST failure/);
  assert.equal(await page.locator('#file-open-folder').isEnabled(), true);
});
