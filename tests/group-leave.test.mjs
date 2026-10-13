import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {RelayNode} from '../dist/src/core/relay.js';
import {createIdentity} from '../dist/src/core/peer-transport.js';
import * as client from '../dist/src/core/relay-client.js';
import {OwnershipLedger} from '../dist/src/core/ownership.js';
import {validateCall} from '../dist/src/core/ipc-policy.js';
import {SeedHostApplication} from '../dist/src/core/application.js';
async function setup(t){const root=await mkdtemp(path.join(process.env.TMPDIR,'seed-leave-'));const identity=await createIdentity(),owner=await createIdentity(),member=await createIdentity();const relay=new RelayNode(root,identity,{log:()=>{}});await relay.open();await relay.trust('Owner',owner.fingerprint);await relay.setOwner(owner.fingerprint);await relay.trust('Member',member.fingerprint);await relay.listen();const peer={fingerprint:identity.fingerprint,...relay.endpoint};t.after(async()=>{await relay.close();await rm(root,{recursive:true,force:true});});return {root,identity,owner,member,relay,peer};}
test('leave IPC admits exact group-scoped payloads and exposes the narrow backend operation',async()=>{
 const fingerprint='a'.repeat(64),url='file:///seedhost/index.html',ctx={senderId:1,expectedSenderId:1,isMainFrame:true};
 assert.deepEqual(validateCall('leaveGroup',{id:null,fingerprint},url,url,ctx),{id:null,fingerprint});
 assert.throws(()=>validateCall('leaveGroup',{id:null,fingerprint,force:true},url,url,ctx));
 const preload=await readFile('apps/desktop/preload.cts','utf8'),main=await readFile('apps/desktop/main.ts','utf8');
 assert.match(preload,/'leaveGroup'/);assert.match(main,/case 'leaveGroup':return backend.leaveGroup\(p.id,p.fingerprint\)/);
});
test('pending membership leave fails closed offline and preserves unrelated world, peers and account bytes on verified retry',async t=>{
 const {root,member,relay,peer}=await setup(t);const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'world.dat'),'keep');
 const app=new SeedHostApplication(path.join(root,'profile'),member);await app.open();t.after(()=>app.close());await app.importExisting(source,true);
 const invitation=await relay.createInvite({recipient:member.fingerprint});await app.joinHostingGroup({code:invitation.code,name:'Member',serverId:null});
 const before=await app.getState(),snapshots=await app.listSnapshots();await writeFile(path.join(root,'profile','account.enc'),'account');
 assert.equal(typeof app.leaveGroup,'function');await relay.close();
 await assert.rejects(app.leaveGroup(null,peer.fingerprint),/online|verified|relay/i);
 assert.equal((await app.getState()).pendingGroups.length,1);
 await relay.listen({port:peer.port});await app.leaveGroup(null,peer.fingerprint);
 const after=await app.getState();assert.equal(after.pendingGroups.length,0);assert.deepEqual(after.peers,before.peers);assert.equal(after.server.id,before.server.id);assert.deepEqual(await app.listSnapshots(),snapshots);assert.equal(await readFile(path.join(before.server.serverDir,'world.dat'),'utf8'),'keep');assert.equal(await readFile(path.join(root,'profile','account.enc'),'utf8'),'account');
});
test('lost TLS leave acknowledgement reconciles from authenticated durable readback',async t=>{
 const {member,relay,peer}=await setup(t);const handle=relay.handle.bind(relay);let dropped=false;
 relay.handle=async(socket,source)=>{if(source===member.fingerprint&&!dropped){const write=socket.write.bind(socket);socket.write=(...args)=>{if(relay.config.leftMembers?.includes(source)){dropped=true;socket.destroy();return false;}return write(...args);};}return handle(socket,source);};
 await client.relayLeaveGroup(member,peer);
 assert.equal(dropped,true);assert.equal((await client.relayLeaveStatus(member,peer)).left,true);
});
test('leave refuses the latest holder, pending claim, unresolved hosting admission, and succeeds only after publication',async t=>{
 const {root,identity,member,relay,peer}=await setup(t);
 const snapshot='a'.repeat(64),ledger=new OwnershipLedger(path.join(root,'ownership.sqlite'),identity.fingerprint);
 await ledger.initialize(snapshot);const claim=await ledger.prepareTransfer(member.fingerprint,snapshot);
 await assert.rejects(client.relayLeaveGroup(member,peer),/handoff|publish|stop|pending/i);
 await ledger.confirmTransfer(claim.id,member.fingerprint);
 await assert.rejects(client.relayLeaveGroup(member,peer),/handoff|publish|stop|holder/i);
 const observation={owner:member.fingerprint,generation:claim.generation,snapshotId:snapshot,lineage:claim.lineage,state:'starting'};
 await writeFile(path.join(root,'host-observation.json'),JSON.stringify(observation));
 await assert.rejects(client.relayLeaveGroup(member,peer),/pending|start|stop/i);
 await writeFile(path.join(root,'host-observation.json'),JSON.stringify({...observation,state:'hosting'}));
 await assert.rejects(client.relayLeaveGroup(member,peer),/stop|hosting|publish/i);
 await rm(path.join(root,'host-observation.json'));
 const incoming={...claim,id:crypto.randomUUID(),source:member.fingerprint,target:identity.fingerprint,generation:claim.generation+1};
 await ledger.acceptTransfer(incoming,member.fingerprint,snapshot);await client.relayLeaveGroup(member,peer);
 assert.equal((await client.relayLeaveStatus(member,peer)).left,true);
});
test('member leaves only its own membership; authenticated durable readback and same-device retry survive restart',async t=>{
 const {root,owner,member,relay,peer}=await setup(t);
 assert.equal(typeof client.relayLeaveGroup,'function');
 await assert.rejects(client.relayLeaveGroup(owner,peer),/owner|disband/i);
 await client.relayLeaveGroup(member,peer);
 assert.equal((await client.relayLeaveStatus(member,peer)).left,true);
 assert.deepEqual((await client.relayFriends(owner,peer)).members.map(m=>m.fingerprint),[owner.fingerprint]);
 await assert.rejects(client.relayFriends(member,peer),/untrusted|refused|denied/i);
 await relay.close();const again=new RelayNode(root,relay.identity,{log:()=>{}});await again.open();await again.listen();t.after(()=>again.close());
 const restarted={fingerprint:relay.identity.fingerprint,...again.endpoint};
 await client.relayLeaveGroup(member,restarted);
 assert.equal((await client.relayLeaveStatus(member,restarted)).left,true);
});
