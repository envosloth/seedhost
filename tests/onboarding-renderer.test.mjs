import test from 'node:test';
import assert from 'node:assert/strict';
import {renderer,appState,server,settled} from '../tools/ui-renderer-fixture.mjs';

test('fresh empty state has exact centered create action and resumable optional setup', async t => {
  const page = await renderer(t);
  assert.equal(await page.locator('#create-server-empty').count(), 1, 'empty state offers create a server');
  assert.equal(await page.locator('#create-server-empty').textContent(), 'create a server');
  assert.equal(await page.locator('#setup-dialog').isVisible(), true);
  await page.locator('#setup-name').fill('Saved draft');
  // Selecting a stage explicitly saves progress; Escape on an uncreated setup only cancels the dialog.
  await page.locator('[data-setup-step="server"]').click(); await settled(page);
  await page.locator('#setup-dialog').press('Escape');
  await page.waitForFunction(() => !document.querySelector('#setup-dialog').open);
  const saved = await page.evaluate(() => window.fixture.state.onboarding);
  assert.equal(saved.draft.name, 'Saved draft'); assert.equal(saved.dismissed, false, 'cancel does not pretend a dismissal was saved');
  // A new test-only bridge boot uses the saved contract (real durability belongs to the live tool).
  const reopened = await renderer(t, { ...appState(), onboarding: saved });
  await reopened.waitForFunction(() => document.querySelector('#setup-dialog').open);
  assert.equal(await reopened.locator('#setup-name').inputValue(), 'Saved draft');
  assert.equal(await page.locator('#mod-search-form').count(), 1);
  assert.equal(await page.locator('#friend-add-form').count(), 1, 'the ordinary add-by-username form is present without a group');
  assert.equal(await page.locator('#join-friend-form').count(), 0);
});

test('creation needs no Java choice or EULA checkbox: Java is automatic and Create states the EULA agreement', async t => {
  const page = await renderer(t);
  assert.equal(await page.locator('#setup-create').count(), 1, 'creation form exists');
  if (await page.locator('#setup-choose-create').isVisible()) await page.locator('#setup-choose-create').click();
  await page.waitForFunction(() => document.querySelector('#setup-version').options.length > 1);
  await page.locator('#setup-loader').selectOption('fabric');
  for (const removed of ['#setup-java', '#setup-eula', '#setup-pick-java', '#setup-discover-java', '#setup-create-form [data-setup-link="java"]', '#setup-memory', '#setup-memory-chips']) assert.equal(await page.locator(removed).count(), 0, removed + ' is gone');
  assert.match(await page.locator('#setup-eula-note').textContent(), /By creating a world you agree to the Minecraft EULA/);
  await page.locator('#setup-create').click(); await settled(page);
  assert.equal(await page.locator('#setup-server').isVisible(), true, 'cancelled native confirmation does not advance');
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.find(c => c.method === 'createServer').payload), { name: 'My server', loader: 'fabric', gameVersion: '1.21.1', memoryMiB: 2048, javaExecutable: '', eulaAccepted: true }, 'creation keeps the sensible 2 GB default; RAM is chosen on the Memory step');
  await page.evaluate(() => { window.fixture.failure = 'createServer'; });
  await page.locator('#setup-create').click(); await settled(page);
  assert.equal(await page.locator('#setup-error').isVisible(), true, 'backend refusal is in the modal');
  await page.evaluate(s => { const call = window.seedhost.call; window.seedhost.call = async (method, payload) => { if (method === 'createServer') { window.fixture.calls.push({ method, payload }); window.fixture.state.server = s; window.fixture.state.servers=[{id:s.id,name:s.name,active:true,state:s.state,configured:true}]; return undefined; } return call(method, payload); }; }, { ...server(), profile: { ...server().profile, args: ['-Xmx4096M', '@args.txt', 'nogui'] } });
  await page.locator('#setup-create').click(); await settled(page);
  await page.waitForFunction(() => !document.querySelector('#setup-runtime').hidden);
  assert.equal(await page.locator('#setup-runtime-java').inputValue(), '/fixture/java', 'created Java selection is already in runtime help');
  assert.equal(await page.locator('#setup-runtime-java').isVisible(), false, 'Java maintenance is hidden behind Advanced, not a beginner setup chore');
  assert.equal(await page.locator('#setup-runtime-memory').inputValue(), '4096', 'the chosen RAM is already saved');
  assert.doesNotMatch(await page.locator('#setup-runtime-feedback').textContent(), /Create or import/, 'completed creation must not show the old prerequisite warning');
  assert.equal(await page.evaluate(() => window.fixture.calls.some(c => c.method === 'startServer')), false);
  await page.locator('#setup-back').click(); await settled(page);
  assert.equal(await page.locator('#setup-create').isDisabled(), true, 'revisiting cannot overwrite the created server');
});

