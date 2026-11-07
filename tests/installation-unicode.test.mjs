// Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {InstallationDiscovery} from '../lib/installation-discovery.mjs';
import {Installation} from '../lib/installation.mjs';
import {installationName as displayName,presentInstallationNames} from '../public/installation-names.mjs';

const identity=(id,name,role='node')=>({id,hostId:`host-${id}`,role,name});
const options={address:'127.0.0.1',port:8443,advertise:true,pairable:true};
const validNames=['\u754c'.repeat(40),'\u754c'.repeat(41),'a'.repeat(116)+'\u{1f680}','a'.repeat(117)+'\u{1f680}','\u754c'.repeat(120),'\u{1f6f0}'.repeat(120),'A'.repeat(117)+'\u{1f680}Z','Lab "A" <node> & \\ path'];
function channel(){const listeners=new Set(),packets=[];return {packets,transport(){let listener;return {async open({onMessage}){listener=onMessage;listeners.add(listener);},async send(packet){packets.push(Buffer.from(packet));for(const receive of listeners)receive(Buffer.from(packet));},async close(){listeners.delete(listener);},status(){return {synthetic:true};}};}};}
function prefix(value,maxBytes=120){let result='';for(const point of value){if(Buffer.byteLength(result+point)>maxBytes)break;result+=point;}return result;}

test('name validator accepts trimmed well-formed names through 120 Unicode code points',async()=>{
 const {installationName}=await import('../public/installation-identity.mjs');
 for(const value of validNames){assert.equal(installationName(value),value);assert.equal(installationName('  '+value+'  '),value);}
 assert.equal(installationName(' \u{1f680} \u754c '),'\u{1f680} \u754c');
});

test('name validator rejects invalid types, empty, overlong, surrogate and control values',async()=>{
 const {installationName}=await import('../public/installation-identity.mjs');
 for(const value of [null,undefined,12,{},'', '   ','a'.repeat(121),'\u754c'.repeat(121),'\u{1f680}'.repeat(121),'x\ud800','\udc00x','a\n','\tx','a\u0000b','a\u007fb','a\u0085b','a\u009fb'])assert.throws(()=>installationName(value),/Display name/);
});

test('discovery accepts full Unicode product identity while advertisement is a bounded UTF-8 hint',async t=>{
 for(const fullName of validNames){
  const bus=channel(),receiver=new InstallationDiscovery({identity:identity('hub','Hub','hub'),transport:bus.transport()}),sender=new InstallationDiscovery({identity:identity('node',fullName),transport:bus.transport()});
  t.after(async()=>{await sender.close();await receiver.close();});await receiver.start();await sender.start(options);
  const hint=receiver.candidates()[0];assert.equal(sender.identity.name,fullName);assert.equal(hint.name,prefix(fullName));assert.equal(hint.name.isWellFormed(),true);assert.ok(Buffer.byteLength(hint.name)<=120);assert.equal(hint.untrusted,true);assert.ok(bus.packets.every(packet=>packet.length<=4096));
  const replacement=fullName==='\u754c'.repeat(41)?'\u{1f680}'.repeat(120):'\u754c'.repeat(41);await sender.update({identity:identity('node',replacement)});
  assert.equal(sender.identity.name,replacement);assert.equal(receiver.candidates().length,1);assert.equal(receiver.candidates()[0].name,prefix(replacement));
 }
});

test('discovery rejects invalid identities before publishing a replacement',async t=>{
 const bus=channel(),sender=new InstallationDiscovery({identity:identity('node','Original'),transport:bus.transport()});t.after(()=>sender.close());await sender.start(options);
 const count=bus.packets.length;
 for(const name of ['\u754c'.repeat(121),'\ud800','a\u0085b','a\n',' ']){
  assert.throws(()=>new InstallationDiscovery({identity:identity('bad',name)}),/identity/);
  await assert.rejects(sender.update({identity:identity('node',name)}),/identity/);
 }
 assert.equal(sender.identity.name,'Original');assert.equal(bus.packets.length,count);
 assert.throws(()=>new InstallationDiscovery({identity:{...identity('bad','Name'),id:'a\ud800'}}),/identity/);
});

