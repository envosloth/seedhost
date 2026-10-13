// TEST-ONLY bridge controlled by the renderer tests; no file/network/process effects.
const { contextBridge, ipcRenderer } = require('electron');
let fixture;
const clone = value => JSON.parse(JSON.stringify(value));
function reset() {
  const deviceId = 'a'.repeat(64);
  const make = (id, name, ownerName) => ({ id, name, state: 'offline', ownerName, serverDir: '/fixture/' + id, storeDir: '/fixture/store/' + id, snapshotId: id + '-backup', ownership: { state: 'owned', owner: deviceId }, profile: { executable: 'fixture-java', args: ['-Xmx2048M', '-jar', 'server.jar', 'nogui'] }, mods: { server: [], client: [] }, modTarget: { loader: 'fabric', gameVersion: '1.21.1' } });
  const alpha = make('alpha', 'Mossy Hollow', 'This PC'), bravo = make('bravo', 'Sky Islands', null);
  fixture = { calls: [], serverMap: { alpha, bravo }, state: { version: 'renderer-fixture', deviceId, server: alpha, servers: [{ id: 'alpha', name: alpha.name, active: true, state: 'offline', ownerName: 'This PC', configured: true, publicJoinAddress: { address: 'mossy-hollow.playit.gg:25565', reachability: 'unverified', source: 'playit', targetServerId: 'alpha' } }, { id: 'bravo', name: bravo.name, active: false, state: 'offline', ownerName: null, configured: true, publicJoinAddress: null }], peers: [], settings: {}, relay: null, logs: [], onboarding: { version: 1, step: 'ready', dismissed: true, completed: false, skipped: [], draft: { name: '', loader: 'vanilla', gameVersion: '', memoryMiB: 2048 }, error: null }, gateway: { enabled: false, localPort: 25565, state: 'off', detail: '' } }, dashboard: {}, files: {}, held: null, heldFriend: null, fail: null };
  for (const id of ['alpha', 'bravo']) fixture.dashboard[id] = { serverId: id, state: 'offline', performance: { pid: null, cpuPercent: null, memoryMiB: null, uptimeSeconds: null, sampledAt: null, error: null }, players: { online: null, max: null, sample: [], error: null }, settings: { motd: id + ' world', 'max-players': 20, difficulty: 'normal', gamemode: 'survival', pvp: true, 'white-list': false, 'view-distance': 10, 'simulation-distance': 10, 'server-port': 25565 }, schedules: [], logs: [id + ' log'] };
}
reset();
contextBridge.exposeInMainWorld('dashboardFixture', {
  reset, read: () => clone(fixture), set: value => { for (const [k, v] of Object.entries(value)) fixture[k] = v; },
  release: () => { fixture.heldGroup?.resolve(); fixture.heldGroup = null; fixture.groupHeld=false; fixture.held?.resolve(); fixture.held = null; fixture.heldFiles?.resolve(); fixture.heldFiles = null; fixture.heldFriend?.resolve(); fixture.heldFriend = null; },
  releaseCall: method => {fixture.heldCalls?.[method]?.resolve(); if(fixture.heldCalls)delete fixture.heldCalls[method];},
  // TEST-ONLY: reads the real OS clipboard so tests verify copy completion independently of the page's own claim.
  clipboardText: () => ipcRenderer.invoke('fixture:clipboard', 'read')
});
contextBridge.exposeInMainWorld('seedhost', { call: async (method, payload) => {
  fixture.calls.push({ method, payload: payload ?? null });
  // TEST-ONLY held IPC results, for deterministic overlapping-operation feedback tests.
  if (fixture.holdCalls?.includes(method)) await new Promise(resolve => {
    fixture.heldCalls ??= {}; fixture.heldCalls[method] = {resolve};
  });
  // TEST-ONLY native consent seam: null means Cancel, undefined means a successful void result.
  if (fixture.cancelMethod === method) return null;
  if (fixture.fail === method) throw new Error('TEST failure for ' + method);
  if (method.includes('Window') || method.startsWith('window')) return ipcRenderer.invoke('fixture:window', method);
  if (method === 'accountStatus') return clone(fixture.accountStatus ?? {configured:false,signedIn:false,online:false,username:null,detail:'No directory configured'});
  if (method === 'accountRequests') return clone(fixture.accountRequests ?? []);
  // TEST-ONLY friendship seam: simulates the accountFriend* IPC the parent merges; no real backend.
  if (method === 'accountFriends') return clone(fixture.accountFriends ?? []);
  if (method === 'accountFriendRequests') return clone(fixture.accountFriendRequests ?? []);
  if (method === 'accountFriendSend') {
    if (fixture.holdFriendOp === 'accountFriendSend') { await new Promise(resolve => { fixture.heldFriend = { resolve }; }); }
    if (fixture.failFriendOp === 'accountFriendSend') throw new Error('TEST failure for ' + method);
    fixture.friendSends = [...(fixture.friendSends ?? []), payload.username];
    return clone(fixture.friendSendResult ?? { sent: true, username: payload.username, id: 'friend-sent-' + fixture.friendSends.length });
  }
  if (method === 'accountFriendAccept') {
    if (fixture.holdFriendOp === 'accountFriendAccept') { await new Promise(resolve => { fixture.heldFriend = { resolve }; }); }
    if (fixture.failFriendOp === 'accountFriendAccept') throw new Error('TEST failure for ' + method);
    const request = (fixture.accountFriendRequests ?? []).find(r => r.id === payload.id);
    if (!request) throw new Error('Unknown friend request');
    fixture.accountFriendRequests = fixture.accountFriendRequests.filter(r => r.id !== payload.id);
    fixture.accountFriends = [...(fixture.accountFriends ?? []), { username: request.from, since: 1720000000000 }];
    return { added: true, username: request.from };
  }
  if (method === 'accountFriendDecline') {
    if (fixture.holdFriendOp === 'accountFriendDecline') { await new Promise(resolve => { fixture.heldFriend = { resolve }; }); }
    fixture.accountFriendRequests = (fixture.accountFriendRequests ?? []).filter(r => r.id !== payload.id);
    return { declined: true, id: payload.id };
  }
  if (method === 'accountFriendRemove') {
    if (fixture.failFriendOp === 'accountFriendRemove') throw new Error('TEST failure for ' + method);
    fixture.accountFriends = (fixture.accountFriends ?? []).filter(f => f.username !== payload.username);
    return { removed: true, username: payload.username };
  }
  if (method === 'accountSend') { fixture.hostInvites = [...(fixture.hostInvites ?? []), payload.username]; return { sent: true, username: payload.username, group: payload.fingerprint }; }
  if (method === 'accountStartGroup') { fixture.state.relay = fixture.state.relay ?? { name: 'Fixture group', fingerprint: 'c'.repeat(64), parkOnStop: true }; return { created: true }; }
  if (method === 'accountAccept') {
    const request = (fixture.accountRequests ?? []).find(r => r.id === payload.id);
    fixture.accountRequests = (fixture.accountRequests ?? []).filter(r => r.id !== payload.id);
    if (fixture.accountAcceptState) Object.assign(fixture.state, clone(fixture.accountAcceptState));
    return clone(fixture.accountAcceptResult ?? { joined: true, group: request?.group });
  }
  if (method === 'accountDecline') { fixture.accountRequests = (fixture.accountRequests ?? []).filter(r => r.id !== payload.id); return { declined: true, id: payload.id }; }
  if (method === 'accountUpdateProfile') {
    if (fixture.profileResponseMismatch) return clone(fixture.accountStatus);
    fixture.accountStatus = { ...fixture.accountStatus, username: payload.username };
    return clone(fixture.accountStatus);
  }
  if (method === 'saveOnboarding') fixture.state.onboarding = {...payload,version:1,error:null};
  if (method === 'getState') return clone(fixture.state);
  if (method === 'selectServer') {
    fixture.state.server = fixture.serverMap[payload.id]; fixture.state.logs = [];
    fixture.state.servers.forEach(e => { e.active = e.id === payload.id; });
  }
  if (method === 'getServerDashboard') {
    const response = clone(fixture.dashboard[payload.id]);
    if (fixture.holdDashboard === payload.id) { fixture.holdDashboard = null; await new Promise(resolve => { fixture.held = { resolve }; }); }
    return response;
  }
  if (method === 'listSnapshots') return [{ id: fixture.state.server.id + '-backup', current: true, bytes: 1024, fileCount: 2 }];
  if (method === 'createSnapshot') fixture.state.server.snapshotId += '-new';
  if (method === 'listFriends') return clone(fixture.friends ?? (fixture.state.relay ? { members: [{name:'Fixture owner',fingerprint:fixture.state.deviceId,you:true}],canManage:true,owner:fixture.state.deviceId,custody:'unknown',holder:null } : { members: [], custody: 'unknown', holder: null }));
  if (method === 'publicAddressStatus') return { state: 'off', address: null, detail: 'needs-always-on' };
  if (method === 'playitStatus') return { state: 'unconnected' };
  if (method === 'alwaysOnStatus') return { running: false };
  if (method === 'updateStatus' || method === 'updateCheck') {
    // Scriptable update seam: fixture.updateBusy simulates a running operation (badge "Checking…"),
    // fixture.updateDone marks a completed check; both live on the fixture object the tests set().
    if (method === 'updateCheck') fixture.updateDone = true;
    const base = { current: '0.5.0-test', packaged: false, platform: 'win32', checkedAt: null, latest: null, upToDate: false, error: null, busy: null, downloading: null, staged: null };
    if (fixture.updateBusy) return { ...base, busy: 'checking' };
    if (fixture.updateDone) return { ...base, checkedAt: new Date().toISOString(), upToDate: true };
    return base;
  }
  if (method === 'managePlayer') { const d = fixture.dashboard[payload.id]; if (payload.action === 'kick') { d.players.sample = d.players.sample.filter(p => p.name !== payload.name); d.players.online = d.players.sample.length; } }
  if (method === 'leaveGroup') {
    if (!fixture.leaveReadbackMismatch) {
      fixture.state.server.group = null;
      fixture.state.relay = null;
      fixture.state.pendingGroups = (fixture.state.pendingGroups ?? []).filter(group=>group.fingerprint!==payload.fingerprint);
      for (const entry of fixture.state.servers) if(entry.id===payload.id) entry.group = null;
    }
    return {left:true,serverId:payload.id,fingerprint:payload.fingerprint};
  }
  if (method === 'disbandGroup') {
    const target=fixture.state;
    if (fixture.holdGroupOp) {fixture.groupHeld=true;await new Promise(resolve=>{fixture.heldGroup={resolve};});}
    if (!fixture.disbandReadbackMismatch) target.relay=null;
    return {disbanded:true,serverId:payload.id,fingerprint:payload.fingerprint};
  }
  if (method === 'saveServerSettings') Object.assign(fixture.dashboard[payload.id].settings, payload.settings);
  if (method === 'saveServerSchedule') { const jobs = fixture.dashboard[payload.id].schedules; const schedule = { ...payload.schedule, id: payload.schedule.id || 'job-' + (jobs.length + 1), serverId: payload.id, nextRunAt: null, lastRunAt: null, lastOutcome: null }; const i = jobs.findIndex(j => j.id === schedule.id); if (i >= 0) jobs[i] = schedule; else jobs.push(schedule); return clone(jobs); }
  if (method === 'deleteServerSchedule') { const d = fixture.dashboard[payload.id]; d.schedules = d.schedules.filter(j => j.id !== payload.scheduleId); return clone(d.schedules); }
  if (method === 'runServerSchedule') fixture.dashboard[payload.id].schedules.find(j => j.id === payload.scheduleId).lastOutcome = 'TEST-only ran';
  if (method === 'listServerFiles') { const response = { serverId: payload.id, path: payload.path, entries: payload.path ? [{ name: 'notes.txt', path: 'config/notes.txt', kind: 'file', bytes: 5, editable: true }] : [{ name: 'config', path: 'config', kind: 'directory', bytes: null, editable: false }, { name: 'server.properties', path: 'server.properties', kind: 'file', bytes: 20, editable: true }, { name: 'server.jar', path: 'server.jar', kind: 'file', bytes: 1024, editable: false }] }; if (fixture.holdFiles === payload.id) { fixture.holdFiles = null; await new Promise(resolve => { fixture.heldFiles = { resolve }; }); } return response; }
  if (method === 'readServerFile') return { serverId: payload.id, path: payload.path, text: fixture.files[payload.id + ':' + payload.path]?.text ?? 'motd=fixture\n', hash: fixture.files[payload.id + ':' + payload.path]?.hash ?? 'h1', bytes: 13 };
  if (method === 'writeServerFile') {
    const key = payload.id + ':' + payload.path, previous = fixture.files[key] ?? { text: 'motd=fixture\n', hash: 'h1' };
    fixture.files[key] = { text: payload.text, hash: payload.text === previous.text ? previous.hash : 'h2' };
    return { serverId: payload.id, path: payload.path, hash: fixture.files[key].hash, bytes: payload.text.length, backupFile: 'TEST-only' };
  }
  return undefined;
} });