test('existing profiles are not interrupted; simple Java help preserves argument files and native cancellation', async t => {
  const page = await renderer(t, appState(server()));
  assert.equal(await page.locator('#setup-dialog').isVisible(), false);
  await page.locator('#nav-setup').click();
  await page.locator('[data-setup-step="runtime"]').click(); await settled(page);
  assert.equal(await page.locator('#setup-profile-save').count(), 1, 'simple runtime help exists');
  await page.locator('#setup-java-advanced > summary').click();
  await page.locator('#setup-runtime-pick').click(); await settled(page);
  assert.equal(await page.locator('#setup-runtime-java').inputValue(), '/fixture/java', 'cancel preserves selection');
  await page.locator('#setup-runtime-memory').fill('3072');
  assert.equal(await page.locator('#setup-runtime-memory').inputValue(), '3072');
  await page.evaluate(() => { const call = window.seedhost.call; window.seedhost.call = async (method, payload) => { if (method === 'configureSimpleProfile') { window.fixture.calls.push({ method, payload }); window.fixture.state.server.profile = { executable: payload.javaExecutable, args: ['-Xmx3072M', '@args.txt', 'nogui'] }; return {}; } return call(method, payload); }; });
  await page.locator('#setup-profile-save').click(); await settled(page);
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.find(c => c.method === 'configureSimpleProfile').payload), { javaExecutable: '/fixture/java', memoryMiB: 3072 });
  assert.match(await page.locator('#setup-runtime-feedback').textContent(), /Saved/);
  assert.deepEqual(await page.evaluate(() => window.fixture.state.server.profile.args), ['-Xmx3072M', '@args.txt', 'nogui']);
  await page.locator('#setup-runtime-memory').fill('4096');
  await page.evaluate(() => { const call = window.seedhost.call; window.seedhost.call = async (method, payload) => method === 'configureSimpleProfile' ? undefined : call(method, payload); });
  await page.locator('#setup-profile-save').click(); await settled(page);
  assert.match(await page.locator('#setup-error').textContent(), /could not be confirmed/);
});

// The username flow signs in online; dismiss the one automatic sign-in prompt so a test can drive the guide deliberately.
async function closeAutoSignIn(page) {
  if (await page.locator('#account-dialog').evaluate(dialog => dialog.open)) { await page.locator('#account-dialog').press('Escape'); await page.waitForFunction(() => !document.querySelector('#account-dialog').open); return; }
  await page.waitForFunction(() => document.querySelector('#account-dialog').open, undefined, { timeout: 10000 });
  await page.locator('#account-dialog').press('Escape');
  await page.waitForFunction(() => !document.querySelector('#account-dialog').open);
}
const signedOutAccount = { configured: true, signedIn: false, online: true, username: null, detail: 'Create an account or sign in to this account directory.' };

