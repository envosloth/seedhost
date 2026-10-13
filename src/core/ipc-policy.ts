import { DASHBOARD_METHODS, validateDashboardCall } from './server-dashboard-policy.js';
import { validAdvertise } from './relay-friends-store.js';
import { validateSettings } from './settings.js';
import { isValidEndpointHost } from './endpoints.js';
import { validTimeout, isServerId, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } from './saved-state.js';
import { isModKind, isModName } from './mods.js';
import { isGameVersion, isModLoader, isProjectKey, validateModSort } from './modrinth.js';
import { accountPassword, accountUsername } from './accounts.js';
import { validateOnboarding } from './onboarding.js';
import { validateSimpleProfileInput } from './java-arguments.js';
const NO_PAYLOAD=new Set(['listHostingGroups','accountFriends','accountFriendRequests','accountStartGroup','accountStatus','accountRequests','accountLogout','playitStatus','playitImport','playitCheck','playitCreate','playitDisconnect','playitSetup','getState','importServer','createSnapshot','startServer','stopServer','startPeerListener','cleanUp','parkAtRelay','claimFromRelay','checkRelay','exportClientPack','createInvite','listFriends','listSnapshots','listServerVersions','discoverJava','pickJava','checkGameGateway','alwaysOnStatus','alwaysOnDisable','alwaysOnNewCode','groupRecoveryStatus',
  // Window chrome acts only on the trusted app window.
  'getWindowState','windowMinimize','windowToggleFullscreen','windowClose','quitApp','updateStatus','updateCheck','updateDownload','updateInstall']);
