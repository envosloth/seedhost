import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {SeedHostApplication} from '../dist/src/core/application.js';
import {createIdentity} from '../dist/src/core/peer-transport.js';
import {readSnapshot,createSnapshot,pruneBackupHistory} from '../dist/src/core/snapshots.js';
import {OwnershipLedger} from '../dist/src/core/ownership.js';
import {RelayNode} from '../dist/src/core/relay.js';
import {saveAdmission} from '../dist/src/core/recovery-journal.js';
async function fixture(t,options){
 const root=await mkdtemp(path.join(process.env.TMPDIR,'backup-retention-')),identity=await createIdentity();
 const app=new SeedHostApplication(path.join(root,'profile'),identity,options);await app.open();
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 async function add(name){const source=path.join(root,name);await mkdir(source);await writeFile(path.join(source,'world.dat'),name);await writeFile(path.join(source,'eula.txt'),'eula=true\n');await writeFile(path.join(source,'server.properties'),'server-port=0\n');await app.importExisting(source,true);return app.saved.servers.at(-1);}
 return {root,identity,app,add};
}
async function missing(file){await assert.rejects(readFile(file),{code:'ENOENT'});}
async function manifests(storeDir){return (await readdir(path.join(storeDir,'snapshots'))).filter(name=>name.endsWith('.json')).length;}
test('shared-store retention leaves another world and a conflict branch byte-identical',async t=>{
 const {app,add}=await fixture(t),one=await add('one'),two=await add('two');
 const twoManifest=await readFile(path.join(two.storeDir,'snapshots',two.snapshotId+'.json'));
 await app.selectServer(one.id);const ancestor=one.snapshotId;
 await writeFile(path.join(one.serverDir,'world.dat'),'conflict');const branch=await createSnapshot(one.serverDir,one.storeDir,ancestor);
 const branchManifest=await readFile(path.join(one.storeDir,'snapshots',branch.id+'.json'));
 await writeFile(path.join(one.serverDir,'world.dat'),'main');await app.createSnapshot();
 assert.deepEqual(await readFile(path.join(one.storeDir,'snapshots',branch.id+'.json')),branchManifest);
 assert.deepEqual(await readFile(path.join(two.storeDir,'snapshots',two.snapshotId+'.json')),twoManifest);
 await readSnapshot(one.storeDir,ancestor);assert.equal(await readFile(path.join(two.serverDir,'world.dat'),'utf8'),'two');
});
test('a conflict branch descending through the replaceable chain retains its shared ancestor',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'backup-diamond-')),store=path.join(root,'store'),work=path.join(root,'work');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(work);
 await writeFile(path.join(work,'world.dat'),'fork');const fork=await createSnapshot(work,store);
 await writeFile(path.join(work,'world.dat'),'slot1');const one=await createSnapshot(work,store,fork.id);
 await writeFile(path.join(work,'world.dat'),'slot2');const two=await createSnapshot(work,store,one.id);
 await writeFile(path.join(work,'world.dat'),'branch');const branch=await createSnapshot(work,store,fork.id);
 const pruned=await pruneBackupHistory(store,two.id,[fork.id,branch.id]);
 assert.equal(pruned.snapshotsRemoved,1);
 await readSnapshot(store,branch.id);await readSnapshot(store,fork.id);await readSnapshot(store,two.id);
 await assert.rejects(readFile(path.join(store,'snapshots',one.id+'.json')),{code:'ENOENT'});
});
for(const protection of ['offer','uncertain','unreadable-ledger','journal','pending-group','activation']) test('automatic retention refuses '+protection,async t=>{
 const {app,add,root,identity}=await fixture(t),other=await add('other'),server=await add('active');
 const prior=await readSnapshot(server.storeDir,server.snapshotId),ledger=new OwnershipLedger(other.ledgerFile,identity.fingerprint);
 if(protection==='offer') await ledger.prepareTransfer('a'.repeat(64),other.snapshotId);
 if(protection==='uncertain') await ledger.markUncertain();
 if(protection==='unreadable-ledger') await writeFile(other.ledgerFile,'corrupt');
 if(protection==='journal') await saveAdmission(path.join(root,'profile'),{version:1,serverId:other.id,deviceId:identity.fingerprint,relayFingerprint:'a'.repeat(64),revision:{generation:1,snapshotId:prior.id,lineage:'lineage',reservation:crypto.randomUUID()},attempted:true,acknowledged:false,stopped:false,recoverySnapshot:prior.id,phase:'attempted'});
 if(protection==='pending-group') app.saved.pendingGroups.push({fingerprint:'a'.repeat(64),parkOnStop:false,adoptable:false});
 if(protection==='activation') app.saved.activation={serverId:other.id};
 await writeFile(path.join(server.serverDir,'world.dat'),'replacement');await app.createSnapshot();
 await readSnapshot(server.storeDir,prior.id);await readFile(path.join(server.storeDir,'objects',prior.files.find(f=>f.path==='world.dat').hash));
 assert.ok((await app.getState()).logs.some(line=>/retention deferred/.test(line)));
});
test('cleanup preflight failure keeps the prior valid copy and reports backup success',async t=>{
 const {app,add}=await fixture(t),server=await add('failure'),prior=await readSnapshot(server.storeDir,server.snapshotId);
 await writeFile(path.join(server.storeDir,'objects','unknown-file'),'leave me');
 await writeFile(path.join(server.serverDir,'world.dat'),'replacement');await app.createSnapshot();
 assert.notEqual(server.snapshotId,prior.id);await readSnapshot(server.storeDir,prior.id);
 assert.equal(await readFile(path.join(server.storeDir,'objects',prior.files.find(f=>f.path==='world.dat').hash),'utf8'),'failure');
 assert.equal((await app.getState()).server.ownership.state,'owned');assert.ok((await app.getState()).logs.some(line=>/Backup saved; automatic retention deferred/.test(line)));
});
test('failed library publication cannot prune the last durable backup',async t=>{
 const {app,add}=await fixture(t),server=await add('durable'),prior=server.snapshotId;
 const persist=app.persist;app.persist=async()=>{throw new Error('injected durability failure');};
 await writeFile(path.join(server.serverDir,'world.dat'),'replacement');
 await assert.rejects(app.createSnapshot(),/durability failure/);app.persist=persist;
 await readSnapshot(server.storeDir,prior);
});
test('group Stop publication and retry automatically bound ordinary history',async t=>{
 const {app,add,root,identity}=await fixture(t,{resolveGroupLaunchProfile:async(_dir,local)=>local.executable?local:{executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs'),'--lifetime-ms=30000']}}),server=await add('group');
 const relay=new RelayNode(path.join(root,'relay'),await createIdentity(),{log:()=>{}});await relay.open();await relay.trust('Owner',identity.fingerprint);await relay.setOwner(identity.fingerprint);await relay.listen();
 t.after(()=>relay.close());
 const endpoint={...relay.endpoint};await app.addPeer({name:'Relay',fingerprint:relay.identity.fingerprint,...endpoint});await app.saveRelay({fingerprint:relay.identity.fingerprint,parkOnStop:false});
 await app.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs'),'--lifetime-ms=30000']});
 await app.startServer(true);await app.stopServer();assert.equal(await manifests(server.storeDir),1);
 const parked=server.snapshotId;
 assert.equal((await app.getState()).server.ownership.state,'transferred');
 await app.claimFromRelay();const held=(await app.getState()).server.snapshotId;
 await app.startServer(true);await relay.close();
 await assert.rejects(app.stopServer(),/relay|unreachable|publication/i);
 assert.ok(await manifests(server.storeDir)>=2);
 await readSnapshot(server.storeDir,held);await relay.listen({port:endpoint.port});await app.stopServer();
 assert.equal(await manifests(server.storeDir),1);await missing(path.join(server.storeDir,'snapshots',parked+'.json'));
 await missing(path.join(server.storeDir,'snapshots',held+'.json'));
 assert.equal((await app.getState()).server.ownership.state,'transferred');
});
test('repeated Save backup retains one completed revision and frees predecessor-only objects',async t=>{
 const {app,add}=await fixture(t),server=await add('one');
 for(let n=0;n<3;n++){
  const previous=await readSnapshot(server.storeDir,server.snapshotId),old=previous.files.find(f=>f.path==='world.dat');
  await writeFile(path.join(server.serverDir,'world.dat'),'new-'+n);await app.createSnapshot();
  assert.equal((await app.listSnapshots()).length,1);
  await missing(path.join(server.storeDir,'snapshots',previous.id+'.json'));
  await missing(path.join(server.storeDir,'objects',old.hash));
  assert.equal(await readFile(path.join(server.serverDir,'world.dat'),'utf8'),'new-'+n);
 }
 assert.ok((await app.getState()).logs.some(line=>/Automatic backup retention.*freed/.test(line)));
});
test('repeated graceful Stop keeps only its durable final backup',async t=>{
 const {app,add}=await fixture(t),server=await add('stop');
 await app.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs')]});
 for(let n=0;n<2;n++){
  const old=server.snapshotId;await app.startServer(true);await app.stopServer();
  assert.equal((await app.listSnapshots()).length,1);await missing(path.join(server.storeDir,'snapshots',old+'.json'));
  assert.equal((await app.getState()).server.ownership.state,'owned');
 }
});
