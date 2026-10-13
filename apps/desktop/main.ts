import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } from 'electron';
import path from 'node:path';
import { loadAccountServiceConfig } from '../../src/core/account-service-config.js';
import { AccountIntegration } from '../../src/core/account-integration.js';
import { PlayitIntegration } from '../../src/core/playit.js';
import { playitApi, probeMinecraft, probeMinecraftDetailed } from '../../src/core/playit-network.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SeedHostApplication, groupJavaLaunchArgs } from '../../src/core/application.js';
import { readServerPort } from '../../src/core/network-info.js';
import { loadIdentity } from '../../src/core/identity-store.js';
import { validateCall } from '../../src/core/ipc-policy.js';
import { decodeInvite, previewInvite } from '../../src/core/invites.js';
import { applicationMenuTemplate } from './menu.js';
import { ServerSetupClient, discoverJava, probeJava, type CreateServerInput } from '../../src/core/server-setup.js';
import type { SimpleProfileInput } from '../../src/core/java-arguments.js';
import type { ModSort } from '../../src/core/modrinth.js';
import { onboardingChecks } from '../../src/core/onboarding.js';
import { AlwaysOnHost } from '../../src/core/always-on.js';
import { Updater } from '../../src/core/updater.js';
import { GroupHelpers } from './group-helpers.js';
import { InlineHandoffConsent } from './inline-consent.js';
import { PerServerPublicAddresses, playitClaim } from '../../src/core/public-address.js';
const setupLinks: Record<string,string> = Object.freeze({
  eula:'https://www.minecraft.net/en-us/eula',
  java:'https://adoptium.net/temurin/releases/',
  fabric:'https://fabricmc.net/use/server/',
  relay:'https://github.com/envosloth/seedhost/blob/main/docs/relay.md',
});
let window:BrowserWindow;let tray:Tray;let backend:SeedHostApplication;let helpers:GroupHelpers;let publicAddress:PerServerPublicAddresses;let quitAllowed=false;let quitting=false;
let appNotice:string|null=null;const incomingHandoff=new InlineHandoffConsent();
let holderEndpointPublished:{serverId:string;address:string;verifiedAt:number}|null=null;
// Display name; the profile folder below is SeedHost (or --profile-root).
app.setName('Seed Hosting');
const profileArgument=process.argv.find(a=>a.startsWith('--profile-root='));
const root=profileArgument?path.resolve(profileArgument.slice('--profile-root='.length)):path.join(app.getPath('appData'),'SeedHost');
app.setPath('userData',root);
const html=fileURLToPath(new URL('../../../apps/desktop/index.html',import.meta.url));
const rendererUrl=pathToFileURL(html).href;
function show(){if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}}
// Borderless = the frameless window; fullscreen = the window owning the whole display, taskbar hidden.
function windowState(){return {fullScreen:window.isFullScreen(),maximized:window.isMaximized()};}
async function confirm(message:string,detail:string,action='Continue'):Promise<boolean>{return (await dialog.showMessageBox(window,{type:'question',message,detail,buttons:['Cancel',action],defaultId:0,cancelId:0,noLink:true})).response===1;}
async function quit(){
  if(quitting)return;quitting=true;
  try{
    const state=await backend.getState();
    if(state.busy){show();appNotice='An operation is still in progress. Wait until it completes before quitting.';return;}
    if(state.server?.state==='running'||state.server?.state==='starting'){
      show();
    }
    incomingHandoff.close();await backend.close();await publicAddress?.close();await helpers?.closeAll();quitAllowed=true;app.quit();
  }catch(e){show();appNotice='Could not quit safely: '+String(e).slice(0,300);}
  finally{quitting=false;}
}
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',show);
  app.on('before-quit',event=>{if(!quitAllowed){event.preventDefault();void quit();}});
  app.whenReady().then(async()=>{
    if(!safeStorage.isEncryptionAvailable())throw new Error('OS protected key storage (Windows DPAPI, macOS Keychain, or a Linux Secret Service) is unavailable. Refusing to store an unencrypted identity.');
    const identity=await loadIdentity(root,{encrypt:v=>safeStorage.encryptString(v),decrypt:v=>safeStorage.decryptString(v)});
    backend=new SeedHostApplication(root,identity,{resolveGroupLaunchProfile:async(serverDir,local)=>{
      // Discover LOCAL Java only. Shared files choose a bounded relative JAR plan, never an OS executable.
      const args=await groupJavaLaunchArgs(serverDir,local.args);
      const runtimes=local.executable?[await probeJava(local.executable)]:await discoverJava(path.join(root,'runtimes'));
      if(runtimes.length!==1)throw new Error('Choose an approved local Java runtime in this server’s settings, then retry Start. Missing or ambiguous local runtime setup cannot be guessed.');
      const hasHeap=args.some(arg=>/^-Xm[sx]\d+[MG]$/i.test(arg));
      return {...local,executable:runtimes[0]!.executable,args:hasHeap?args:['-Xms512M','-Xmx2048M',...args]};
    },beforeServerStart:async server=>{
      if(!publicAddress)throw new Error('Public route ownership guard is not ready; server launch refused');
      await publicAddress.assertCanStart(server);
    },chooseServerPort:async(id,occupied)=>{
      if(!publicAddress)throw new Error('Public route ownership guard is not ready; server creation refused');
      return publicAddress.newServerPort(id,occupied);
    },confirmIncomingHandoff:async(source,snapshot)=>{
      show();return incomingHandoff.request(source,snapshot.id);
    }});await backend.open();
    const accountConfig=await loadAccountServiceConfig({profileRoot:root,
      bundledDirectory:fileURLToPath(new URL('../../../apps/desktop/',import.meta.url)),
      isolated:!!profileArgument,override:process.env.SEEDHOST_ACCOUNT_SERVICE});
    const accounts=new AccountIntegration(root,identity,{encrypt:v=>safeStorage.encryptString(v),decrypt:v=>safeStorage.decryptString(v)},backend,accountConfig);
    // The always-on PC role runs inside this app: no Node.js install, terminal or commands. Each hosting group
    // gets its own helper (relay store + OS-encrypted identity) under the profile, so two worlds never alias
    // onto one group identity; the primary helper keeps the historic app-wide role and pairing codes.
    const vault={encrypt:(v:string)=>safeStorage.encryptString(v),decrypt:(v:Buffer)=>safeStorage.decryptString(v)};
    helpers=new GroupHelpers(path.join(root,'always-on'),{
      loadIdentity:helperRoot=>loadIdentity(helperRoot,vault),
      publishStoppedInitial:(pin,owner)=>backend.publishStoppedInitialGroup(pin,owner),
      role:async extra=>{
        const reservedGamePorts=(await backend.getState()).servers.map(server=>server.playerPort);
        if(profileArgument&&process.env.SEEDHOST_TEST_LOOPBACK==='1')return {host:'127.0.0.1',port:0,gamePorts:[0],discoveryPort:0,reservedGamePorts};
        return {reservedGamePorts,...(extra?{discoveryPort:0}:{})};
      }});
    { const state=await backend.getState();
      await helpers.restoreAll(fingerprint=>state.servers.some(entry=>entry.group?.fingerprint===fingerprint)||state.pendingGroups.some(entry=>entry.fingerprint===fingerprint)); }
    async function helperForSelected():Promise<AlwaysOnHost>{
      const state=await backend.getState();
      const entry=helpers.forFingerprint(state.server?.group?.fingerprint??null)??helpers.primary();
      if(!entry)throw new Error('The always-on helper is not ready yet; reopen the app and try again');
      return entry.host;
    }
    // Independent local-server addresses use one approved agent, not the shared-hosting helper gateway.
    publicAddress=new PerServerPublicAddresses(root,{vault,
      api:playitApi,claim:playitClaim,probe:probeMinecraftDetailed,openBrowser:url=>shell.openExternal(url),
      servers:async()=>(await backend.getState()).servers,
      reservedPorts:async()=>helpers.runningGamePorts()});
    await publicAddress.restore((await backend.getState()).servers);
    // Join-address telemetry: mirror the ACTIVE running hosted world's verified public address to this group's
    // relay, best-effort, at the same world-captured polling boundary that computes the UI projection. A failed
    // publish is logged quietly: it never pops up, never retries a launch and never undoes a start.
    function activeHostedJoin(state:any,helperPorts:number[]):{serverId:string;address:string;verifiedAt:number}|null{
      const entry=state.servers.find((server:any)=>server.state==='running'&&server.group)??null;
      if(!entry)return null;
      const pub=publicAddress.status(entry);
      const collision=state.servers.some((other:any)=>other.id!==entry.id&&other.playerPort===entry.playerPort)||helperPorts.includes(entry.playerPort);
      if(collision||typeof pub.joinAddress!=='string'||!pub.joinAddress||typeof pub.verifiedAt!=='number'||!Number.isSafeInteger(pub.verifiedAt)||pub.verifiedAt<=0)return null;
      return {serverId:entry.id,address:pub.joinAddress,verifiedAt:pub.verifiedAt};
    }
    function publishHolderEndpoint(endpoint:{serverId:string;address:string;verifiedAt:number}|null):void{
      holderEndpointPublished=endpoint;
      void backend.publishHostEndpoint(endpoint?{address:endpoint.address,verifiedAt:endpoint.verifiedAt}:null).catch(error=>{
        console.log('Join address telemetry: '+String((error as Error)?.message??error).replace(/[a-fA-F0-9]{32,}/g,'[redacted]').slice(0,300));
      });
    }
    function syncHolderEndpoint(state:any,helperPorts:number[]):void{
      const next=activeHostedJoin(state,helperPorts);
      const same=holderEndpointPublished===null?next===null:Boolean(next&&holderEndpointPublished.serverId===next.serverId&&holderEndpointPublished.address===next.address&&holderEndpointPublished.verifiedAt===next.verifiedAt);
      if(!same)publishHolderEndpoint(next);
    }
    // Called immediately after a host session opens: the relay's new session record is empty, so publish the
    // currently known state even when it matches the previous local projection.
    async function publishHolderEndpointNow():Promise<void>{
      const state=await backend.getState();const helperPorts=await helpers.runningGamePorts();
      publishHolderEndpoint(activeHostedJoin(state,helperPorts));
    }
    // In-app updates: checks the official GitHub releases, downloads and verifies the Windows package,
    // and stages the swap that runs after this app exits. SEEDHOST_UPDATE_ORIGIN redirects it for tests.
    const updater=new Updater({root:path.join(root,'updates'),currentVersion:app.getVersion(),packaged:app.isPackaged,platform:process.platform,arch:process.arch,apiOrigin:process.env.SEEDHOST_UPDATE_ORIGIN||undefined});
    let publicSelectionEpoch=0;
    const selectionEpochNow=()=>publicSelectionEpoch;
    const image=nativeImage.createFromPath(fileURLToPath(new URL('../../../apps/desktop/icon.png',import.meta.url)));
    if(image.isEmpty())throw new Error('App icon could not be loaded');
    window=new BrowserWindow({width:1240,height:860,minWidth:1000,minHeight:700,title:'Seed Hosting',icon:image,frame:false,fullscreen:true,fullscreenable:true,backgroundColor:'#0f1116',show:true,webPreferences:{preload:fileURLToPath(new URL('./preload.cjs',import.meta.url)),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.on('close',event=>{if(!quitAllowed){event.preventDefault();window.hide();}});
    const playit = new PlayitIntegration(root, {vault:{encrypt:v=>safeStorage.encryptString(v),decrypt:v=>safeStorage.decryptString(v)},api:playitApi,probe:probeMinecraft,gateway:async()=>{
      const state=await backend.getState();const relay=state.peers.find(p=>p.fingerprint===state.relay?.fingerprint);
      return {...await backend.checkGameGateway(),fingerprint:relay?.fingerprint??'',controlPort:relay?.port??0};
    }});
    ipcMain.handle('seedhost:call',async(event,method,payload)=>{
      const sender=new URL(event.senderFrame?.url??'about:blank');sender.hash='';
      const p=validateCall(method,payload,sender.href,rendererUrl,{senderId:event.sender.id,expectedSenderId:window.webContents.id,isMainFrame:event.senderFrame===window.webContents.mainFrame});
      switch(method){
        case 'accountStartGroup':{
          const a=await accounts.status();if(!a.signedIn||!a.online||!a.username)throw new Error('Sign in first');
          const state=await backend.getState();
          if(state.relay)throw new Error('This PC already belongs to a group');

          const helper=await helpers.create();
          const role=await helper.host.startGroup(a.username+'’s group',true);
          const invite=await helper.host.ownerInvite(a.username,identity.fingerprint);
          // Bind the group to the selected world when there is one; otherwise it is stored as this PC's group to use.
          await backend.joinHostingGroup({code:invite.code,name:a.username,serverId:state.server?.id??null,parkOnStop:role.enabled,adoptable:true});
          return {created:true};
        }
        case 'getHostingControlRoute':case 'setHostingControlRoute':{
          const host=helpers.list().map(entry=>entry.host.forGroupFingerprint(p.fingerprint)).find(Boolean);
          if(!host)throw new Error('This group authority is not hosted on this PC. Ask the group owner to configure its control route.');
          if(method==='getHostingControlRoute')return host.controlRoute();

          return host.setControlRoute({host:p.host,port:p.port});
        }
        case 'listHostingGroups':return backend.listHostingGroups(helpers.list().flatMap(entry=>entry.host.localGroupFingerprints()));
        case 'startGroup':{
          let captured:{id:string;dir:string}|null=null;
          const result=await backend.startGroupWithApproval(p.fingerprint,async approval=>{
            const helperPorts=await helpers.runningGamePorts(),minecraftPort=await readServerPort(approval.serverDir);
            if(helperPorts.includes(minecraftPort))throw new Error('Minecraft port is used by the player gateway. Choose a different port in Server settings; no process was launched.');
            const snapshot=await backend.getState(),selected=snapshot.server;
            if(selected&&selected.serverDir===approval.serverDir){captured={id:selected.id,dir:approval.serverDir};publicAddress.invalidateVerification(selected.id);}
            return true;
          });
          if(captured&&process.env.SEEDHOST_TEST_LOOPBACK!=='1'){
            const world=captured as {id:string;dir:string};
            try{
              const latest=await backend.getState();
              const entry=latest.servers.find(server=>server.id===world.id)??(latest.server?.id===world.id?latest.server:null);
              if(!entry)throw new Error('The started world is no longer in the library; its public address was not changed.');
              if(latest.server?.id===world.id&&latest.server.serverDir!==world.dir)throw new Error('The selected server changed while starting; its public address was not changed.');
              await publicAddress.enable(entry,latest.servers);
            }catch(error){
              appNotice='The group start succeeded, but its public address could not be set up: '+String((error as Error)?.message??error).replace(/[a-fA-F0-9]{32,}/g,'[redacted]').slice(0,300);
            }
          }
          void publishHolderEndpointNow();
          return result;
        }
        case 'claimPendingGroup':return backend.claimPendingGroup(p.fingerprint);
        case 'respondIncomingHandoff':incomingHandoff.respond(p.id,p.accepted);return {responded:true};
        case 'accountStatus':return accounts.status();
        case 'accountRequests':return accounts.requests();
        case 'accountUpdateProfile':return accounts.updateProfile(p as {username:string;currentPassword:string;newPassword?:string});
        case 'accountRegister':return accounts.authenticate('register',p as any);
        case 'accountLogin':return accounts.authenticate('login',p as any);
        case 'accountLogout':return accounts.logout();
        case 'accountSend':return accounts.send(p.username,{fingerprint:p.fingerprint,serverId:p.serverId});
        case 'accountAccept':return accounts.accept(p.id);
        case 'accountDecline':return accounts.decline(p.id);
        case 'accountFriends':return accounts.socialFriends();
        case 'accountFriendRequests':return accounts.socialRequests();
        case 'accountFriendSend':return accounts.socialSend(p.username);
        case 'accountFriendAccept':return accounts.socialAccept(p.id);
        case 'accountFriendDecline':return accounts.socialDecline(p.id);
        case 'accountFriendRemove':return accounts.socialRemove(p.username);
        case 'leaveGroup':return backend.leaveGroup(p.id,p.fingerprint);
        case 'disbandGroup':{
          const epoch=publicSelectionEpoch,state=await backend.getState();
          if(!state.server||state.server.id!==p.id||state.relay?.fingerprint!==p.fingerprint)throw new Error('The selected server or group changed. Refresh before continuing.');
          await backend.checkGroupDisband(p.id,p.fingerprint);
          if(epoch!==publicSelectionEpoch)throw new Error('The selected server changed. Refresh before continuing.');

          const latest=await backend.getState();
          if(epoch!==publicSelectionEpoch||latest.server?.id!==p.id||latest.relay?.fingerprint!==p.fingerprint)throw new Error('The selected server or group changed. Refresh before continuing.');
          return backend.disbandGroup(p.id,p.fingerprint);
        }
        case 'removeFriend':{
          const friends=await backend.listFriends(),target=friends.members.find(m=>m.fingerprint===p.fingerprint);
          if(!friends.canManage||!target||target.you||target.fingerprint===friends.owner)throw new Error('Only the group owner can remove a friend');

          await backend.removeFriend(p.fingerprint);return {removed:true};
        }
        case 'playitStatus':return playit.status();
        case 'playitSetup':return shell.openExternal('https://playit.gg/download');
        case 'playitCheck':return playit.check();
        case 'playitCreate':return playit.create();
        case 'playitDisconnect':await playit.disconnect();return playit.status();
        case 'playitImport':{
          const selected=await dialog.showOpenDialog(window,{title:'Select the approved playit agent secret file (plain hex)',properties:['openFile']});
          if(selected.canceled||!selected.filePaths[0])return null;

          try{await playit.importAgentFile(selected.filePaths[0]);return playit.status();}catch{throw new Error('Could not connect that agent. Select its plain hexadecimal secret file and check playit approval.');}
        }
        case 'selectServer':++publicSelectionEpoch;return backend.selectServer(p.id);
        case 'deleteServer':{
          const state=await backend.getState();
          const target=state.servers.find(entry=>entry.id===p.id);
          if(!target)throw new Error('That server is no longer in the library. Refresh and try again.');
          if(!await confirm('Delete “'+target.name+'” from this PC?','This permanently deletes this app’s managed copy of that server, its saved backups and its ownership record on this PC. Other servers, your group, your playit tunnel and the folder you originally imported are not touched. This cannot be undone.','Delete server'))return null;
          return backend.deleteServer(p.id);
        }
        case 'getServerDashboard':return backend.getServerDashboard(p.id);
        case 'openServerFolder':{
          const folder=await backend.resolveServerFolder(p.id);
          const error=await shell.openPath(folder);
          if(error)throw new Error('Could not open server folder: '+error);
          return {opened:true,serverId:p.id};
        }
        case 'listServerFiles':return backend.listServerFiles(p.id,p.path);
        case 'readServerFile':return backend.readServerFile(p.id,p.path);
        case 'writeServerFile':case 'saveServerSettings':case 'saveServerSchedule':case 'deleteServerSchedule':case 'runServerSchedule':case 'managePlayer':{
          const state=await backend.getState();
          if(!state.server||state.server.id!==p.id)throw new Error('The selected server changed. Refresh before continuing.');

          if(method==='writeServerFile')return backend.writeServerFile(p.id,p.path,p.text,p.expectedHash);
          if(method==='saveServerSettings')return backend.saveServerSettings(p.id,p.settings);
          if(method==='saveServerSchedule')return backend.saveServerSchedule(p.id,p.schedule);
          if(method==='deleteServerSchedule')return backend.deleteServerSchedule(p.id,p.scheduleId);
          if(method==='runServerSchedule')return backend.runServerSchedule(p.id,p.scheduleId);
          return backend.managePlayer(p.id,p.action,p.name);
        }
        case 'getState':{
          const state=await backend.getState();
          const alwaysStatus=await (await helperForSelected()).status();
          const helperPorts=await helpers.runningGamePorts();
          syncHolderEndpoint(state,helperPorts);
          const checks=onboardingChecks(state.onboarding,{...state,alwaysOn:alwaysStatus});
          const publicJoin=(entry:typeof state.servers[number])=>{
            const pub=publicAddress.status(entry);
            const collision=state.servers.some(other=>other.id!==entry.id&&other.playerPort===entry.playerPort)||helperPorts.includes(entry.playerPort);
            // Only a fresh verified join address is a join address; reserved/local routes stay explicit
            // secondary data and are never projected as something a friend could copy.
            const verified=!collision&&entry.state==='running'&&typeof pub.joinAddress==='string'&&pub.joinAddress
              ?{address:pub.joinAddress,reachability:'verified',source:'playit',targetServerId:entry.id} as const:null;
            const reserved=!verified&&!collision&&typeof pub.reservedAddress==='string'&&pub.reservedAddress?pub.reservedAddress:null;
            return {publicJoinAddress:verified,publicReservedAddress:reserved};
          };
          return {...state,appNotice,incomingHandoff:incomingHandoff.status(),version:app.getVersion(),servers:state.servers.map(entry=>({...entry,...publicJoin(entry)})),
            onboarding:{...state.onboarding,checks,completed:checks.ready==='complete'}};
        }
        case 'alwaysOnStatus':return (await helperForSelected()).status();
        case 'alwaysOnEnable':{
          const host=await helperForSelected();

          return host.enable(p.name,(await backend.getState()).servers.map(server=>server.playerPort));
        }
        case 'alwaysOnDisable':

          return (await helperForSelected()).disable();
        case 'alwaysOnNewCode':return (await helperForSelected()).newCode();
        case 'publicAddressStatus':case 'publicAddressEnable':case 'publicAddressDisable':case 'publicAddressOpenApproval':{
          const selectionEpoch=publicSelectionEpoch;
          const state=await backend.getState();
          const selected=state.servers.find(server=>server.id===p.id);
          if(!selected||state.server?.id!==p.id)throw new Error('The selected server changed. Refresh before continuing.');
          const helperPorts=await helpers.runningGamePorts();
          const latest=await backend.getState();
          if(selectionEpoch!==publicSelectionEpoch||latest.server?.id!==p.id||latest.server?.playerPort!==selected.playerPort)throw new Error('The selected server changed. Refresh before continuing.');
          const collision=latest.servers.some(other=>other.id!==selected.id&&other.playerPort===selected.playerPort)||helperPorts.includes(selected.playerPort);
          if(collision&&method!=='publicAddressDisable'){
            const detail='This Minecraft port conflicts with another server or the helper gateway. Set a distinct server-port in Server settings first.';
            if(method==='publicAddressEnable')throw new Error(detail);
            return {state:'error',address:null,approveUrl:null,detail};
          }
          if(method==='publicAddressEnable'){
            let status=await publicAddress.enable(selected,latest.servers);
            // First-use provider approval is inline in this one action: give the background flow a bounded
            // moment to surface its approval URL, open it once, and keep the second button as a fallback.
            for(let attempt=0;attempt<10&&!status.approveUrl&&['starting','downloading'].includes(status.state);attempt++){
              await new Promise(resolve=>setTimeout(resolve,250));
              status=await publicAddress.refresh(selected,false);
            }
            if(status.state==='approve'&&status.approveUrl&&/^https:\/\/playit\.gg\/claim\/[a-f0-9]{10}$/.test(status.approveUrl))await shell.openExternal(status.approveUrl);
            return status;
          }
          if(method==='publicAddressDisable')return publicAddress.disable(selected);
          if(method==='publicAddressStatus'){const status=await publicAddress.refresh(selected);syncHolderEndpoint(latest,helperPorts);return status;}
          const status=publicAddress.status(selected),url=status.approveUrl;
          if(url&&/^https:\/\/playit\.gg\/claim\/[a-f0-9]{10}$/.test(url))await shell.openExternal(url);
          return status;
        }
        case 'pairAlwaysOn':

          return backend.pairAlwaysOn(p as {code:string;name:string});
        case 'searchSetupMods':return backend.searchSetupMods(p as {query:string;gameVersion:string;offset:number;sort?:ModSort});
        case 'setupFabricMods':return backend.setupFabricMods(p as {projectIds:string[]});
        case 'listServerVersions':return new ServerSetupClient().listVersions();
        case 'discoverJava':return discoverJava(path.join(root,'runtimes'));
        case 'pickJava':{
          const selected=await dialog.showOpenDialog(window,{title:'Choose an installed Java executable (java or java.exe)',properties:['openFile'],...(process.platform==='win32'?{filters:[{name:'Java executable',extensions:['exe']}]}:{})});
          if(selected.canceled||!selected.filePaths[0])return null;

          return probeJava(selected.filePaths[0]);
        }
        case 'createServer':{
          const input={...p} as CreateServerInput;
          if(input.eulaAccepted!==true)throw new Error('Explicit Minecraft EULA acceptance is required before creating a server');
          const location=await dialog.showOpenDialog(window,{title:'Choose where to download server files (a separate managed working copy is kept by Seed Hosting)',buttonLabel:'Download here',properties:['openDirectory','createDirectory']});
          if(location.canceled||location.filePaths.length!==1)return null;
          const created=await backend.createServer(input,location.filePaths[0]);
          try {
            const state=await backend.getState(),server=state.servers.find(entry=>entry.id===created.serverId);
            if(!server)throw new Error("The created server is no longer in the library");
            await publicAddress.enable(server,state.servers);
          }
          catch { appNotice='Your server was created. Its public address setup needs attention — open the server’s Join address controls to retry or review provider approval/limits.'; }
          return created;
        }
        case 'configureSimpleProfile':
          // The labelled Save action is explicit local consent; core validation remains unchanged.
          return backend.configureSimpleProfile(p as unknown as SimpleProfileInput);
        case 'saveGameGateway':return backend.saveGameGateway(p as {enabled:boolean;localPort:number});
        case 'checkGameGateway':return backend.checkGameGateway();
        case 'openSetupLink':{
          const url=setupLinks[p.page];
          if(!url)throw new Error('Invalid setup link');
          return shell.openExternal(url);
        }
        case 'saveOnboarding':{
          const {serverId,...progress}=p;
          return backend.saveOnboarding(progress,await (await helperForSelected()).status(),serverId as string|null|undefined);
        }
        case 'listSnapshots':return backend.listSnapshots();
        case 'restoreSnapshot':

          return backend.restoreSnapshot(p.snapshotId);
        case 'importServer':{
          const selected=await dialog.showOpenDialog(window,{title:'Choose a stopped Minecraft Java server — never import a running world',buttonLabel:'Import stopped server',properties:['openDirectory']});
          if(selected.canceled||!selected.filePaths[0])return null;

          return backend.importExisting(selected.filePaths[0],true);
        }
        case 'saveProfile':return backend.saveProfile(p as {executable:string;args:string[]});
        case 'startServer':{
          let captured:{id:string;dir:string}|null=null;
          const result=await backend.startServerWithApproval(async approval=>{
            // Check the captured server under the backend approval lock, before any hosting ledger mutation.
            const helperPorts=await helpers.runningGamePorts(),minecraftPort=await readServerPort(approval.serverDir);
            if(helperPorts.includes(minecraftPort))throw new Error('Minecraft port '+minecraftPort+' is used by Seed Hosting’s player gateway. Choose a different Minecraft port in Server settings before starting. No server process was launched and ownership was not changed.');
            // Bind the exact world id to the approved server directory now, under the approval gate. A later
            // selection change is never resolved as the started world, and its cached verification is stale.
            const snapshot=await backend.getState(),selected=snapshot.server;
            if(selected&&selected.serverDir===approval.serverDir){captured={id:selected.id,dir:approval.serverDir};publicAddress.invalidateVerification(selected.id);}
            // The explicit Start server action approves the captured local launch profile.
            // Receiving a world never calls this handler or starts code automatically.
            // Backend still revalidates the captured profile, snapshots and ownership before spawn.
            return true;
          });
          if(captured&&process.env.SEEDHOST_TEST_LOOPBACK!=='1'){
            const world=captured as {id:string;dir:string};
            try{
              const latest=await backend.getState();
              const entry=latest.servers.find(server=>server.id===world.id)??(latest.server?.id===world.id?latest.server:null);
              if(!entry)throw new Error('The started world is no longer in the library; its public address was not changed.');
              if(latest.server?.id===world.id&&latest.server.serverDir!==world.dir)throw new Error('The selected server changed while starting; its public address was not changed.');
              await publicAddress.enable(entry,latest.servers);
            }catch(error){
              appNotice='Server started, but its public address could not be set up: '+String((error as Error)?.message??error).replace(/[a-fA-F0-9]{32,}/g,'[redacted]').slice(0,300);
            }
          }
          void publishHolderEndpointNow();
          return result;
        }
        case 'stopServer':{
          const before=await backend.getState(),world=before.server;
          const result=await backend.stopServer();
          // Stop is the lifecycle boundary: cached verification for the captured world is stale now, and
          // the renderer drops the copy action at once instead of waiting for the provider poll.
          if(world)publicAddress.invalidateVerification(world.id);
          publishHolderEndpoint(null);
          return result;
        }
        case 'createSnapshot':return backend.createSnapshot();
        case 'sendCommand':return backend.sendCommand(p.command);
        case 'saveSettings':return backend.saveSettings(p as any);
        case 'addPeer':return backend.addPeer(p as any);
        case 'startPeerListener':return backend.startPeerListener();
        case 'sendSnapshot':return backend.sendSnapshot(p.fingerprint);
        case 'handoff':return backend.handoff(p.fingerprint);
        case 'searchMods':return backend.searchMods(p as {query:string;offset:number;sort?:ModSort});
        case 'saveModTarget':return backend.saveModTarget(p as any);
        case 'installMod':

          return backend.installMod(p as any);
        case 'openModPage':return shell.openExternal('https://modrinth.com/mod/'+encodeURIComponent(p.slug));
        case 'createInvite':

          return backend.createInvite();
        case 'listFriends':return backend.listFriends();
        case 'previewInvite': {
          return previewInvite(p.code);
        }
        case 'joinWithInvite': {
          decodeInvite(p.code); // Retain privileged validation even without a second popup.

          return backend.joinWithInvite(p as {code:string;name:string});
        }
        case 'addMods':{
          // Paths come only from the native picker, never from the renderer.
          const client=p.kind==='client';
          const picked=await dialog.showOpenDialog(window,{title:client?'Add client-only mods (for players)':'Add server mods',buttonLabel:'Add mods',filters:[{name:'Minecraft mods',extensions:['jar']}],properties:['openFile','multiSelections']});
          if(picked.canceled||!picked.filePaths.length)return [];
          return backend.addMods(p.kind,picked.filePaths);
        }
        case 'removeMod':return backend.removeMod(p.kind,p.name);
        case 'exportClientPack':{
          const state=await backend.getState();
          const saved=await dialog.showSaveDialog(window,{title:'Save the client mod pack',buttonLabel:'Save pack',defaultPath:path.join(app.getPath('downloads'),(state.server?.name||'server').replace(/[^\w .-]+/g,'_')+' client mods.zip'),filters:[{name:'Zip archive',extensions:['zip']}]});
          if(saved.canceled||!saved.filePath)return;
          const destination=/\.zip$/i.test(saved.filePath)?saved.filePath:saved.filePath+'.zip';
          return backend.exportClientPack(destination);
        }
        case 'saveRelay':return backend.saveRelay(p.relay);
        case 'checkRelay':return backend.checkRelay();
        case 'parkAtRelay':return backend.parkAtRelay();
        case 'claimFromRelay':return backend.claimFromRelay();
        case 'cleanUp':return backend.cleanUp();
        case 'getWindowState':return windowState();
        case 'updateStatus':return updater.status();
        case 'updateCheck':return updater.check();
        case 'updateDownload':return updater.download();
        case 'updateInstall':{
          if(!app.isPackaged)throw new Error('Updates install only in the packaged app');
          if(process.platform!=='win32')throw new Error('Automatic install is available on Windows only');
          const staged=updater.status().staged;
          if(!staged)throw new Error('No verified update is staged yet; download an update first');
          const state=await backend.getState();
          if(state.busy||state.server?.state==='running'||state.server?.state==='starting')throw new Error('Stop the server before installing an update');

          await updater.install();
          void quit();
          return updater.status();
        }
        // Wayland tiling compositors may ignore native minimize requests; the tray keeps a hidden window recoverable.
        case 'windowMinimize':if(process.platform==='linux' && process.env.WAYLAND_DISPLAY)window.hide();else window.minimize();return windowState();
        case 'windowToggleFullscreen':window.setFullScreen(!window.isFullScreen());return windowState();
        case 'windowClose':window.close();return;
        case 'quitApp':void quit();return;
        // Recovery consent is scoped to the captured world and this selection epoch. The check runs here,
        // in the privileged path, before the core method sees any recovery request.
        case 'recoverStopped':{
          const target=typeof p.id==='string'?p.id:null,epoch=selectionEpochNow();
          const confirmRecoveryContext=async():Promise<void>=>{
            const current=await backend.getState();
            if(!current.server||epoch!==selectionEpochNow())throw new Error('The selected server changed. Refresh before recovering.');
            if(target!==null){if(current.server.id!==target)throw new Error('The selected server changed. Refresh before recovering.');}
            // A group-bound world is recovered only for its exact captured id: the legacy id-less path must
            // never authorize custody recovery of a hosting-group world.
            else if(Boolean((current.server as unknown as {group?:unknown}).group))throw new Error('This hosting group world requires its captured world id. Refresh before recovering.');
          };
          await confirmRecoveryContext();
          await confirmRecoveryContext();
          return backend.recoverStopped(p.confirmed as boolean);
        }
        // Read-only, authenticated recovery evidence for the active group world; never mutates custody.
        case 'groupRecoveryStatus':return backend.groupRecoveryStatus();
        default:throw new Error('This operation is not available in this build');
      }
    });
    tray=new Tray(image.resize({width:32,height:32,quality:'best'}));tray.setToolTip('Seed Hosting — Minecraft servers you share with friends');
    tray.setContextMenu(Menu.buildFromTemplate([{label:'Open Seed Hosting',click:show},{type:'separator'},{label:'Quit safely',click:()=>{void quit();}}]));
    tray.on('double-click',show);
    Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(app.isPackaged,{show,quit:()=>{void quit();}})));
    if(app.isPackaged)window.webContents.on('devtools-opened',()=>window.webContents.closeDevTools());
    await window.loadFile(html);
    // Quietly check for updates shortly after launch; the Settings card shows the result.
    setTimeout(()=>{void updater.check().catch(()=>undefined);},4000);
  }).catch(error=>{console.error('Seed Hosting startup failed',error);quitAllowed=true;app.quit();});
}