const METHODS=new Set(['respondIncomingHandoff','openServerFolder','getHostingControlRoute','setHostingControlRoute','claimPendingGroup','startGroup',...DASHBOARD_METHODS,...NO_PAYLOAD,'leaveGroup','disbandGroup','publicAddressStatus','publicAddressEnable','publicAddressDisable','publicAddressOpenApproval','accountUpdateProfile','accountRegister','accountLogin','accountSend','accountAccept','accountDecline','accountFriendSend','accountFriendAccept','accountFriendDecline','accountFriendRemove','removeFriend','saveProfile','sendCommand','saveSettings','addPeer','sendSnapshot','handoff','recoverStopped','groupRecoveryStatus','saveRelay','addMods','removeMod','searchMods','installMod','saveModTarget','openModPage','previewInvite','joinWithInvite','saveOnboarding','restoreSnapshot','createServer','configureSimpleProfile','saveGameGateway','openSetupLink','selectServer','deleteServer','alwaysOnEnable','pairAlwaysOn','setupFabricMods','searchSetupMods']);
function boundedString(v:unknown,max:number):v is string{return typeof v==='string'&&v.length<=max&&!v.includes('\0');}
function fingerprint(v:unknown):v is string{return typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);}
export interface TrustedIpcContext {senderId:number;expectedSenderId:number;isMainFrame:boolean}
export function validateCall(method:unknown,payload:unknown,senderUrl:string,expectedUrl:string,context?:TrustedIpcContext):Record<string,any>{
  if(senderUrl!==expectedUrl||!context||!Number.isSafeInteger(context.senderId)||context.senderId<1||context.senderId!==context.expectedSenderId||context.isMainFrame!==true)throw new Error('Untrusted IPC sender');
  if(typeof method!=='string'||!METHODS.has(method))throw new Error('Unknown IPC method');
  if(NO_PAYLOAD.has(method)){
    if(payload!==undefined)throw new Error('Invalid payload: this operation accepts no arguments');
    return {};
  }
  if(method==='saveRelay'){
    if(payload===null)return {relay:null};
    const r=payload as Record<string,unknown>;
    if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).sort().join(',')!=='fingerprint,parkOnStop'||!fingerprint(r.fingerprint)||typeof r.parkOnStop!=='boolean')throw new Error('Invalid relay configuration');
    return {relay:{fingerprint:r.fingerprint,parkOnStop:r.parkOnStop}};
  }
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Invalid payload');
  const p=payload as Record<string,unknown>;
  if(DASHBOARD_METHODS.has(method))return validateDashboardCall(method,p);
  switch(method){
    case 'respondIncomingHandoff':
      if(Object.keys(p).sort().join(',')!=='accepted,id'||typeof p.id!=='string'||!/^[a-f0-9-]{36}$/.test(p.id)||typeof p.accepted!=='boolean')throw new Error('Invalid handoff response');
      return {id:p.id,accepted:p.accepted};
    case 'openServerFolder':
      if(Object.keys(p).join(',')!=='id'||!isServerId(p.id))throw new Error('Invalid server id');
      return {id:p.id};
    case 'accountRegister':case 'accountLogin':
      if(Object.keys(p).sort().join(',')!=='password,username')throw new Error('Invalid account request');
      return {username:accountUsername(p.username),password:accountPassword(p.password)};
    case 'accountUpdateProfile':
      if(Object.keys(p).sort().join(',')!==('newPassword' in p?'currentPassword,newPassword,username':'currentPassword,username'))throw new Error('Invalid account profile request');
      return {username:accountUsername(p.username),currentPassword:accountPassword(p.currentPassword),...('newPassword' in p?{newPassword:accountPassword(p.newPassword)}:{})};
    case 'accountSend':
      if(Object.keys(p).sort().join(',')!=='fingerprint,serverId,username'||!fingerprint(p.fingerprint)||!(p.serverId===null||isServerId(p.serverId)))throw new Error('Invalid hosting group');
      return {username:accountUsername(p.username),fingerprint:p.fingerprint,serverId:p.serverId};
    case 'accountAccept':case 'accountDecline':
      if(Object.keys(p).join(',')!=='id'||typeof p.id!=='string'||!/^[a-f0-9-]{36}$/.test(p.id))throw new Error('Invalid friend request');
      return {id:p.id};
    case 'accountFriendSend':case 'accountFriendRemove':
      if(Object.keys(p).join(',')!=='username')throw new Error('Invalid username');
      return {username:accountUsername(p.username)};
    case 'accountFriendAccept':case 'accountFriendDecline':
      if(Object.keys(p).join(',')!=='id'||typeof p.id!=='string'||!/^[a-f0-9-]{36}$/.test(p.id))throw new Error('Invalid friend request');
      return {id:p.id};
    case 'leaveGroup':
      if(Object.keys(p).sort().join(',')!=='fingerprint,id'||(p.id!==null&&!isServerId(p.id))||!fingerprint(p.fingerprint))throw new Error('Invalid server group');
      return {id:p.id,fingerprint:p.fingerprint};
    case 'disbandGroup':
      if(Object.keys(p).sort().join(',')!=='fingerprint,id'||!isServerId(p.id)||!fingerprint(p.fingerprint))throw new Error('Invalid server group');
      return {id:p.id,fingerprint:p.fingerprint};
    case 'setHostingControlRoute':
      if(Object.keys(p).sort().join(',')!=='fingerprint,host,port'||!fingerprint(p.fingerprint)||!validAdvertise({host:p.host,port:p.port}))throw new Error('Invalid advertised control route');
      return {fingerprint:p.fingerprint,host:p.host,port:p.port};
    case 'getHostingControlRoute':
    case 'startGroup':
    case 'claimPendingGroup':
    case 'removeFriend':
      if(Object.keys(p).join(',')!=='fingerprint'||!fingerprint(p.fingerprint))throw new Error('Invalid friend');
      return {fingerprint:p.fingerprint};
    case 'createServer':
      if(Object.keys(p).sort().join(',')!=='eulaAccepted,gameVersion,javaExecutable,loader,memoryMiB,name'||
        !boundedString(p.name,80)||!p.name.trim()||/[\x00-\x1f]/.test(p.name)||
        (p.loader!=='vanilla'&&p.loader!=='fabric')||!isGameVersion(p.gameVersion)||
        // Empty Java = automatic (found or installed by the main process).
        !boundedString(p.javaExecutable,4096)||(p.javaExecutable!==''&&!p.javaExecutable.trim())||/[\r\n]/.test(p.javaExecutable)||
        !Number.isInteger(p.memoryMiB)||Number(p.memoryMiB)<512||Number(p.memoryMiB)>65536||typeof p.eulaAccepted!=='boolean')throw new Error('Invalid new server configuration');
      return {...p};
    case 'configureSimpleProfile':
      return {...validateSimpleProfileInput(p)};
    case 'saveGameGateway':
      if(Object.keys(p).sort().join(',')!=='enabled,localPort'||typeof p.enabled!=='boolean'||!Number.isInteger(p.localPort)||Number(p.localPort)<1||Number(p.localPort)>65535)throw new Error('Invalid game gateway configuration');
      return {enabled:p.enabled,localPort:p.localPort};
    case 'openSetupLink':
      if(Object.keys(p).join(',')!=='page'||!['eula','java','fabric','relay'].includes(p.page as string))throw new Error('Invalid setup link');
      return {page:p.page};
    case 'alwaysOnEnable':
      if(Object.keys(p).join(',')!=='name'||!boundedString(p.name,60)||!p.name.trim()||/[\x00-\x1f\x7f]/.test(p.name))throw new Error('Invalid always-on PC name');
      return {name:p.name.trim()};
    case 'pairAlwaysOn':
      if(Object.keys(p).sort().join(',')!=='code,name'||!boundedString(p.code,64)||!/^[0-9A-Za-z\s-]{12,40}$/.test(p.code)||!boundedString(p.name,60)||!p.name.trim()||/[\x00-\x1f\x7f]/.test(p.name))throw new Error('Invalid pairing code or name');
      return {code:p.code,name:p.name};
    case 'setupFabricMods':
      if(Object.keys(p).join(',')!=='projectIds'||!Array.isArray(p.projectIds)||p.projectIds.length>50||!p.projectIds.every(isProjectKey)||new Set(p.projectIds).size!==p.projectIds.length)throw new Error('Invalid mod selection');
      return {projectIds:[...(p.projectIds as string[])]};
    case 'searchSetupMods':
      if(Object.keys(p).sort().join(',')!==('sort' in p?'gameVersion,offset,query,sort':'gameVersion,offset,query')||!boundedString(p.query,200)||!isGameVersion(p.gameVersion)||!Number.isSafeInteger(p.offset)||Number(p.offset)<0||Number(p.offset)>10000)throw new Error('Invalid mod search');
      return {query:p.query,gameVersion:p.gameVersion,offset:p.offset,...('sort' in p?{sort:validateModSort(p.sort)}:{})};
    case 'publicAddressStatus':case 'publicAddressEnable':case 'publicAddressDisable':case 'publicAddressOpenApproval':
    case 'selectServer':case 'deleteServer':
      if(Object.keys(p).join(',')!=='id'||!isServerId(p.id))throw new Error('Invalid server id');
      return {id:p.id};
    case 'saveOnboarding': {
      const scoped = Object.hasOwn(p, 'serverId');
      const {serverId, ...input} = p;
      if(scoped && serverId !== null && !isServerId(serverId))throw new Error('Invalid setup server id');
      const progress = validateOnboarding(input);
      return scoped ? {...progress, serverId} : progress;
    }
    case 'restoreSnapshot':
      if(Object.keys(p).join(',')!=='snapshotId'||!fingerprint(p.snapshotId))throw new Error('Invalid snapshot revision');
      return {snapshotId:p.snapshotId};
    case 'saveSettings':return validateSettings(p) as unknown as Record<string,any>;
    case 'saveProfile':
      if(!boundedString(p.executable,4096)||!p.executable.trim())throw new Error('Invalid executable');
      if(!Array.isArray(p.args)||p.args.length>100||p.args.some(v=>!boundedString(v,4096)))throw new Error('Launch arguments must be a bounded string array');
      for(const key of ['startTimeoutSeconds','stopTimeoutSeconds'] as const){
        if(key in p&&!validTimeout(p[key]))throw new Error(`Launch timeouts must be whole seconds from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}`);
      }
      return {executable:p.executable,args:[...p.args],...('startTimeoutSeconds' in p?{startTimeoutSeconds:p.startTimeoutSeconds}:{}),...('stopTimeoutSeconds' in p?{stopTimeoutSeconds:p.stopTimeoutSeconds}:{})};
    case 'sendCommand':
      if(!boundedString(p.command,1024)||/[\r\n]/.test(p.command)||!p.command.trim())throw new Error('Invalid console command');return {command:p.command};
    case 'addPeer':
      if(!boundedString(p.name,100)||!p.name.trim()||!fingerprint(p.fingerprint)||!isValidEndpointHost(p.host)||!Number.isInteger(p.port)||Number(p.port)<1||Number(p.port)>65535)throw new Error('Invalid peer identity or endpoint (ASCII DNS or IPv4 only; IPv6 is not supported)');
      return {name:p.name,fingerprint:p.fingerprint,host:p.host,port:p.port};
    case 'sendSnapshot':case 'handoff':
      if(!fingerprint(p.fingerprint))throw new Error('Invalid peer fingerprint');return {fingerprint:p.fingerprint};
    case 'searchMods':
      if(Object.keys(p).sort().join(',')!==('sort' in p?'offset,query,sort':'offset,query')||!boundedString(p.query,200)||!Number.isSafeInteger(p.offset)||Number(p.offset)<0||Number(p.offset)>10000)throw new Error('Invalid mod query or offset');
      return {query:p.query,offset:p.offset,...('sort' in p?{sort:validateModSort(p.sort)}:{})};
    case 'installMod':
      if(!isProjectKey(p.projectId)||Object.keys(p).some(k=>!['projectId','targets'].includes(k)))throw new Error('Invalid mod project');
      if('targets' in p&&(!Array.isArray(p.targets)||p.targets.length<1||p.targets.length>2||!p.targets.every(isModKind)||new Set(p.targets).size!==p.targets.length))throw new Error('Invalid mod targets');
      return {projectId:p.projectId,...('targets' in p?{targets:[...(p.targets as string[])]}:{})};
    case 'saveModTarget':
      if(Object.keys(p).sort().join(',')!=='gameVersion,loader'||!isModLoader(p.loader)||!isGameVersion(p.gameVersion))throw new Error('Invalid mod loader or Minecraft version');
      return {loader:p.loader,gameVersion:p.gameVersion};
    case 'openModPage':
      if(Object.keys(p).join(',')!=='slug'||!isProjectKey(p.slug)||p.slug==='..')throw new Error('Invalid mod slug');
      return {slug:p.slug};
    case 'previewInvite': {
      if(Object.keys(p).join(',')!=='code'||!boundedString(p.code,1500)||!p.code.trim())throw new Error('Invalid invite code');
      return {code:p.code};
    }
    case 'joinWithInvite': {
      if(Object.keys(p).sort().join(',')!=='code,name'||!boundedString(p.code,1500)||!p.code.trim()||!boundedString(p.name,60)||!p.name.trim()||/[\r\n]/.test(p.name))throw new Error('Invalid invite code or friend name');
      return {code:p.code,name:p.name};
    }
    case 'addMods':
      if(Object.keys(p).join(',')!=='kind'||!isModKind(p.kind))throw new Error('Invalid mod kind');
      return {kind:p.kind};
    case 'removeMod':
      if(Object.keys(p).sort().join(',')!=='kind,name'||!isModKind(p.kind)||!isModName(p.name))throw new Error('Invalid mod name');
      return {kind:p.kind,name:p.name};
    case 'recoverStopped':{
      if(Object.keys(p).some(key=>key!=='confirmed'&&key!=='id'&&key!=='epoch'))throw new Error('Invalid recovery request');
      if(p.confirmed!==true)throw new Error('Confirm the previous server process is stopped');
      if(p.id!==undefined&&!isServerId(p.id))throw new Error('Invalid recovery server binding');
      if(p.epoch!==undefined&&(typeof p.epoch!=='number'||!Number.isSafeInteger(p.epoch)||(p.epoch as number)<0))throw new Error('Invalid recovery context');
      return {confirmed:true,id:p.id??null,epoch:p.epoch??null};
    }
    default:throw new Error('Unknown IPC method');
  }
}
