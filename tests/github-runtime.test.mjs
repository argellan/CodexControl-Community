// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openGitHubRuntime,validateGitHubRuntime} from '../lib/github-runtime.mjs';
import {createServer} from './fixture-server.mjs';

const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const binding={sourceId:'github-fixture',hostId:'fixture-host',project:'Fixture',repository:'example/fixture',repositoryId:42,pullNumbers:[],intervalMs:60000};
const viewer={id:'fixture-viewer',label:'Fixture viewer',hostIds:['fixture-host'],projectIds:['Fixture'],tokenHash:hash('TEST_ONLY_key')};
const hosts=[{id:'fixture-host',tokenHash:hash('TEST_ONLY_collector')}];
const eventually=async predicate=>{const deadline=Date.now()+5000;while(!await predicate()){assert.ok(Date.now()<deadline,'condition timed out');await new Promise(r=>setTimeout(r,20));}};

test('runtime configuration is opt-in, bounded and accepts private local paths only',()=>{
 assert.deepEqual(validateGitHubRuntime(undefined),{sources:[]});
 const source={...binding,credentialFile:path.resolve('TEST_ONLY_token')};
 assert.equal(validateGitHubRuntime({sources:[source]}).sources[0].enabled,true);
 for(const value of [{sources:[{...source,token:'PRIVATE_SENTINEL'}]},{sources:[source,source]},{sources:[{...source,credentialFile:'relative'}]},{sources:[{...source,credentialFile:'//server/token'}]},{sources:[source],archiveSenderConfigFile:'relative'},{sources:[{...source,enabled:'yes'}]}])assert.throws(()=>validateGitHubRuntime(value));
});

test('disabled sources neither contact GitHub nor disclose their metadata',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-github-disabled-'));let calls=0,runtime;
 t.after(async()=>{await runtime?.close();await fs.rm(directory,{recursive:true,force:true});});
 runtime=await openGitHubRuntime({configuration:{sources:[{...binding,enabled:false,credentialFile:path.join(directory,'absent')}]},dataDirectory:directory,getHosts:()=>hosts,fetchImpl:()=>{calls++;throw Error('must not contact');},tickMs:20});
 await new Promise(r=>setTimeout(r,50));assert.equal(calls,0);assert.deepEqual(runtime.read({viewer,hosts,view:'summary'}).sources,[]);assert.throws(()=>runtime.read({viewer,hosts,source:binding.sourceId}),{status:403});
});

test('POSIX scheduler validates the credential file, honors grant removal and closes safely',{skip:process.platform==='win32'},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-github-runtime-'));let runtime,calls=0;const liveHosts=[...hosts.map(h=>({...h}))];
 t.after(async()=>{await runtime?.close();await fs.rm(directory,{recursive:true,force:true});});
 const credentialFile=path.join(directory,'credential');await fs.writeFile(credentialFile,'github_pat_TEST_ONLY_012345678901234567890',{mode:0o600});
 runtime=await openGitHubRuntime({configuration:{sources:[{...binding,credentialFile}]},dataDirectory:directory,getHosts:()=>liveHosts,tickMs:20,fetchImpl:async(url,options)=>{calls++;assert.equal(options.method,'GET');assert.ok(options.headers.authorization.startsWith('Bearer github_pat_'));return new Response(JSON.stringify({id:42,full_name:'example/fixture',private:true,archived:false}),{headers:{'content-type':'application/json',etag:'"fixture"'}});}});
 await eventually(()=>runtime.read({viewer,hosts:liveHosts,view:'summary'}).sources[0].state==='current');assert.equal(calls,1);
 const file=path.join(directory,'github',binding.sourceId+'.sqlite');assert.equal((await fs.stat(file)).mode&0o777,0o600);
 liveHosts[0].disabled=true;assert.deepEqual(runtime.read({viewer,hosts:liveHosts,view:'summary'}).sources,[]);
 const db=new DatabaseSync(file);const state=JSON.parse(db.prepare('SELECT payload FROM scheduler').get().payload);state.due=0;db.prepare('UPDATE scheduler SET payload=?').run(JSON.stringify(state));db.close();
 await new Promise(r=>setTimeout(r,60));assert.equal(calls,1);await runtime.close();runtime=null;
});

test('gateway forwards only the dedicated read API with compression and honors upstream revocation',async t=>{
 let denied=false,seen;const source=createServer({viewers:[viewer],hub:{hosts},githubIntegration:{read(options){assert.equal(options.view,'summary');assert.equal(options.viewer.id,viewer.id);if(denied)throw Object.assign(Error('Denied'),{status:403});return {sources:[{sourceId:binding.sourceId,repository:binding.repository,records:[]}],state:'configured'};}}});
 source.on('request',req=>{if(req.url.startsWith('/api/integrations/github'))seen=req.headers['accept-encoding'];});
 await new Promise(r=>source.listen(0,'127.0.0.1',r));const gateway=createServer({viewTokenHash:hash('TEST_ONLY_gateway'),upstream:{url:'http://127.0.0.1:'+source.address().port,token:'TEST_ONLY_key'}});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 t.after(async()=>{for(const server of [gateway,source]){server.closeAllConnections();await new Promise(r=>server.close(r));}});
 const url='http://127.0.0.1:'+gateway.address().port+'/api/integrations/github?view=summary',headers={authorization:'Bearer TEST_ONLY_gateway'};
 const response=await fetch(url,{headers});assert.equal(response.status,200);const data=await response.json();assert.equal(data.sources[0].sourceId,binding.sourceId);assert.match(data.permissionStamp,/^[a-f0-9]{64}$/);assert.equal(seen,'gzip');
 denied=true;assert.equal((await fetch(url,{headers})).status,403);assert.equal((await fetch(url,{method:'POST',headers})).status,405);assert.equal((await fetch(url+'&view=history',{headers})).status,400);
});

test('source revocation during response construction prevents publishing GitHub metadata',async t=>{
 const liveHosts=[{id:'fixture-host',tokenHash:hash('TEST_ONLY_collector')}];
 const server=createServer({viewers:[viewer],hub:{hosts:liveHosts},githubIntegration:{read(){liveHosts[0].disabled=true;return {sources:[{private:'MUST_NOT_PUBLISH'}]};}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/integrations/github?view=summary',{headers:{authorization:'Bearer TEST_ONLY_key','accept-encoding':'gzip'}});assert.equal(response.status,403);assert.equal((await response.text()).includes('MUST_NOT_PUBLISH'),false);
});
