import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {RelayNode} from '../dist/src/core/relay.js';
import {SeedHostApplication} from '../dist/src/core/application.js';
import {createIdentity} from '../dist/src/core/peer-transport.js';
import * as client from '../dist/src/core/relay-client.js';
import {connectPeer,writeFrame,readFrame} from '../dist/src/core/peer-transport.js';
import {readRelayConfig} from '../dist/src/core/relay-friends-store.js';

async function raw(identity,peer,request) {
 const socket=await connectPeer(identity,peer.fingerprint,peer.host,peer.port);
 try {await writeFrame(socket,request);return await readFrame(socket);} finally {socket.destroy();}
}

async function fixture(t, memberOptions={}) {
 const root=await mkdtemp(path.join(process.env.TMPDIR,'seed-metadata-'));
 const relay=new RelayNode(path.join(root,'relay'),await createIdentity(),{name:'OwnerUsername hosting group',log(){}});
 const owner=new SeedHostApplication(path.join(root,'owner'),await createIdentity());
 const member=new SeedHostApplication(path.join(root,'member'),await createIdentity(),memberOptions);
 t.after(async()=>{await member.close();await owner.close();await relay.close();await rm(root,{recursive:true,force:true});});
 await relay.open();await relay.listen();await owner.open();await member.open();
 await relay.trust('OwnerUsername',owner.identity.fingerprint);await relay.setOwner(owner.identity.fingerprint);
 const peer={fingerprint:relay.identity.fingerprint,...relay.endpoint};
 await owner.addPeer({name:'local helper alias',...peer});
 const source=path.join(root,'The Owner World');await mkdir(source);await writeFile(path.join(source,'world.bin'),'owner world');await writeFile(path.join(source,'server.properties'),'server-port=0\n');await writeFile(path.join(source,'eula.txt'),'eula=true\n');
 await owner.importExisting(source,true);await owner.saveRelay({fingerprint:peer.fingerprint,parkOnStop:false});
 return {root,relay,owner,member,peer};
}