test('discovery decoding rejects malformed UTF-8 and controls without replacing a valid hint',async t=>{
 const bus=channel(),sender=new InstallationDiscovery({identity:identity('node','ABCD'),transport:bus.transport()});let receive;
 const receiver=new InstallationDiscovery({identity:identity('hub','Hub','hub'),transport:{async open(o){receive=o.onMessage;},async close(){}}});
 t.after(async()=>{await sender.close();await receiver.close();});await sender.start(options);await receiver.start();const good=bus.packets[0];receive(good);assert.equal(receiver.candidates()[0].name,'ABCD');
 for(const replacement of [Buffer.from([0xc3,0x28,0x43,0x44]),Buffer.from([0x41,0,0x43,0x44]),Buffer.from([0x41,0xc2,0x85,0x44])]){const malformed=Buffer.from(good),offset=malformed.indexOf(Buffer.from('name=ABCD'))+5;replacement.copy(malformed,offset);receive(malformed);assert.equal(receiver.candidates()[0]?.name,'ABCD');}
 assert.equal(receiver.status().rejectedPackets,3);
});

test('discovery truncation preserves identity collision visibility',async t=>{
 const bus=channel(),receiver=new InstallationDiscovery({identity:identity('hub','Hub','hub'),transport:bus.transport()});await receiver.start();t.after(()=>receiver.close());
 for(let i=0;i<2;i++){const sender=new InstallationDiscovery({identity:{...identity('same','\u754c'.repeat(120)),hostId:`physical-${i}`},transport:bus.transport()});t.after(()=>sender.close());await sender.start({...options,port:8500+i});}
 assert.equal(receiver.candidates().length,2);assert.ok(receiver.candidates().every(row=>row.collision&&row.name==='\u754c'.repeat(40)));
});

test('full Unicode persisted names survive rename and restart and remain available in presentation',async t=>{
 const base=process.env.ARGELLAN_UNICODE_TEST_STATE||os.tmpdir();await fs.mkdir(base,{recursive:true});const directory=await fs.mkdtemp(path.join(base,'ARGELLAN-TEST_ONLY-unicode-'));t.diagnostic('Synthetic standalone state: '+directory);let app;
 t.after(async()=>{await app?.close();});app=await Installation.open({directory,hostId:'unicode-test',name:'Original'});const before=app.state();
 for(const name of validNames){await app.rename({revision:app.state().revision,name});const stored=JSON.parse(await fs.readFile(path.join(directory,'installation.json'),'utf8'));assert.equal(stored.name,name);await app.close();app=await Installation.open({directory,hostId:'unicode-test'});const state=app.state();assert.equal(state.name,name);assert.equal(state.id,before.id);assert.equal(state.hostId,before.hostId);assert.equal(displayName(state.hostId,state),name);const original={hosts:[{id:state.hostId,name:'historical-source'}],events:[{hostId:state.hostId,hostName:'historical-source'}]},presented=presentInstallationNames(original,state);assert.equal(presented.hosts[0].name,name);assert.equal(presented.events[0].displayInstallationName,name);assert.equal(presented.hosts[0].provenanceHostName,'historical-source');assert.equal(original.hosts[0].name,'historical-source');}
 const stable=app.state(),bytes=await fs.readFile(path.join(directory,'installation.json'));
 for(const name of ['\u{1f680}'.repeat(121),'\ud800','a\u0085b','a\n'])await assert.rejects(app.rename({revision:stable.revision,name}),/Display name/);
 assert.deepEqual(app.state(),stable);assert.deepEqual(await fs.readFile(path.join(directory,'installation.json')),bytes);
});

