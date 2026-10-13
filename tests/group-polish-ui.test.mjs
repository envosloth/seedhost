import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

// Real Electron renderer; existing TEST-ONLY bridge. No backend/network/live-world claims.
let app, page;
const errors = [];
before(async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'seed-group-polish-'));
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[path.resolve('tools/dashboard-fixture-main.cjs'),'--profile-root='+root],env});
  page = await app.firstWindow(); page.setDefaultTimeout(5000);
  page.on('pageerror',e=>errors.push(e.message));
});
after(async () => { if(app) {app.process().kill();await app.close().catch(()=>{});} assert.deepEqual(errors,[]); });
async function reset() {
  await page.evaluate(()=>window.dashboardFixture.reset()); await page.reload();
  await page.waitForFunction(()=>document.querySelector('#splash').hidden);
}
test('installed mods come first, filter both sections, and keep discovery and operations reachable', async () => {
  await reset();
  await page.evaluate(()=>{
    const f=window.dashboardFixture.read();
    f.state.server.mods={server:[{name:'Lithium.jar',size:2048},{name:'Fabric-api.jar',size:4096}],client:[{name:'Sodium.jar',size:1024}]};
    window.dashboardFixture.set({state:f.state});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await click('#server-list [data-action="open"][data-id="alpha"]'); await click('#mods-tab');
  assert.equal(await page.evaluate(()=>document.querySelector('#server-mods').compareDocumentPosition(document.querySelector('#mod-browser')) & Node.DOCUMENT_POSITION_FOLLOWING),4,'installed lists precede discovery');
  await page.locator('#installed-mod-query').fill('lItHiUm');
  assert.deepEqual(await page.locator('#server-mods .mod-name').allTextContents(),['Lithium.jar']);
  assert.deepEqual(await page.locator('#client-mods .mod-name').allTextContents(),[]);
  assert.match(await page.locator('#client-mods').textContent(),/No installed mods match/i);
  assert.equal(await page.locator('#mod-browser').isVisible(),true);
  assert.equal(await page.locator('#server-mods button').isEnabled(),true);
  await page.locator('#installed-mod-query').fill('');
  assert.equal(await page.locator('#server-mods .mod-name').count(),2);
  assert.equal(await page.locator('#client-mods .mod-name').count(),1);
  assert.equal(await page.locator('#add-server-mods').isEnabled(),true);
  assert.equal(await page.locator('#add-client-mods').isEnabled(),true);
  assert.equal(await page.locator('#export-client-pack').isEnabled(),true);
  await page.evaluate(()=>{const f=window.dashboardFixture.read();f.state.server.state='running';window.dashboardFixture.set({state:f.state});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>document.querySelector('#add-server-mods').disabled);
  assert.equal(await page.locator('#server-mods button').first().isDisabled(),true,'search never bypasses operation guards');
});

test('group hosting has only normal Start, never a separate Take over action', async () => {
  await reset();
  await page.evaluate(()=>{const f=window.dashboardFixture.read();f.state.relay={name:'Group',fingerprint:'c'.repeat(64),parkOnStop:true};f.state.server.group={name:'Group',fingerprint:'c'.repeat(64),parkOnStop:true,endpoint:{host:'192.168.1.5',port:8443}};f.state.server.ownership={state:'transferred',owner:'c'.repeat(64)};window.dashboardFixture.set({state:f.state});document.dispatchEvent(new Event('visibilitychange'));});
  await click('#server-list [data-action="open"][data-id="alpha"]');await click('#peers-tab');
  assert.equal(await page.locator('#claim-relay').count(),0,'redundant button is removed from DOM, not hidden');
  assert.doesNotMatch(await page.locator('#relay-help').textContent(),/take over/i);
  await click('#operate-tab');
  await page.waitForFunction(()=>document.querySelector('#server-action-hint').textContent.includes('Press Start server'));
  const hint = await page.locator('#server-action-hint').textContent();
  assert.doesNotMatch(hint,/hosting authority is not confirmed/i,'retired generic custody sentence stays gone');
  assert.match(hint,/sync the latest world from the group/,'hint points at the ordinary Start action');
  await click('#start-server');
  await page.waitForFunction(()=>window.dashboardFixture.read().calls.some(c=>c.method==='startServer'));
  assert.equal((await read()).calls.some(c=>c.method==='claimFromRelay'),false);
});

test('setup Escape cannot close while creation is in flight', async () => {
  await reset(); await click('#add-server');
  await page.evaluate(()=>{window.dashboardFixture.set({holdCalls:['createServer']});const version=document.querySelector('#setup-version');version.add(new Option('1.21.1','1.21.1'));version.value='1.21.1';version.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.locator('#setup-name').fill('Held world');await click('#setup-create');
  await page.waitForFunction(()=>window.dashboardFixture.read().heldCalls?.createServer);
  try { await page.keyboard.press('Escape'); assert.equal(await page.locator('#setup-dialog').evaluate(el=>el.open),true);assert.equal(await page.locator('#setup-save-close').isDisabled(),true); }
  finally { await page.evaluate(()=>window.dashboardFixture.releaseCall('createServer')); }
});

test('group actions show Leave only to members and Disband only to the verified owner', async () => {
  await reset();
  await page.evaluate(()=>{
    const f=window.dashboardFixture.read(),pin='c'.repeat(64);
    f.state.relay={name:'Group',fingerprint:pin,parkOnStop:true};
    f.state.server.group={name:'Group',fingerprint:pin,parkOnStop:true};
    f.state.server.ownership={state:'transferred',owner:pin};
    f.state.pendingGroups=[];
    window.dashboardFixture.set({state:f.state,friends:{members:[{name:'Member',fingerprint:f.state.deviceId,you:true}],canManage:false,owner:'d'.repeat(64),custody:'parked',holder:null}});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await click('#server-list [data-action="open"][data-id="alpha"]');await click('#peers-tab');
  await page.waitForFunction(()=>document.getElementById('leave-group')&&!document.getElementById('leave-group').hidden);
  assert.equal(await page.locator('#disband-group').isVisible(),false);
  assert.equal(await page.locator('#leave-group').isEnabled(),true);
  assert.equal(await page.locator('#leave-group').locator('..').locator('h2').textContent(),'Leave hosting group');
  await click('#leave-group');
  await page.waitForFunction(()=>window.dashboardFixture.read().calls.some(c=>c.method==='leaveGroup'));
  await page.waitForFunction(()=>document.getElementById('disband-feedback').textContent.includes('Verified leave'));
  assert.equal((await read()).state.server.group,null);
});

test('Leave never reports success when local group removal cannot be read back', async () => {
  await reset();
  await page.evaluate(()=>{
    const f=window.dashboardFixture.read(),pin='c'.repeat(64);
    f.state.relay={name:'Group',fingerprint:pin,parkOnStop:true};
    f.state.server.group={name:'Group',fingerprint:pin,parkOnStop:true};
    f.state.server.ownership={state:'transferred',owner:pin};f.state.pendingGroups=[];
    window.dashboardFixture.set({state:f.state,leaveReadbackMismatch:true,friends:{members:[{name:'Member',fingerprint:f.state.deviceId,you:true}],canManage:false,owner:'d'.repeat(64),custody:'parked',holder:null}});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await click('#server-list [data-action="open"][data-id="alpha"]');await click('#peers-tab');
  await page.waitForFunction(()=>!document.getElementById('leave-group').hidden);
  await click('#leave-group');
  await page.waitForFunction(()=>document.getElementById('disband-feedback').textContent.includes('could not be confirmed'));
  assert.doesNotMatch(await page.locator('#disband-feedback').textContent(),/Verified leave/);
  assert.equal((await read()).state.server.group.fingerprint,'c'.repeat(64));
});

test('verified group owner sees Disband and cannot Leave', async () => {
  await reset();
  await page.evaluate(()=>{
    const f=window.dashboardFixture.read(),pin='c'.repeat(64);
    f.state.relay={name:'Group',fingerprint:pin,parkOnStop:true};
    f.state.server.group={name:'Group',fingerprint:pin,parkOnStop:true};
    f.state.pendingGroups=[];
    window.dashboardFixture.set({state:f.state,friends:{members:[{name:'Owner',fingerprint:f.state.deviceId,you:true}],canManage:true,owner:f.state.deviceId,custody:'held',holder:'Owner'}});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await click('#server-list [data-action="open"][data-id="alpha"]');await click('#peers-tab');
  await page.waitForFunction(()=>!document.getElementById('disband-group').hidden);
  assert.equal(await page.locator('#disband-group').isEnabled(),true);
  assert.equal(await page.locator('#leave-group').isVisible(),false);
});

const read = () => page.evaluate(()=>window.dashboardFixture.read());
const click = selector => page.locator(selector).click();

test('X and Escape abandon an uncreated setup without any mutation', async () => {
  for (const exit of ['X','Escape']) {
    await reset(); const original=(await read()).state;
    await click('#add-server'); await page.locator('#setup-name').fill('');
    assert.doesNotMatch(await page.locator('#setup-save-close').getAttribute('aria-label'), /progress is saved/i, 'cancel must not promise a saved draft');
    if(exit==='X') await click('#setup-save-close'); else await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.querySelector('#setup-dialog').open);
    const f=await read();
    assert.equal(f.calls.some(c=>['saveOnboarding','createServer','importServer'].includes(c.method)),false,'closing before creation is not a save/create action');
    assert.deepEqual(f.state,original);
  }
});