test('optional friends stage points to the Friends page without moving the account card; skip persists', async t => {
  const page = await renderer(t, { ...appState(), account: { status: signedOutAccount, requests: [] } });
  await closeAutoSignIn(page);
  await page.locator('[data-setup-step="friends"]').click(); await settled(page);
  assert.equal(await page.locator('#setup-friends #account-card').count(), 0, 'the wizard never adopts the account card');
  assert.equal(await page.locator('#setup-friends #friends-controls').count(), 0, 'hosting controls stay in their workspace');
  assert.equal(await page.locator('#setup-friends #setup-open-friends').isVisible(), true, 'the wizard links to the Friends page');
  assert.equal(await page.locator('#friends-panel #account-card').count(), 1, 'the account card stays on the Friends page');
  assert.equal(await page.locator('#peers-panel #friends-controls').count(), 1, 'group controls live in Multi-host');
  assert.equal(await page.locator('#join-friend-form, #friend-code').count(), 0, 'no code entry anywhere');
  await page.locator('#setup-skip').click(); await settled(page);
  assert.equal(await page.locator('#setup-ready').isVisible(), true);
  const saved = await page.evaluate(() => window.fixture.state.onboarding);
  assert.deepEqual(saved.skipped, ['friends']);
  assert.equal(saved.completed, false, 'no server is not completion');
  assert.doesNotMatch(JSON.stringify(saved), /SEEDHOST-private-secret|friend-code|invitation/);
  await page.locator('#setup-next').click(); await settled(page);
  assert.equal(await page.locator('#join-friend-form, #friend-code, #invite-code').count(), 0, 'manual enrollment is absent everywhere');
  assert.equal(await page.locator('#peers-panel #refresh-friends').count(), 1, 'membership inspector stays usable in Multi-host');
  assert.equal(await page.locator('#friends-panel #account-card').count(), 1, 'the account card is never relocated');
  assert.equal(await page.locator('#setup-friends #account-card').count(), 0);
});

test('signed-out guide friends stage opens the Friends page and surfaces the sign-in prompt', async t => {
  const page = await renderer(t, { ...appState(), account: { status: signedOutAccount, requests: [] } });
  await closeAutoSignIn(page);
  await page.locator('[data-setup-step="friends"]').click(); await settled(page);
  const open = page.locator('#setup-open-friends');
  assert.equal(await open.isVisible(), true, 'the Friends link is visible in the guide');
  assert.equal(await open.isEnabled(), true);
  await open.click();
  await page.waitForFunction(() => !document.querySelector('#setup-dialog').open, undefined, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#account-dialog').open);
  assert.equal(await page.locator('#friends-panel').isVisible(), true, 'the guide closes onto the Friends page');
  const stacking = await page.evaluate(() => {
    const dialog = document.querySelector('#account-dialog');
    const rect = dialog.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { onTop: Boolean(top?.closest('#account-dialog')), friendsOpen: !document.querySelector('#friends-panel').hidden };
  });
  assert.equal(stacking.friendsOpen, true);
  assert.equal(stacking.onTop, true, 'sign-in dialog paints above the Friends page');
  await page.locator('#account-dialog').press('Escape');
  await page.waitForFunction(() => !document.querySelector('#account-dialog').open);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'account-open', 'focus returns to the sign-in call to action');
});

test('signed-in guide friends stage offers inline usernames; hosting invitations are global in Friends', async t => {
  const state = { ...appState(), relay: { fingerprint: 'c'.repeat(64), name: 'Home group', parkOnStop: true },
    account: { status: { configured: true, signedIn: true, online: true, username: 'alex', detail: 'Signed in · relay.example' },
      requests: [{ id: 'a'.repeat(36), from: 'sam', group: 'Sam’s group', expiresAt: Date.now() + 3600000 }] } };
  const page = await renderer(t, state);
  await page.locator('[data-setup-step="friends"]').click(); await settled(page);
  assert.equal(await page.locator('#setup-friends #account-card').count(), 0, 'the guide never hosts the account card');
  assert.equal(await page.locator('#setup-friend-add-form').isVisible(), true);
  assert.equal(await page.locator('#setup-open-friends').isVisible(), false, 'signed-in users never need to leave the guide to add a friend');
  assert.equal(await page.locator('#setup-dialog').isVisible(), true);
  assert.equal(await page.locator('#friends-panel #account-card').count(), 1, 'the ordinary account card stays in Friends');
  assert.equal(await page.locator('#friends-panel #hosting-request-list').count(), 1, 'hosting invitations are reachable without a selected server');
  assert.equal(await page.locator('#peers-panel #hosting-request-list').count(), 0, 'Multi-host retains outgoing invitations, not the global inbox');
  assert.equal(await page.locator('#setup-friends #friends-controls').count(), 0, 'code controls are never moved into the guide');
});

