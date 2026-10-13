/* Per-server workspace. Existing controls are relocated, never cloned; the preload remains the only privilege boundary. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const processLabels = { offline: 'Stopped', failed: 'Failed', running: 'Running', starting: 'Starting', stopping: 'Stopping' };
  const pages = ['home', 'operate', 'console', 'peers', 'settings'];
  let state = null, blocked = true, currentPage = 'home', hooks = null, selectionGeneration = 0;
  const button = (text, cls = 'button button-small') => { const n = el('button', cls, text); n.type = 'button'; return n; };
  const homeTab = button('Home', 'nav-tab'); homeTab.id = 'home-tab'; homeTab.setAttribute('role', 'tab'); homeTab.setAttribute('aria-controls', 'home-panel');
  const navIcon = el('span', 'nav-icon'); navIcon.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-server"/></svg>';
  const navCopy = el('span', 'nav-copy'); navCopy.append(el('span', 'nav-text', 'Home'), el('span', 'nav-sub', 'Your server library')); homeTab.replaceChildren(navIcon, navCopy);
  document.querySelector('.nav-tabs').prepend(homeTab);
  const home = el('section', 'page'); home.id = 'home-panel'; home.setAttribute('role', 'tabpanel'); home.setAttribute('aria-labelledby', 'home-tab');
  const inner = el('div', 'page-inner'); home.append(inner); $('operate-panel').before(home);
  const homeHeader = el('header', 'page-header');
  const homeTitle = el('h1', '', 'Home'); homeTitle.id = 'home-title';
  homeHeader.append(homeTitle, el('p', 'page-lead', 'Your worlds, on your PCs. Choose a server to manage it.'));
  inner.append(homeHeader);
  const library = $('server-library'); inner.append(library); library.classList.add('card', 'home-library');
  const actions = el('div', 'home-actions'); actions.append($('add-server'), $('import-server')); library.querySelector('.server-library-head').append(actions);
  const limit = library.querySelector('.field-help'); limit.id = 'home-concurrency'; limit.textContent = 'One server can run at a time on this PC. Stop the server before switching; each world keeps its own settings and backups.';
  library.append($('server-empty'));
  const selectionHint = el('p', 'field-help'); selectionHint.id = 'home-selection-hint'; selectionHint.setAttribute('role', 'status'); library.append(selectionHint);
  const stopFirst = button('Stop server', 'button button-stop button-small'); stopFirst.id = 'home-stop-first'; stopFirst.hidden = true; library.append(stopFirst);
  stopFirst.addEventListener('click', () => {
    if (stopFirst.disabled || !hooks || !['running', 'starting'].includes(state?.server?.state)) return;
    void hooks.runAction('stopServer');
  });

  function addPage(name, title, subtitle, icon) {
    const tab = button('', 'nav-tab'); tab.id = name + '-tab'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', name + '-panel');
    const art = el('span', 'nav-icon'); art.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg>`;
    const copy = el('span', 'nav-copy'); copy.append(el('span', 'nav-text', title), el('span', 'nav-sub', subtitle)); tab.append(art, copy); $('peers-tab').before(tab);
    const panel = el('section', 'page'); panel.id = name + '-panel'; panel.hidden = true; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
    const body = el('div', 'page-inner'); const heading = el('header', 'page-header'); heading.append(el('h1', '', title)); body.append(heading); panel.append(body); $('settings-panel').before(panel); pages.splice(pages.length - 1, 0, name); return body;
  }
  const playersBody = addPage('players', 'Players', 'Online & whitelist', 'i-friends');
  playersBody.innerHTML += '<section class="card dashboard-card"><h2 id="players-count">Unavailable</h2><p id="players-help" class="field-help"></p><ul id="players-list" class="dashboard-list" aria-label="Sampled online players"></ul><form id="player-form" class="dashboard-inline-form"><div><label for="player-name">Minecraft name</label><input type="text" id="player-name" maxlength="16" autocomplete="off" spellcheck="false" required pattern="[A-Za-z0-9_]{1,16}"></div><div><label for="player-action">Action</label><select id="player-action"><option value="whitelist-add">Add to whitelist</option><option value="whitelist-remove">Remove from whitelist</option></select></div><button id="player-submit" type="submit" class="button">Send action</button></form><p id="player-feedback" class="field-help" role="status"></p></section>';
  const locallyOwned = () => state?.server?.ownership?.owner === state?.deviceId && ['owned', 'hosting'].includes(state?.server?.ownership?.state);
  const canManagePlayers = () => !blocked && locallyOwned() && state?.server?.state === 'running';
  function renderPlayers() {
    const p = dashboard?.players;
    $('players-count').textContent = `${sampled(p?.online) ? p.online : 'Unavailable'} / ${sampled(p?.max) ? p.max : 'Unavailable'} online`;
    $('players-help').textContent = p?.error || 'Names are the server’s reported sample; the sample may not include every online player. Actions require this PC to own the running server.';
    const signature = JSON.stringify([p?.sample, canManagePlayers()]);
    if ($('players-list').dataset.signature !== signature) {
      $('players-list').dataset.signature = signature;
      const list = Array.isArray(p?.sample) ? p.sample : [];
      $('players-list').replaceChildren(...(list.length ? list.map(player => {
        const item = el('li', 'dashboard-list-row'); item.append(el('strong', '', player.name)); const kick = button('Kick'); kick.dataset.player = player.name; kick.disabled = !canManagePlayers(); item.append(kick); return item;
      }) : [el('li', 'field-help', p?.online === 0 ? 'No players online.' : 'No player names reported.')]));
    }
    for (const id of ['player-name', 'player-action', 'player-submit']) $(id).disabled = !canManagePlayers();
  }
  async function playerAction(action, name) {
    if (!canManagePlayers() || !/^[A-Za-z0-9_]{1,16}$/.test(name)) return;
    const id = selectedId(), generation = selectionGeneration; $('player-feedback').textContent = 'Sending action…';
    const current = () => selectedId() === id && generation === selectionGeneration;
    const ok = await hooks.runAction('managePlayer', { id, action, name });
    if (!current()) return;
    if (ok) {
      const refreshed = await refreshDashboard(true);
      if (!current()) return;
      $('player-feedback').textContent = refreshed ? 'Command sent to the running server. Check Console for the result.' : 'Action sent, but server data could not be refreshed. Check Console for the result.';
    } else $('player-feedback').textContent = 'Action was not confirmed. Check the error above and try again.';
  }
  $('player-form').addEventListener('submit', event => { event.preventDefault(); void playerAction($('player-action').value, $('player-name').value); });
  $('players-list').addEventListener('click', event => { const b = event.target.closest('button[data-player]'); if (b && !b.disabled) void playerAction('kick', b.dataset.player); });

  const tunnelsBody = addPage('tunnels', 'Tunnels', 'Player addresses & routing', 'i-globe');
  const tunnelsScope = el('p', 'field-help', 'Each server has its own Playit address pointing to its Minecraft port on this PC. Assign distinct ports in Server settings before setting up the addresses. These local addresses do not follow multi-host handoffs; the shared-hosting gateway is configured separately below. An address is not proof of public reachability.'); tunnelsScope.id = 'tunnels-scope';
  tunnelsBody.append(tunnelsScope, $('public-card'), $('player-gateway'), $('playit-panel'));

  const settingsBody = addPage('server-settings', 'Server settings', 'Properties & launch', 'i-settings');
  const PROPERTY_FIELDS = [['motd', 'Message of the day', 'text', 200], ['server-port', 'Server port', 'number', null], ['max-players', 'Max players', 'number', null], ['difficulty', 'Difficulty', 'select', ['peaceful', 'easy', 'normal', 'hard']], ['gamemode', 'Game mode', 'select', ['survival', 'creative', 'adventure', 'spectator']], ['pvp', 'Player versus player', 'boolean', null], ['white-list', 'Whitelist', 'boolean', null], ['view-distance', 'View distance (chunks)', 'number', null], ['simulation-distance', 'Simulation distance (chunks)', 'number', null], ['hardcore', 'Hardcore (permanent death; takes effect on next start)', 'boolean', null], ['spawn-protection', 'Spawn protection radius (0 disables)', 'number', null], ['allow-flight', 'Allow flight (avoid kicking flight-enabled players)', 'boolean', null]];
  settingsBody.insertAdjacentHTML('beforeend', '<section class="card dashboard-card"><h2>Server properties</h2><p id="properties-help" class="field-help"></p><form id="properties-form" class="dashboard-form"></form><p id="properties-feedback" class="field-help" role="status"></p></section>');
  const propertyInput = field => $('property-' + field);
  const propertiesDirty = new Set();
  const propertyRevisions = new Map();
  function propertyValue(field, values) {
    const value = values?.[field], kind = PROPERTY_FIELDS.find(([key]) => key === field)?.[2];
    if (kind === 'boolean') return value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined;
    if (kind === 'number') return value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined;
    return value;
  }
  for (const [field, label, kind, extra] of PROPERTY_FIELDS) {
    // The field name is both the server.properties key and the guard-tested hook; label text stays human.
    const group = el('div', kind === 'boolean' ? 'setting-row switch-row' : 'setting-block'); const input = el(kind === 'select' ? 'select' : 'input');
    input.id = 'property-' + field; input.name = field; input.dataset.field = field;
    if (kind === 'select') input.append(...extra.map(v => { const o = el('option', '', v); o.value = v; return o; }));
    else { input.type = kind === 'boolean' ? 'checkbox' : kind; if (extra != null) input.maxLength = extra; if (kind === 'number') input.min = field === 'server-port' ? 1 : 0; if (field === 'server-port') input.max = 65535; }
    const text = el('label', 'setting-label', label + ' '); text.htmlFor = input.id; text.append(el('small', '', field));
    group.append(text, input); $('properties-form').append(group);
  }
  const propertiesSave = button('Save properties', 'button button-primary'); propertiesSave.id = 'properties-save'; propertiesSave.type = 'submit';
  const propertiesActions = el('div', 'page-actions'); propertiesActions.append(propertiesSave); $('properties-form').append(propertiesActions);
  function readProperties() {
    const values = {}; for (const [field, , kind] of PROPERTY_FIELDS) { const input = propertyInput(field); if (!propertiesDirty.has(field)) continue; if (kind === 'boolean') values[field] = input.checked; else values[field] = kind === 'number' ? Number(input.value) : input.value; }
    return values;
  }
  function renderProperties() {
    const current = dashboard?.settings;
    const stopped = stoppedOwned();
    for (const [field, , kind] of PROPERTY_FIELDS) {
      const input = propertyInput(field); input.disabled = blocked || !locallyOwned() || !stopped || !dashboard || Boolean(dashboard.settingsError);
      const value = propertyValue(field, current);
      if (!propertiesDirty.has(field)) {
        if (kind === 'boolean') { input.checked = value === true; input.indeterminate = value === undefined; }
        else input.value = value == null ? '' : String(value);
      }
    }
    const unknown = Array.isArray(dashboard?.settings?.unknownKeys) ? ` ${dashboard.settings.unknownKeys.length} unsupported key(s) are left untouched.` : '';
    $('properties-help').textContent = !dashboard ? 'Refresh data to read this server’s properties.' : dashboard.settingsError ? `Properties unavailable: ${dashboard.settingsError}. Saving is blocked; refresh after repairing the file.` : `${stopped ? 'Only edited properties are saved and verified against server.properties. Indeterminate boxes mean the file does not set that value.' : 'Stop this owned server before changing properties. The launch profile below is read-only while it runs.'}${unknown}`;
    $('properties-save').disabled = blocked || !locallyOwned() || !stopped || !dashboard || Boolean(dashboard.settingsError);
  }
  $('properties-form').addEventListener('input', event => { const field = event.target.dataset.field; if (field) { propertiesDirty.add(field); propertyRevisions.set(field, (propertyRevisions.get(field) || 0) + 1); } renderProperties(); });
  $('properties-form').addEventListener('submit', async event => {
    event.preventDefault(); if ($('properties-save').disabled) return;
    if (PROPERTY_FIELDS.some(([field, , kind]) => kind === 'number' && propertiesDirty.has(field) && propertyInput(field).value.trim() === '')) { $('properties-feedback').textContent = 'Enter a whole number for each edited numeric property; an empty field is not zero.'; return; }
    const changed = {}; for (const [field, value] of Object.entries(readProperties())) { const before = propertyValue(field, dashboard?.settings); if (value !== undefined && value !== before) changed[field] = value; }
    if (!Object.keys(changed).length) { $('properties-feedback').textContent = 'No property changes to save.'; return; }
    const revisions = new Map(propertyRevisions);
    const ok = await panelAction('saveServerSettings', { settings: changed }, 'properties-feedback', d => !d.settingsError && Object.entries(changed).every(([k, v]) => propertyValue(k, d.settings) === v), 'Verified saved properties against the server read-back.');
    if (ok) { for (const field of Object.keys(changed)) if (propertyRevisions.get(field) === revisions.get(field)) propertiesDirty.delete(field); renderProperties(); }
  });
  settingsBody.append($('profile-details'));
  settingsBody.append(el('p', 'warning-copy', 'The launch profile (Java path and arguments) is unchanged and remains the only way to change how the server starts. Memory and Java are also reachable from the setup guide.'));

  const filesBody = addPage('server-files', 'Server files', 'Open managed folder', 'i-folder');
  filesBody.insertAdjacentHTML('beforeend', '<section class="card dashboard-card"><h2>Managed server folder</h2><p class="field-help">Server files opens this world’s managed working copy in your system file manager. Stop the server before editing files. Downloaded originals and backups are separate; edits here are not automatically backed up.</p><button id="file-open-folder" type="button" class="button">Open folder again</button><p id="file-feedback" class="field-help" role="status" aria-live="polite"></p></section>');
  let filesToken = 0, filesBusy = false;
  function resetFiles() { filesToken++; filesBusy = false; $('file-feedback').textContent = ''; }
  function renderFiles() { $('file-open-folder').disabled = blocked || filesBusy || !selectedId(); }
  async function openServerFolder() {
    const id = selectedId(), generation = selectionGeneration;
    if (!id || blocked || filesBusy) return;
    const token = ++filesToken, current = () => token === filesToken && generation === selectionGeneration && selectedId() === id;
    filesBusy = true; renderFiles(); $('file-feedback').textContent = 'Opening managed server folder…';
    try {
      await window.seedhost.call('openServerFolder', { id });
      if (current()) $('file-feedback').textContent = 'Opened the managed server folder in your system file manager.';
    } catch (error) {
      if (current()) $('file-feedback').textContent = `Couldn’t open this server’s folder: ${reason(error)}. Try again.`;
    } finally { if (current()) { filesBusy = false; renderFiles(); } }
  }
  $('file-open-folder').addEventListener('click', () => void openServerFolder());

  const modsBody = addPage('mods', 'Mods', 'Modrinth & client pack', 'i-puzzle'); modsBody.append($('mods-details'));

  // Friends is a static global page: its account card never moves between ordinary and hosting contexts.
  pages.splice(pages.length - 1, 0, 'friends');
  // Direct device trust is an advanced app setting, not friend enrollment.
  $('settings-panel').querySelector('.page-inner').append($('advanced-peers'));

  const multiBody = $('peers-panel').querySelector('.page-inner');
  // Legacy internal connection controls remain inert and hidden outside the guide.
  // The supported optional role actions below are Multi-host-only, not setup stages.
  multiBody.append($('setup-gateway'));
  $('peers-tab').querySelector('.nav-text').textContent = 'Multi-host'; $('peers-tab').querySelector('.nav-sub').textContent = 'Group & world handoff';
  multiBody.querySelector('h1').textContent = 'Multi-host';
  const multiScope = el('p', 'field-help multi-host-scope', 'The selected server’s hosting group is shown here. Membership, invitations and world handoffs use that group, not an unrelated server’s group. Account friendships and this PC’s optional always-on role are app-wide. Disband revokes the entire selected group, not just its local association.'); multiScope.id = 'multi-host-scope';
  multiBody.querySelector('.page-header').after(multiScope, $('relay-card'));
  const groupDanger = el('section', 'card dashboard-card'); groupDanger.innerHTML = '<h2>Disband hosting group</h2><p class="field-help">Group-wide revocation requires the group owner, an online updated relay, and this stopped world safely owned here. Older relays cannot verify disbanding; this never substitutes a local disconnect. Every member and outstanding invitation loses group access. Worlds, backups, accounts, friendships and Playit routes are kept; copies already held elsewhere cannot be erased. This group identity cannot be reused.</p><button id="disband-group" type="button" class="button button-danger">Disband group…</button><p id="disband-feedback" class="field-help" role="status"></p>'; multiBody.append(groupDanger);
  let groupMembership = null;
  function updateGroupMembership(value) { groupMembership = value; renderGroupActions(); }
  const leave = button('Leave group', 'button'); leave.id = 'leave-group'; leave.hidden = true; $('disband-group').before(leave);
  const ownerGroupHelp = groupDanger.querySelector('.field-help').textContent;
  function renderGroupActions() {
    const matched = groupMembership?.id === selectedId() && groupMembership?.fingerprint === state?.relay?.fingerprint;
    const owner = matched && groupMembership.owner === true;
    const member = matched && groupMembership.member === true;
    groupDanger.querySelector('h2').textContent = owner ? 'Disband hosting group' : member ? 'Leave hosting group' : 'Hosting group membership';
    groupDanger.querySelector('.field-help').textContent = owner ? ownerGroupHelp : member ? 'Leave only your membership. Other members, your local world and account friendships stay intact. Stop and publish or hand off the latest world before leaving. The relay must be online to verify removal.' : 'Refresh group members to verify which actions are available to you.';
    $('disband-group').hidden = !owner;
    $('disband-group').disabled = !owner || !stoppedOwned() || !state?.relay?.fingerprint;
    leave.hidden = !member;
    leave.disabled = !member || blocked || !['offline','failed'].includes(state?.server?.state) || state?.server?.ownership?.state !== 'transferred';
    leave.title = leave.disabled ? 'Stop and publish or hand off the world before leaving.' : 'Leave this group; keep your local world and account friendships.';
  }
  leave.addEventListener('click', async () => {
    if (leave.disabled) return;
    const id = selectedId(), fingerprint = state.relay.fingerprint, generation = selectionGeneration;
    const current = () => selectedId() === id && generation === selectionGeneration;
    $('disband-feedback').textContent = 'Leaving this group and verifying membership removal…';
    let result;
    const ok = await hooks.runAction('leaveGroup', {id,fingerprint}, value => {result=value;});
    if (!current()) return;
    if (!ok) { $('disband-feedback').textContent = 'Leave not verified. Keep the local group and retry when the relay is available; stop and publish first if you hold the world.'; return; }
    const saved = await window.seedhost.call('getState').catch(()=>null);
    if (!current()) return;
    const removed = saved?.server?.id === id && saved.server.group === null && saved.relay === null && Array.isArray(saved.pendingGroups) && !saved.pendingGroups.some(group=>group.fingerprint===fingerprint);
    $('disband-feedback').textContent = result?.left === true && result.serverId === id && result.fingerprint === fingerprint && removed ? 'Verified leave. Your local world and account friendships are kept.' : 'Group removal could not be confirmed. Refresh before retrying.';
  });
  $('disband-group').addEventListener('click', async () => {
    if ($('disband-group').disabled) return;
    const id = selectedId(), fingerprint = state.relay.fingerprint, generation = selectionGeneration;
    const current = () => selectedId() === id && generation === selectionGeneration;
    $('disband-feedback').textContent = 'Checking group-wide revocation…';
    let result;
    const ok = await hooks.runAction('disbandGroup', { id, fingerprint }, value => { result = value; });
    if (!current()) return;
    if (!ok) { $('disband-feedback').textContent = 'Disband not confirmed or cancelled. No local disconnect is claimed; check the error above before retrying.'; return; }
    const saved = await window.seedhost.call('getState').catch(() => null);
    if (!current()) return;
    $('disband-feedback').textContent = result?.disbanded === true && result.serverId === id && result.fingerprint === fingerprint && saved?.server?.id === id && saved.relay === null ? 'Verified disband and local group removal. Worlds, backups and account friendships are kept.' : 'Group removal could not be confirmed. Refresh and check the relay before retrying.';
  });
  const optionalRole = el('section', 'card dashboard-card'); optionalRole.innerHTML = '<h2>Always-on PC <span class="optional-tag">optional</span></h2><p id="multi-always-on-help" class="field-help">Off by default for new groups. Group control works while this app is open without a player gateway. This PC’s always-on role is app-wide; enabling or disabling it can affect other groups using this helper, not your separate local Playit routes. Existing opt-ins are kept.</p><p id="multi-always-on-status" class="field-help" role="status">Not checked</p><div class="page-actions"><button id="multi-always-on-enable" type="button" class="button">Enable this PC’s always-on role</button><button id="multi-always-on-disable" type="button" class="button">Disable this PC’s always-on role</button></div>'; multiBody.append(optionalRole);

  const schedulerBody = addPage('scheduler', 'Scheduler', 'Jobs while app is open', 'i-settings');
  schedulerBody.innerHTML += '<section class="card dashboard-card"><p id="scheduler-help" class="field-help">Intervals run only while this app is open. These are not Windows scheduled tasks. No start jobs: backups require a stopped, owned world; stop and command jobs require a running, owned server.</p><ul id="schedule-list" class="dashboard-list" aria-label="Server schedules"></ul><h2 id="schedule-form-title">New schedule</h2><form id="schedule-form" class="dashboard-form"><div><label for="schedule-name">Name</label><input type="text" id="schedule-name" maxlength="80" required autocomplete="off"></div><div><label for="schedule-action">Action</label><select id="schedule-action"><option value="backup">Save backup</option><option value="stop">Stop server</option><option value="command">Console command</option></select></div><div id="schedule-command-field" hidden><label for="schedule-command">One console command</label><input type="text" id="schedule-command" maxlength="4096" autocomplete="off" spellcheck="false"></div><div><label for="schedule-interval">Interval (minutes)</label><input id="schedule-interval" type="number" min="1" step="1" value="60" required></div><label class="inline-check"><input id="schedule-enabled" type="checkbox" checked> Enabled</label><div class="page-actions"><button id="schedule-save" type="submit" class="button button-primary">Save schedule</button><button id="schedule-cancel" type="button" class="button" hidden>Cancel edit</button></div></form><p id="schedule-feedback" class="field-help" role="status"></p></section>';
  let editingSchedule = null;
  const stoppedOwned = () => !blocked && locallyOwned() && state?.server?.ownership?.state === 'owned' && ['offline', 'failed'].includes(state?.server?.state) && !state?.server?.modInstallError;
  const dateLabel = value => value ? new Date(value).toLocaleString() : 'Not scheduled';
  function resetSchedule() { editingSchedule = null; $('schedule-form').reset(); $('schedule-form-title').textContent = 'New schedule'; $('schedule-cancel').hidden = true; $('schedule-command-field').hidden = true; }
  function renderSchedules() {
    const jobs = Array.isArray(dashboard?.schedules) ? dashboard.schedules : [];
    const unavailable = !dashboard || Boolean(dashboard.scheduleError);
    $('scheduler-help').textContent = dashboard?.scheduleError ? `Scheduling unavailable: ${dashboard.scheduleError}. Repair the schedule metadata and refresh before trying again.` : 'Intervals run only while this app is open. These are not Windows scheduled tasks. No start jobs: backups require a stopped, owned world; stop and command jobs require a running, owned server.';
    const signature = JSON.stringify([jobs, blocked, locallyOwned(), state?.server?.state, unavailable]);
    if ($('schedule-list').dataset.signature !== signature) {
      $('schedule-list').dataset.signature = signature;
      $('schedule-list').replaceChildren(...(jobs.length ? jobs.map(job => {
        const item = el('li', 'dashboard-list-row'); const copy = el('div', 'dashboard-row-copy'); copy.append(el('strong', '', job.name));
        copy.append(el('p', 'field-help', `${job.action} · every ${job.intervalMinutes} minutes · ${job.enabled ? 'Enabled' : 'Paused'}`));
        copy.append(el('p', 'field-help', `Next: ${dateLabel(job.nextRunAt)} · Last: ${job.lastRunAt ? dateLabel(job.lastRunAt) : 'Never'} · ${job.lastOutcome == null ? 'No outcome yet' : typeof job.lastOutcome === 'string' ? job.lastOutcome : JSON.stringify(job.lastOutcome)}`));
        const actions = el('div', 'page-actions');
        for (const [action, text] of [['edit', 'Edit'], ['run', 'Run now'], ['delete', 'Delete']]) { const b = button(text); b.dataset.jobAction = action; b.dataset.jobId = job.id; b.disabled = blocked || unavailable || !locallyOwned() || (action === 'run' && !(job.action === 'backup' ? stoppedOwned() : canManagePlayers())); if (action === 'run' && b.disabled) b.title = job.action === 'backup' ? 'Stop this owned server before saving a backup' : 'Start this owned server before running this job'; actions.append(b); }
        item.append(copy, actions); return item;
      }) : [el('li', 'field-help', dashboard ? 'No schedules for this server yet.' : 'Refresh data to load schedules.')]));
    }
    for (const n of $('schedule-form').querySelectorAll('input,select,button')) n.disabled = blocked || !locallyOwned() || unavailable;
  }
  async function panelAction(method, payload, feedback, verify, success) {
    const id = selectedId(), generation = selectionGeneration; $(feedback).textContent = 'Saving / checking server data…';
    const current = () => selectedId() === id && generation === selectionGeneration;
    const ok = await hooks.runAction(method, { id, ...payload });
    if (!current()) return false;
    if (!ok) { $(feedback).textContent = 'Not confirmed. Check the error above; your entries are kept.'; return false; }
    const refreshed = await refreshDashboard(true);
    if (!current()) return false;
    if (!refreshed || !dashboard || !verify(dashboard)) { $(feedback).textContent = 'The server read-back did not confirm this change. Refresh and check before retrying.'; return false; }
    $(feedback).textContent = success; return true;
  }
  $('schedule-action').addEventListener('change', () => { $('schedule-command-field').hidden = $('schedule-action').value !== 'command'; });
  $('schedule-cancel').addEventListener('click', resetSchedule);
  $('schedule-form').addEventListener('submit', async event => {
    event.preventDefault(); if ($('schedule-save').disabled) return;
    const action = $('schedule-action').value, interval = Number($('schedule-interval').value), command = $('schedule-command').value;
    if (!Number.isSafeInteger(interval) || interval < 1 || !/^[0-9]+$/.test($('schedule-interval').value)) { $('schedule-feedback').textContent = 'Use a positive whole number of minutes.'; return; }
    if (action === 'command' && (!command.trim() || /[\0\r\n]/.test(command))) { $('schedule-feedback').textContent = 'Enter exactly one console command.'; return; }
    const schedule = { ...(editingSchedule ? { id: editingSchedule } : {}), name: $('schedule-name').value.trim(), action, ...(action === 'command' ? { command } : {}), intervalMinutes: interval, enabled: $('schedule-enabled').checked };
    if (await panelAction('saveServerSchedule', { schedule }, 'schedule-feedback', d => d.schedules?.some(j => Object.entries(schedule).every(([k, v]) => j[k] === v)), 'Verified saved schedule.')) resetSchedule();
  });
  $('schedule-list').addEventListener('click', async event => {
    const b = event.target.closest('button[data-job-action]'); if (!b || b.disabled) return;
    const job = dashboard.schedules.find(j => j.id === b.dataset.jobId); if (!job) return;
    if (b.dataset.jobAction === 'edit') {
      editingSchedule = job.id; $('schedule-name').value = job.name; $('schedule-action').value = job.action; $('schedule-interval').value = job.intervalMinutes; $('schedule-enabled').checked = job.enabled; $('schedule-command').value = job.command || ''; $('schedule-command-field').hidden = job.action !== 'command'; $('schedule-form-title').textContent = 'Edit schedule'; $('schedule-cancel').hidden = false; $('schedule-name').focus(); return;
    }
    if (b.dataset.jobAction === 'delete') { if (await panelAction('deleteServerSchedule', { scheduleId: job.id }, 'schedule-feedback', d => !d.schedules?.some(j => j.id === job.id), 'Verified removal.')) resetSchedule(); }
    else await panelAction('runServerSchedule', { scheduleId: job.id }, 'schedule-feedback', d => d.schedules?.some(j => j.id === job.id && j.lastOutcome != null), 'Runner outcome loaded below; check whether it succeeded.');
  });

  // One header is shared by every server section; Home and App settings are renderer-only destinations.
  const serverHeader = el('section', 'server-workspace-header'); serverHeader.id = 'server-workspace-header';
  home.before(serverHeader); serverHeader.append(document.querySelector('.server-identity'), $('server-toolbar'), $('server-start-trust'), $('server-recovery-reminder'), $('group-recovery-status'), $('group-recovery-actions'), $('server-action-hint'));
  const dashboardBar = el('div', 'dashboard-bar');
  const dashboardStatus = el('p', 'field-help'); dashboardStatus.id = 'dashboard-status'; dashboardStatus.setAttribute('role', 'status');
  const dashboardRefresh = button('Refresh data'); dashboardRefresh.id = 'dashboard-refresh'; dashboardBar.append(dashboardStatus, dashboardRefresh); serverHeader.append(dashboardBar);
 const backupsBody = addPage('backups', 'Backups', 'Local world revisions', 'i-backup');
 const backupActions = el('div', 'page-actions'); backupActions.append($('create-snapshot'), $('clean-up')); backupsBody.append(backupActions, $('snapshot-history'));
 $('operate-tab').querySelector('.nav-text').textContent = 'Performance'; $('operate-tab').querySelector('.nav-sub').textContent = 'Process & usage';
  const performance = el('section', 'card performance-card'); performance.setAttribute('aria-labelledby', 'performance-title');
  const performanceTitle = el('h1', '', 'Performance'); performanceTitle.id = 'performance-title'; performance.append(performanceTitle, el('p', 'field-help', 'Live process samples from this PC. Unavailable means no measurement, not zero usage.'));
  const metrics = el('dl', 'performance-grid');
  for (const [id, label] of [['cpu', 'CPU'], ['memory', 'Memory'], ['uptime', 'Uptime'], ['pid', 'Process ID']]) {
    const group = el('div', 'metric well'); const value = el('dd', '', 'Unavailable'); value.id = 'performance-' + id; group.append(el('dt', '', label), value); metrics.append(group);
  }
  const performanceNotice = el('p', 'field-help'); performanceNotice.id = 'performance-notice'; performance.append(metrics, performanceNotice);
  $('operate-panel').querySelector('.page-inner').prepend(performance);

  let dashboard = null, dashboardId = null, dashboardRequest = 0, dashboardInFlight = false, requestedAt = 0, dashboardStateLogs = null;
  const selectedId = () => state?.servers?.find(s => s.active)?.id ?? state?.server?.id ?? null;
  const reason = error => (error?.message || String(error)).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
  const sampled = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  function logsFor(next) { const id = next?.servers?.find(s => s.active)?.id ?? next?.server?.id ?? null; return dashboard && dashboard.serverId === id && Array.isArray(dashboard.logs) && JSON.stringify(next?.logs || []) === dashboardStateLogs ? dashboard.logs : next?.logs || []; }
  function renderConsole() {
    const logs = logsFor(state); $('console-lines').textContent = logs.join('\n'); $('console-empty').hidden = logs.length > 0;
    $('console-peek-line').textContent = logs.at(-1) || 'No process output yet.';
    if ($('follow-logs').checked) $('console-output').scrollTop = $('console-output').scrollHeight;
  }
  function renderDashboard() {
    renderConsole(); renderPlayers(); renderSchedules(); renderProperties();
    const p = dashboard?.performance;
    $('performance-cpu').textContent = sampled(p?.cpuPercent) ? `${Number(p.cpuPercent.toFixed(2))}%` : 'Unavailable';
    // These samples are MiB, so retain honest binary units when scaling to GiB.
    $('performance-memory').textContent = !sampled(p?.memoryMiB) ? 'Unavailable' : p.memoryMiB >= 1024 ? `${Number((p.memoryMiB / 1024).toFixed(1))} GiB` : `${Number(p.memoryMiB.toFixed(2))} MiB`;
    $('performance-uptime').textContent = sampled(p?.uptimeSeconds) ? `${Math.floor(p.uptimeSeconds)} s` : 'Unavailable';
    $('performance-pid').textContent = sampled(p?.pid) ? String(p.pid) : 'Unavailable';
    performanceNotice.textContent = p?.error || (p?.sampledAt ? `Sampled ${new Date(p.sampledAt).toLocaleString()}` : 'No process sample is available.');
  }
  async function refreshDashboard(force = false) {
    const id = selectedId(); if (!id || !hooks || blocked || (dashboardInFlight && !force)) return false;
    const finishLoading = force ? window.seedLoading?.begin('Refreshing performance and server details…') : null;
    const token = ++dashboardRequest; dashboardInFlight = true; requestedAt = Date.now(); dashboardStatus.textContent = 'Loading server data…';
    const stateLogs = JSON.stringify(state?.logs || []);
    try {
      const next = await window.seedhost.call('getServerDashboard', { id });
      if (token !== dashboardRequest || selectedId() !== id) return false;
      if (!next || next.serverId !== id) throw new Error('The response belongs to a different server. Refresh to try again.');
      dashboard = next; dashboardId = id; dashboardStateLogs = stateLogs; renderDashboard(); dashboardStatus.textContent = 'Updated from this server'; return true;
    } catch (error) {
      if (token === dashboardRequest && selectedId() === id) { dashboard = null; renderDashboard(); dashboardStatus.textContent = `Couldn’t load server data: ${reason(error)}. Use Refresh data to retry.`; }
      return false;
    } finally { finishLoading?.(); if (token === dashboardRequest) dashboardInFlight = false; }
  }
  dashboardRefresh.addEventListener('click', () => void refreshDashboard(true));
  const dashboardPages = new Set(['operate', 'players', 'scheduler', 'server-settings']);
  const DASHBOARD_SAMPLE_INTERVAL = 5000;
  function syncRoute() {
    const serverPage = !['home', 'friends', 'settings'].includes(currentPage);
    // Remembered backend selection is not an opened workspace. Home stays a library;
    // its stop-first control remains available if a server is running.
    const workspaceOpen = serverPage && Boolean(state?.server);
    for (const name of ['operate', 'console', 'players', 'backups', 'scheduler', 'peers', 'mods', 'tunnels', 'server-settings', 'server-files']) $(name + '-tab').hidden = !workspaceOpen;
    for (const name of ['friends', 'settings']) $(name + '-tab').hidden = workspaceOpen;
    serverHeader.hidden = !workspaceOpen;
    dashboardRefresh.disabled = blocked || !selectedId();
    renderPlayers(); renderSchedules(); renderProperties(); renderFiles();

    if (dashboardPages.has(currentPage) && !dashboard && !dashboardInFlight) void refreshDashboard();
  }

  function selectPage(name, focus = false) {
    if (!pages.includes(name)) return;
    if (!['home', 'friends', 'settings'].includes(name) && !state?.server) return;
    const pageChanged = currentPage !== name;
    currentPage = name;
    for (const p of pages) {
      $(p + '-panel').hidden = p !== name;
      const tab = $(p + '-tab'); tab.setAttribute('aria-selected', String(p === name)); tab.tabIndex = p === name ? 0 : -1; tab.classList.toggle('is-active', p === name);
    }
    if (name === 'console' && $('follow-logs').checked) $('console-output').scrollTop = $('console-output').scrollHeight;
    syncRoute();
    if (focus) $(name + '-tab').focus();
    // Ordinary page changes are observable so the guide closes instead of floating over another workspace.
    if (pageChanged) window.dispatchEvent(new Event('seedhost-page-changed'));
  }
  // One fixed information architecture: the library first, then the selected server's sections.
  const TAB_ORDER = ['home', 'friends', 'settings', 'operate', 'console', 'players', 'backups', 'scheduler', 'peers', 'mods', 'tunnels', 'server-settings', 'server-files'];
  document.querySelector('.nav-tabs').append(...TAB_ORDER.map(name => $(name + '-tab')));
  document.querySelector('main').append(...TAB_ORDER.map(name => $(name + '-panel')));

  function bind(callbacks) {
    hooks = callbacks;
    for (const p of pages) {
      $(p + '-tab').addEventListener('click', () => { selectPage(p); if (p === 'server-files') void openServerFolder(); });
      $(p + '-tab').addEventListener('keydown', event => {
        const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
        if (!step && !['Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const names = TAB_ORDER.filter(n => !$(n + '-tab').hidden && !$(n + '-tab').disabled);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? names.length - 1 : (names.indexOf(p) + step + names.length) % names.length;
        selectPage(names[index], true);
      });
    }
    $('server-list').addEventListener('click', async event => {
      if (!(event.target instanceof Element) || event.target.closest('button,a,input,select,textarea')) return;
      const b = event.target.closest('.server-row'); if (!b || b.getAttribute('aria-disabled') === 'true' || !hooks) return;
      if (!state.servers.some(s => s.id === b.dataset.serverId && s.active)) {
        if (!await hooks.runAction('selectServer', { id: b.dataset.serverId })) return;
      }
      selectPage('operate');
    });
    $('server-list').addEventListener('keydown', event => {
      if (event.target.matches('.server-row') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.target.click(); }
    });
    // Copying an address is its own action: it must never select a server or disturb the current selection.
    $('server-list').addEventListener('click', event => {
      const copy = event.target instanceof Element ? event.target.closest('button[data-copy-address]') : null;
      if (!copy || copy.disabled) return;
      event.stopPropagation();
      void copyJoinAddress(copy);
    });
    selectPage('home'); return selectPage;
  }
  // A card only offers a public playit address that the core explicitly attributed to that exact server.
  // No localhost/LAN/global address is ever fabricated here; a missing or mismatched record stays "not set".
  const validJoinAddress = value => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
  function joinAddressRecord(entry) {
    const record = entry?.publicJoinAddress;
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    if (record.source !== 'playit' || record.targetServerId !== entry.id) return null;
    if (!validJoinAddress(record.address)) return null;
    return { address: record.address.trim(), reachability: record.reachability === 'verified' ? 'verified' : 'unverified' };
  }
  // The copy path is stricter than the display path: joining is only ever offered for an address the core still
  // reports verified for this exact server. Unverified text stays visible as secondary info, never copyable.
  function joinAddressFor(entry) {
    const record = joinAddressRecord(entry);
    return record && record.reachability === 'verified' ? record : null;
  }
  function joinAddressRow(entry) {
    const row = el('div', 'server-card-address'); row.dataset.addressFor = entry.id;
    const record = joinAddressRecord(entry);
    if (!record) {
      // The current host's endpoint is not available to this PC yet. Never relabel this PC's old reserved
      // address as a join address: local reserved data stays secondary and is never copyable here.
      const remote = entry?.group && entry?.ownership && entry.ownership.owner && entry.ownership.owner !== state?.deviceId;
      if (remote) {
        row.append(el('span', 'field-help server-address-missing', 'Playit address not set — this world is hosted on another PC; its current endpoint is not available to this PC yet.'));
        if (validJoinAddress(entry.publicReservedAddress)) row.append(el('span', 'field-help', `Reserved local address (secondary, may not be current): ${entry.publicReservedAddress.trim()}`));
        return row;
      }
      row.append(el('span', 'field-help server-address-missing', 'Playit address not set')); return row;
    }
    row.append(el('span', 'subtle-label', 'PLAYIT ADDRESS'), el('code', 'mono server-address-value', record.address));
    row.append(el('span', 'field-help', record.reachability === 'verified' ? 'Reachability verified.' : 'Reachability unverified.'));
    if (record.reachability !== 'verified') return row;
    const copy = button('Copy', 'text-button server-address-copy'); copy.dataset.copyAddress = entry.id;
    copy.setAttribute('aria-label', `Copy Playit address for ${entry.name || 'this server'}`);
    const status = el('span', 'field-help server-address-status'); status.setAttribute('role', 'status');
    row.append(copy, status); return row;
  }
  let addressCopyToken = 0;
  async function copyJoinAddress(copy) {
    const id = copy.dataset.copyAddress;
    const status = copy.closest('.server-card-address')?.querySelector('.server-address-status') ?? null;
    const label = text => { if (status) status.textContent = text; };
    const token = ++addressCopyToken;
    copy.disabled = true;
    try {
      // Re-read live state: the polled card may be stale, and a copy is only allowed while the core still
      // reports this exact address as the verified join address of this exact server.
      const record = joinAddressFor((await window.seedhost.call('getState').catch(() => null))?.servers?.find(s => s.id === id));
      if (token !== addressCopyToken) return;
      if (!record) { label('This address is no longer available. Refresh data.'); return; }
      await navigator.clipboard.writeText(record.address);
      // The completion claim is based on this live verdict again: a reading that changed during the write never claims success.
      const current = joinAddressFor((await window.seedhost.call('getState').catch(() => null))?.servers?.find(s => s.id === id));
      if (token !== addressCopyToken || !current || current.address !== record.address) return;
      let verified = null;
      try { verified = (await navigator.clipboard.readText()) === record.address; } catch { verified = null; }
      if (token !== addressCopyToken) return;
      label(verified === true ? 'Copied and verified against the clipboard.' : verified === false ? 'Copied, but the clipboard could not be verified. Copy again.' : 'Copied to the clipboard.');
    } catch {
      if (token === addressCopyToken) label('Copy failed. Select the address and copy it manually.');
    } finally {
      if (token === addressCopyToken) copy.disabled = false;
    }
  }
  function renderServers(next, busy) {
    state = next; blocked = busy;
    // Prefer the authoritative library; fall back to describing the single selected server so older state shapes still render cards.
    const servers = Array.isArray(state?.servers) ? state.servers : state?.server ? [{ id: 'current', name: state.server.name, active: true, state: state.server.state, ownerName: state.server.ownerName ?? null, configured: Boolean(state.server.profile?.executable && state.server.profile?.args?.length) }] : [];
    const active = Boolean(state?.server && (!['offline', 'failed'].includes(state.server.state) || state.server.ownership?.state === 'hosting'));
    library.hidden = false; $('add-server').disabled = busy || active;
    selectionHint.textContent = active ? `Stop ${state.server.name} before switching to another server. Home stays available while it runs.` : '';
    stopFirst.hidden = !active; stopFirst.disabled = busy || !['running', 'starting'].includes(state?.server?.state);
    // Sections that render one selected server are disabled until this PC actually has one.
    for (const name of ['operate', 'console', 'players', 'backups', 'scheduler', 'mods', 'tunnels', 'server-settings', 'server-files']) { const tab = $(name + '-tab'); if (tab) tab.disabled = !state?.server; }
    // The signature follows the display record: every visible address/reachability change must redraw the row.
    const signature = JSON.stringify(servers.map(entry => [entry.id, entry.name, entry.active, entry.state, entry.ownerName, entry.configured, joinAddressRecord(entry)]));
    if ($('server-list').dataset.signature === signature) {
      for (const row of $('server-list').querySelectorAll('.server-row')) {
        const entry = servers.find(s => s.id === row.dataset.serverId);
        row.setAttribute('aria-disabled', String(busy || (active && !entry?.active)));
        row.title = active && !entry?.active ? `Stop ${state.server.name} before switching` : `Open ${entry?.name}`;
        const remove = row.querySelector('button[data-action="delete"]'); if (remove) remove.disabled = busy || active;
      }
      return;
    }
    $('server-list').dataset.signature = signature;
    $('server-list').replaceChildren(...servers.map(entry => {
      const row = el('li', entry.active ? 'server-row is-current' : 'server-row'); row.dataset.serverId = entry.id; row.dataset.action = 'open'; row.dataset.id = entry.id;
      const art = el('span', 'server-card-art'); art.setAttribute('aria-hidden', 'true'); art.innerHTML = '<svg class="icon"><use href="#i-cube"/></svg>';
      const copy = el('div', 'server-card-copy'); copy.append(el('strong', 'server-row-name', entry.name || 'Untitled server'));
      copy.append(el('span', 'server-card-meta', `${processLabels[entry.state] || 'Unknown state'} · Owner: ${entry.ownerName || 'Unknown'}`));
      copy.append(el('span', 'field-help', entry.configured === true ? 'Launch profile configured' : entry.configured === false ? 'Launch profile needs setup' : 'Launch configuration unknown'));
      copy.append(joinAddressRow(entry));
      const a = el('div', 'server-row-actions');
      row.setAttribute('role', 'button'); row.tabIndex = 0; row.setAttribute('aria-label', `Open ${entry.name || 'Untitled server'}`);
      row.setAttribute('aria-disabled', String(busy || (active && !entry.active)));
      row.title = active && !entry.active ? `Stop ${state.server.name} before switching` : `Open ${entry.name}`;
      const remove = button('Delete…', 'button button-small button-danger'); remove.dataset.action = 'delete'; remove.dataset.id = entry.id; remove.disabled = busy || active;
      a.append(remove); row.append(art, copy, a); return row;
    }));
  }
  function update(next, busy) {
    state = next; blocked = busy;
    if (selectedId() !== dashboardId) {
      selectionGeneration++;
      dashboardRequest++; dashboardInFlight = false; dashboard = null; dashboardId = selectedId(); requestedAt = 0; propertiesDirty.clear(); resetFiles(); resetSchedule(); $('schedule-feedback').textContent = ''; $('player-feedback').textContent = ''; $('disband-feedback').textContent = ''; renderDashboard();
    }
    syncRoute();
    renderGroupActions();
    if (dashboardPages.has(currentPage) && !blocked && !dashboardInFlight && Date.now() - requestedAt >= DASHBOARD_SAMPLE_INTERVAL) void refreshDashboard();
    renderConsole();
  }
  window.seedDashboard = Object.freeze({ bind, update, renderServers, selectPage, logsFor, updateGroupMembership });
})();