test('download uses the appointed owner server name, preserving unrelated worlds and local launch trust',async t=>{
 const {root,relay,owner,member,peer}=await fixture(t);
 const source=path.join(root,'Unrelated World');await mkdir(source);await writeFile(path.join(source,'world.bin'),'unrelated');await member.importExisting(source,true);
 const before=await member.getState();
 await member.joinHostingGroup({code:(await owner.createInvite()).code,name:'RecipientUsername',serverId:null});
 await owner.parkAtRelay();await member.claimPendingGroup(peer.fingerprint);await relay.settled();
 const after=await member.getState();assert.equal(after.server.name,(await owner.getState()).server.name);
 const untouched=after.servers.find(s=>s.id===before.server.id);assert.equal(untouched.name,before.server.name);assert.equal(await readFile(path.join(before.server.serverDir,'world.bin'),'utf8'),'unrelated');
 assert.equal(after.server.profile.executable,'');assert.deepEqual(after.server.profile.args,[]);
});
test('legacy unknown name remains explicit until canonical metadata reaches the exact bound group world',async t=>{
 const {root,relay,owner,member,peer}=await fixture(t);
 await member.joinHostingGroup({code:(await owner.createInvite()).code,name:'Member',serverId:null});
 await owner.parkAtRelay();await relay.settled();
 const configFile=path.join(relay.root,'relay.json');const config=JSON.parse(await readFile(configFile,'utf8'));delete config.serverMetadata;await writeFile(configFile,JSON.stringify(config));
 await member.claimPendingGroup(peer.fingerprint);await relay.settled();
 assert.equal((await member.getState()).server.name,'Shared server (name unavailable)');
 const id=(await member.getState()).server.id;
 await client.relaySetServerName(owner.identity,peer,'The Owner World');
 await member.parkAtRelay();await relay.settled();await member.claimFromRelay();await relay.settled();
 assert.equal((await member.getState()).server.id,id);assert.equal((await member.getState()).server.name,'The Owner World');
});
test('new member Start publishes the owner title and later hosting aliases cannot rename it',async t=>{
 const {root,relay,owner,member,peer}=await fixture(t,{resolveGroupLaunchProfile:async()=>({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs'),'--lifetime-ms=30000']})});
 relay.publishStoppedInitial=(group,appointed)=>owner.publishStoppedInitialGroup(group,appointed);
 await member.joinHostingGroup({code:(await owner.createInvite()).code,name:'MemberUsername',serverId:null,parkOnStop:false});
 await member.startGroup(peer.fingerprint,true);
 assert.equal((await member.getState()).server.name,'The Owner World');
 await member.stopServer();await relay.settled();
 const newcomer=new SeedHostApplication(path.join(root,'newcomer'),await createIdentity());
 try {await newcomer.open();await newcomer.joinHostingGroup({code:(await owner.createInvite()).code,name:'OtherUsername',serverId:null});await newcomer.claimPendingGroup(peer.fingerprint);await relay.settled();assert.equal((await newcomer.getState()).server.name,'The Owner World');}
 finally {await newcomer.close();}
 const saved=JSON.parse(await readFile(path.join(relay.root,'relay.json'),'utf8'));assert.deepEqual(saved.serverMetadata,{owner:owner.identity.fingerprint,name:'The Owner World'});
 await relay.close();const restarted=new RelayNode(relay.root,relay.identity,{log(){}});await restarted.open();await restarted.listen();
 try {assert.deepEqual((await client.relayFriends(owner.identity,{fingerprint:peer.fingerprint,...restarted.endpoint})).serverMetadata,saved.serverMetadata);}finally{await restarted.close();}
});

test('real pinned TLS rejects nonowner, untrusted and malformed metadata without altering the durable title',async t=>{
 const {relay,owner,member,peer}=await fixture(t);
 await member.joinHostingGroup({code:(await owner.createInvite()).code,name:'Member',serverId:null});await owner.parkAtRelay();await relay.settled();
 const before=await readFile(path.join(relay.root,'relay.json'),'utf8');
 await assert.rejects(client.relaySetServerName(member.identity,peer,'Member local alias'),/owner/i);
 const outsider=await createIdentity();await assert.rejects(client.relaySetServerName(outsider,peer,'Intruder'),/untrusted|denied|refused/i);
 await assert.rejects(client.relayFriends(owner.identity,{...peer,fingerprint:outsider.fingerprint}),/identity|pin|certificate|fingerprint/i);
 for(const metadata of [{owner:member.identity.fingerprint,name:'Wrong owner'},{owner:owner.identity.fingerprint,name:' '},{owner:owner.identity.fingerprint,name:'x'.repeat(101)},{owner:owner.identity.fingerprint,name:'bad\nname'},{owner:owner.identity.fingerprint,name:'World',playitKey:'not allowed'},{owner:owner.identity.fingerprint,name:'World',executable:'not allowed'}]) {
   const reply=await raw(owner.identity,peer,{...client.relayRequest('server-metadata'),metadata});assert.equal(reply.type,'error');
 }
 assert.equal(await readFile(path.join(relay.root,'relay.json'),'utf8'),before);
 const handle=relay.handle.bind(relay);let corrupt=true;
 relay.handle=(socket,source)=>{const write=socket.write.bind(socket);socket.write=(packet,...args)=>{if(corrupt&&Buffer.isBuffer(packet)&&packet.length>4){let body;try{body=JSON.parse(packet.subarray(4));}catch{}if(body?.type==='relay-friends'){body.serverMetadata={owner:member.identity.fingerprint,name:'Spoofed'};const bytes=Buffer.from(JSON.stringify(body)),header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);return write(Buffer.concat([header,bytes]),...args);}}return write(packet,...args);};return handle(socket,source);};
 await assert.rejects(client.relayFriends(member.identity,peer),/metadata/i);
 const state=await member.getState();await assert.rejects(member.claimPendingGroup(peer.fingerprint),/metadata/i);assert.deepEqual((await member.getState()).servers,state.servers);assert.deepEqual((await member.getState()).pendingGroups,state.pendingGroups);
 corrupt=false;await member.claimPendingGroup(peer.fingerprint);await relay.settled();assert.equal((await member.getState()).server.name,'The Owner World');
});

test('local owner untrust permits restart and a trusted replacement canonical title without resurrecting the former owner',async t=>{
 const {relay,owner,member,peer}=await fixture(t);
 const configFile=path.join(relay.root,'relay.json');
 await relay.trust('ReplacementOwner',member.identity.fingerprint);
 await client.relaySetServerName(owner.identity,peer,'The Owner World');
 assert.deepEqual((await readRelayConfig(relay.root,relay.name)).serverMetadata,{owner:owner.identity.fingerprint,name:'The Owner World'});

 await relay.untrust(owner.identity.fingerprint);
 await relay.reload();
 const removed=await readRelayConfig(relay.root,relay.name);
 assert.equal(removed.owner,undefined);assert.equal(removed.serverMetadata,undefined);
 assert.deepEqual(removed.trusted,[{name:'ReplacementOwner',fingerprint:member.identity.fingerprint}]);
 assert.equal(relay.owner,undefined);

 await relay.close();
 const restarted=new RelayNode(relay.root,relay.identity,{log(){}});
 try {
  await restarted.open();await restarted.listen();
  const restartedPeer={fingerprint:peer.fingerprint,...restarted.endpoint};
  assert.equal(restarted.owner,undefined);
  const unappointed=await client.relayFriends(member.identity,restartedPeer);
  assert.equal(unappointed.owner,null);assert.equal(unappointed.serverMetadata,undefined);
  await assert.rejects(client.relaySetServerName(member.identity,restartedPeer,'Premature title'),/owner/i);
  await restarted.setOwner(member.identity.fingerprint);
  await client.relaySetServerName(member.identity,restartedPeer,'Replacement Canonical World');
  await restarted.reload();
  const saved=await readRelayConfig(relay.root,restarted.name);
  assert.equal(saved.owner,member.identity.fingerprint);
  assert.deepEqual(saved.serverMetadata,{owner:member.identity.fingerprint,name:'Replacement Canonical World'});
  assert.deepEqual(saved.trusted,removed.trusted);
  const friends=await client.relayFriends(member.identity,restartedPeer);
  assert.equal(friends.canManage,true);assert.equal(friends.owner,member.identity.fingerprint);
  assert.deepEqual(friends.serverMetadata,saved.serverMetadata);
  assert.equal(friends.members.some(m=>m.fingerprint===owner.identity.fingerprint),false);
  const before=await readFile(configFile,'utf8');
  await assert.rejects(client.relayFriends(owner.identity,restartedPeer),/untrusted|denied|refused/i);
  await assert.rejects(client.relaySetServerName(owner.identity,restartedPeer,'Former owner title'),/untrusted|denied|refused/i);
  assert.equal(await readFile(configFile,'utf8'),before);
 } finally {await restarted.close();}
});

test('local non-owner untrust preserves valid canonical owner metadata',async t=>{
 const {relay,owner,member,peer}=await fixture(t);
 await relay.trust('Member',member.identity.fingerprint);
 await client.relaySetServerName(owner.identity,peer,'The Owner World');
 const before=await readRelayConfig(relay.root,relay.name);
 await relay.untrust(member.identity.fingerprint);
 await relay.reload();
 const after=await readRelayConfig(relay.root,relay.name);
 assert.equal(after.owner,owner.identity.fingerprint);
 assert.deepEqual(after.serverMetadata,before.serverMetadata);
 assert.deepEqual(after.trusted,[{name:'OwnerUsername',fingerprint:owner.identity.fingerprint}]);
 assert.deepEqual((await client.relayFriends(owner.identity,peer)).serverMetadata,before.serverMetadata);
});