test('“Join a friend’s world” closes the guide onto the Friends sign-in flow', async t => {
  const state = { ...appState(), account: { status: signedOutAccount, requests: [] } };
  // A truly fresh draft opens the choices. The other fixtures deliberately use a named, resumable Create draft.
  state.onboarding.draft.name = 'My Minecraft server';
  const page = await renderer(t, state);
  await closeAutoSignIn(page);
  assert.equal(await page.evaluate(() => window.fixture.state.server), null, 'join starts without an existing server');
  assert.equal(await page.locator('#setup-choose-join').isVisible(), true, 'fresh guide exposes the real join choice');
  assert.match(await page.locator('#setup-choose-join').textContent(), /username/i, 'choice copy describes the username flow');
  assert.doesNotMatch(await page.locator('#setup-choose-join').textContent(), /invitation code/i);
  await page.locator('#setup-choose-join').click();
  await page.waitForFunction(() => !document.querySelector('#setup-dialog').open, undefined, { timeout: 10000 });
  assert.equal(await page.locator('#friends-panel').isVisible(), true, 'the guide closes onto the Friends page');
  assert.equal(await page.locator('#friends-panel #account-card').count(), 1, 'the account card stays on its own page');
  await page.waitForFunction(() => document.querySelector('#account-dialog').open);
  assert.equal(await page.evaluate(() => document.querySelector('#setup-dialog').open), false, 'the guide does not linger behind the sign-in prompt');
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('#account-dialog'))), true, 'sign-in fields remain keyboard-usable');
  await page.locator('#account-dialog').press('Escape');
  await page.waitForFunction(() => !document.querySelector('#account-dialog').open);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'account-open', 'Join-triggered sign-in returns focus to the sign-in action');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('#account-dialog'))), false, 'dismissing Join sign-in does not trap focus');
});

test('guide excludes gateway stages and leaves the optional role in Multi-host', async t => {
  const page = await renderer(t, appState(server()));
  await page.locator('#nav-setup').click();
  assert.equal(await page.locator('[data-setup-step="gateway"]').count(), 0);
  assert.equal(await page.locator('#setup-dialog #setup-gateway').count(), 0);
  await page.locator('[data-setup-step="friends"]').click(); await settled(page);
  await page.locator('#setup-skip').click(); await settled(page);
  assert.equal(await page.locator('#setup-ready').isVisible(), true);
  await page.locator('#setup-next').click(); await settled(page);
  assert.equal(await page.evaluate(() => window.fixture.state.onboarding.completed), true);
    await page.locator('.server-row-name').click();
    await page.locator('#peers-tab').click();
  assert.equal(await page.locator('#multi-always-on-enable').isVisible(), true);
  assert.equal(await page.evaluate(() => window.fixture.calls.some(c => c.method === 'alwaysOnEnable')), false);
});

test('real revision list uses native restore API, cancellation retains world and unsafe states disable restore but not Stop', async t => {
  const selected = { ...server(), id: 'revision-fixture' };
  const page = await renderer(t, { ...appState(selected), servers: [{ id: selected.id, name: selected.name, active: true, state: 'offline' }] });
  if (await page.locator('#setup-dialog').evaluate(d => d.open)) await page.locator('#setup-later').click();
  await page.bringToFront();
  await page.locator('#server-list [data-action="open"]').click();
  assert.equal(await page.locator('#snapshot-history').count(), 1, 'history is available in the server workspace');
  await page.waitForFunction(() => document.querySelectorAll('#snapshot-list li').length === 2);
  assert.match(await page.locator('#snapshot-history').textContent(), /local.*not.*remote/i);
  await page.locator('#backups-tab').click();
  const restore = page.locator('#snapshot-list button[data-snapshot="s0"]');
  await restore.click(); await settled(page);
  assert.equal(await page.evaluate(() => window.fixture.state.server.snapshotId), 's1');
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.find(c => c.method === 'restoreSnapshot').payload), { snapshotId: 's0' });
  await page.evaluate(() => { window.fixture.state.server.state = 'running'; window.fixture.state.server.ownership.state = 'hosting'; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('#server-status').textContent === 'Hosting');
  assert.equal(await restore.isDisabled(), true);
  assert.equal(await page.locator('#stop-server').isDisabled(), false);
  await page.evaluate(() => { window.fixture.state.server.state = 'offline'; window.fixture.state.server.ownership.state = 'owned'; window.fixture.state.server.modInstallError = 'Install fence'; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('#server-status').textContent === 'Stopped');
  assert.equal(await restore.isDisabled(), true);
});

