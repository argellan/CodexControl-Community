import test from 'node:test';
import assert from 'node:assert/strict';
import {InstallationWorkspace,renderInstallation,installationPeerState} from '../public/installation-workspace.mjs';
import {installationName,presentInstallationNames} from '../public/installation-names.mjs';
const status=()=>({id:'local-12345678',hostId:'host-local',name:'Desk',role:'hub',revision:3,phase:'active',peers:[],pairing:[],queue:{pendingRecords:4,dormantRecords:1,retainedRecords:8},discovery:{status:'disabled',candidates:[]}});
const authority=()=>({role:'admin',capabilities:{installationManage:true,installationRole:true},viewer:{id:'owner',sessionId:'session',hostIds:null,projectIds:null}});
function harness(request){let auth=authority();const ui=new InstallationWorkspace({request,getAuthority:()=>auth,onChange:()=>{}});return {ui,setAuthority:value=>{auth=value;}};}
test('duplicate current names are disambiguated by stable identity and provenance stays exact',()=>{
 const context={...status(),peers:[{id:'peer-abcdef99',hostId:'host-peer',name:'Desk'}]};
 assert.match(installationName('host-local',context),/Desk.*12345678/);
 assert.match(installationName('host-peer',context),/Desk.*abcdef99/);
 const snapshot={hosts:[{id:'host-peer',name:'legacy-host'}],sessions:[{id:'session',hostId:'host-peer',hostName:'original-host'}],events:[{hostId:'host-peer',hostName:'original-event-host'}]};
 const result=presentInstallationNames(snapshot,context);
 assert.equal(snapshot.sessions[0].hostName,'original-host');assert.equal(result.sessions[0].provenanceHostName,'original-host');assert.match(result.hosts[0].name,/Desk/);assert.equal(result.events[0].provenanceHostName,'original-event-host');
 assert.equal(presentInstallationNames(result,context).sessions[0].provenanceHostName,'original-host');
});
test('names use exact ids, Unicode remains legible and render markup is escaped',()=>{
 const context={...status(),name:'台所 <script> & café'};assert.equal(installationName('host-local',context),context.name);assert.equal(installationName('missing',context),'missing');
 const html=renderInstallation({status:context});assert.ok(!html.includes('<script>'));assert.match(html,/台所 &lt;script&gt; &amp; café/);assert.match(html,/title="台所/);
});
test('receipt, offline and revocation states remain separate',()=>{
 assert.equal(installationPeerState({status:'connected'}),'Paired · awaiting authenticated first receipt');assert.equal(installationPeerState({firstReceiptAt:'2026-10-27',status:'reporting'}),'Reporting · authenticated receipt observed');assert.equal(installationPeerState({status:'offline',firstReceiptAt:'2026-10-27'}),'Offline · retained delivery may be pending');assert.equal(installationPeerState({revoked:true}),'Revoked · reporting access rejected');
});
test('role selection only plans; confirmation explicitly applies exact revision and plan',async()=>{
 const calls=[];const {ui}=harness(async(path,options)=>{calls.push([path,options]);if(path.endsWith('/plan'))return {planId:'planned',revision:3,from:'hub',to:'node',warnings:['Pending records remain associated with their destination.']};return status();});
 await ui.load();ui.update('role','node');assert.equal(calls.length,1);await ui.action('role-plan');assert.equal(calls.length,2);assert.ok(ui.model.plan);await ui.action('role-apply');assert.deepEqual(calls[2][1].body,{revision:3,planId:'planned'});
});
test('pending async operation cannot publish after scope/session/identity authority changes',async()=>{
 let resolve;const {ui,setAuthority}=harness(()=>new Promise(r=>{resolve=r;}));const pending=ui.load();setAuthority({...authority(),viewer:{id:'owner',sessionId:'new-session',hostIds:['one']}});resolve(status());await pending;assert.equal(ui.model.status,null);
});
test('invalidate aborts in-flight requests and clears transient pairing material',async()=>{
 let signal,resolve;const {ui}=harness((path,options)=>{signal=options.signal;return new Promise(r=>{resolve=r;});});const pending=ui.load();ui.invalidate();assert.equal(signal.aborted,true);resolve(status());await pending;assert.equal(ui.model.status,null);assert.ok(!ui.html().includes('pairing-code-value'));
});
test('codes remain transient and raw service errors never appear in markup or model',async()=>{
 const {ui}=harness(async path=>{if(path.endsWith('/open'))return {id:'invite',code:'TEST-PRIVATE-CODE',expiresAt:'2099-01-01T00:00:00Z',installation:{id:'local-12345678',name:'Desk',role:'hub'}};if(path.endsWith('/join'))throw Object.assign(new Error('TEST-PRIVATE-CODE token=secret'),{status:400});return status();});
 await ui.load();await ui.action('pairing-open');assert.match(ui.html(),/TEST-PRIVATE-CODE/);assert.ok(!JSON.stringify(ui.model).includes('TEST-PRIVATE-CODE'));
 ui.update('address','https://peer.example');await ui.action('pairing-join',{code:'TEST-PRIVATE-CODE'});assert.ok(!ui.html().includes('token=secret'));ui.invalidate();assert.ok(!ui.html().includes('TEST-PRIVATE-CODE'));
});
test('manual and discovery pairing share explicit join and collision candidates cannot be selected',async()=>{
 const calls=[];const fixture=status();fixture.discovery={status:'available',candidates:[{id:'peer',name:'Peer',role:'node',address:'https://peer.example',expiresAt:'2099-01-01T00:00:00Z'},{id:'collision',name:'Other',address:'https://other.example',collision:true}]};
 const {ui}=harness(async(path,options)=>{calls.push([path,options]);return fixture;});await ui.load();await ui.action('candidate',{id:'collision'});assert.equal(ui.model.form.address,'');await ui.action('candidate',{id:'peer'});assert.equal(calls.length,1);assert.equal(ui.model.form.address,'https://peer.example');await ui.action('pairing-join',{code:'short-code'});assert.deepEqual(calls[1][1].body,{revision:3,address:'https://peer.example',code:'short-code',expectedId:'peer'});
});
test('non-admin and missing manage capability never issue privileged requests',async()=>{
 let calls=0;const {ui,setAuthority}=harness(async()=>{calls++;return status();});setAuthority({...authority(),role:'viewer'});await ui.load();await ui.action('pairing-open');assert.equal(calls,0);assert.match(ui.html(),/Administrator/);
});
test('render includes both identity confirmations, explicit actions and accessible touch flow',()=>{
 const fixture=status();fixture.pairing=[{id:'pair',peer:{id:'peer',name:'Tablet',role:'node'},confirmedLocal:true,confirmedRemote:false,status:'pending'}];const html=renderInstallation({status:fixture});
 for(const label of ['Effective role','Requested role','Add node','Accept pairing','Manual address','Pairing code','Local confirmation','Remote confirmation','Tablet','local-12345678','peer'])assert.ok(html.includes(label),label);assert.match(html,/aria-live="polite"/);assert.match(html,/data-installation-action="pairing-confirm"/);
});

test('authority changes scrub already loaded identity, invitations and pending role confirmation',async()=>{
 const {ui,setAuthority}=harness(async path=>path.endsWith('/plan')?{planId:'old',revision:3,from:'hub',to:'node'}:status());await ui.load();ui.update('role','node');await ui.action('role-plan');assert.ok(ui.model.plan);setAuthority({...authority(),viewer:{...authority().viewer,sessionId:'replacement'}});ui.html();assert.equal(ui.model.plan,undefined);assert.equal(ui.model.status,null);
});
test('scoped administrators cannot issue installation actions even with an inconsistent capability',async()=>{
 let calls=0;const {ui,setAuthority}=harness(async()=>{calls++;return status();});setAuthority({...authority(),viewer:{...authority().viewer,hostIds:['limited-host']}});await ui.load();assert.equal(calls,0);assert.match(ui.html(),/Administrator/);
});
test('explicit status refresh preserves local pairing forms and independent Settings drafts',async()=>{
 const {ui}=harness(async()=>status());await ui.load();ui.update('address','https://intended.example');ui.update('name','My local draft');await ui.action('refresh');assert.equal(ui.model.form.address,'https://intended.example');assert.equal(ui.model.form.name,'My local draft');
});
test('nested history and export names retain exact original provenance and short-id collisions stay distinguishable',()=>{
 const context={...status(),id:'one-sameid99',hostId:'one',peers:[{id:'two-sameid99',hostId:'two',name:'Desk'}]};assert.notEqual(installationName('one',context),installationName('two',context));
 const data={history:{records:[{hostId:'two',hostName:'raw-two'}]},export:{observations:[{hostId:'one',hostName:'raw-one'}]}};const result=presentInstallationNames(data,context);assert.equal(result.history.records[0].provenanceHostName,'raw-two');assert.match(result.export.observations[0].hostName,/Desk/);assert.equal(data.history.records[0].hostName,'raw-two');
});