test('modal keeps errors, close and navigation on-screen at both sizes; polling preserves keyboard focus', async t => {
  const state = { ...appState(), relay: { fingerprint: 'c'.repeat(64), name: 'Keyboard group', parkOnStop: true },
    account: { status: { configured: true, signedIn: true, online: true, username: 'alex', detail: 'Signed in · fixture directory' }, requests: [] } };
  const page = await renderer(t, state);
  await page.locator('[data-setup-step="friends"]').click(); await settled(page);
  assert.equal(await page.locator('#setup-friends #account-card').count(), 0, 'the guide never hosts the account card');
  assert.equal(await page.locator('#setup-friends #friends-controls').count(), 0, 'legacy code controls stay outside the guide');
  // Inline username controls remain attached and focused during polling.
  await page.locator('#setup-friend-username').focus();
  await page.locator('#setup-friend-username').fill('keyboard_user');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await settled(page);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'setup-friend-username', 'polling must not detach focused guide username controls');
  assert.equal(await page.locator('#setup-friend-username').inputValue(), 'keyboard_user', 'polling preserves typed guide username input');
  for (const [width, height] of [[1000, 700], [1240, 860]]) {
    await page.setViewportSize({ width, height });
    for (const stage of ['server', 'runtime', 'friends', 'ready']) {
      await page.locator(`[data-setup-step="${stage}"]`).click(); await settled(page);
      const geometry = await page.evaluate(() => {
        const d = document.querySelector('#setup-dialog');
        return { overflow: d.scrollWidth > d.clientWidth + 1, buttons: ['setup-save-close', 'setup-next'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return { id, visible: r.top >= 0 && r.bottom <= innerHeight }; }) };
      });
      assert.equal(geometry.overflow, false, `${stage} no horizontal overflow at ${width}`);
      assert.equal(geometry.buttons.every(b => b.visible), true, `${stage} close/footer in viewport at ${width}`);
    }
  }
});

test('failed optional progress saves cannot trap the user away from lifecycle controls', async t => {
  const existing = server(); existing.state = 'running'; existing.ownership.state = 'hosting';
  const page = await renderer(t, appState(existing));
  await page.locator('#nav-setup').click();
  await page.evaluate(() => { window.fixture.failure = 'saveOnboarding'; });
  await page.locator('#setup-save-close').click(); await settled(page);
  assert.equal(await page.locator('#setup-error').isVisible(), true);
  assert.equal(await page.locator('#setup-close-unsaved').count(), 1, 'failed progress has emergency close');
  await page.locator('#setup-close-unsaved').click();
  assert.equal(await page.locator('#setup-dialog').isVisible(), false);
  assert.equal(await page.locator('#stop-server').isDisabled(), false);
});

test('ready completion requires a real launch command, not just an executable or visiting a stage', async t => {
  const existing = server(); existing.profile.args = [];
  const page = await renderer(t, appState(existing));
  await page.locator('#nav-setup').click(); await page.locator('[data-setup-step="ready"]').click(); await settled(page);
  await page.locator('#setup-next').click(); await settled(page);
  assert.equal(await page.evaluate(() => window.fixture.state.onboarding.completed), false, 'missing arguments are not a prepared server');
});

test('Operate displays actual player tunnel status independently of the saved address preference', async t => {
  const state = appState(server()); state.gateway = { enabled: true, localPort: 25565, state: 'ready', detail: 'Pinned confirmed holder' };
  state.settings = { persistentAddress: true, gatewayAddress: 'relay.example:25565' };
  const page = await renderer(t, state);
  assert.equal(await page.locator('#player-gateway-status').count(), 1, 'actual gateway status lives in Operate');
  assert.match(await page.locator('#player-gateway-status').textContent(), /Ready.*Pinned confirmed holder/);
  assert.equal(await page.locator('#player-address').textContent(), 'Displayed player address: relay.example:25565');
  await page.evaluate(() => { window.fixture.state.gateway.state = 'error'; window.fixture.state.gateway.detail = 'Relay unreachable'; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('#player-gateway-status').textContent.includes('Relay unreachable'));
  assert.match(await page.locator('#player-gateway-status').textContent(), /Error/);
});
