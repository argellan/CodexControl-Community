import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {createServer} from './fixture-server.mjs';
test('GitHub routes bind individual session and actual project scope, with only a fixed callback exception',async()=>{
 const token='TEST_ONLY_GITHUB_ROUTE',hash=s=>crypto.createHash('sha256').update(s).digest('hex'),calls=[];
 const hub={hosts:[{id:'test-source',tokenHash:hash('TEST_ONLY_SOURCE')}],journal:{projectActivity:({project,hostIds})=>({projects:project==='Alpha'&&hostIds.includes('test-source')?[{name:'Alpha'}]:[]})}};
 const service={close:async()=>{},callback:async({query})=>{calls.push({action:'callback',query});return {completionPath:'/?github=complete'};}};
 for(const action of ['startAuthorization','completeAuthorization','listRepositories','selectRepositories','disconnect','readRepository'])service[action]=async options=>{assert.equal(options.verifyAuthority().id,'test-owner');assert.equal(options.project,'Alpha');assert.match(options.clientKey,/^[a-f0-9]{64}$/);calls.push({action,options});return {configured:true,state:'authorized',repositories:[],selection:[]};};
 const server=createServer({hub,githubConnections:service,viewers:[{id:'test-owner',label:'TEST_ONLY owner',tokenHash:hash(token),role:'viewer',hostIds:['test-source'],projectIds:['Alpha']}]});await new Promise(r=>server.listen(0,'127.0.0.1',r));const root='http://127.0.0.1:'+server.address().port;
 const read=(route,options={})=>fetch(root+route,{...options,headers:{Authorization:'Bearer '+token,...options.headers}});
 try{
  assert.equal((await fetch(root+'/api/integrations/github/repositories?project=Alpha')).status,401);
  assert.equal((await read('/api/integrations/github/repositories?project=Alpha')).status,200);
  assert.equal((await read('/api/integrations/github/connect?project=Alpha',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,200);
  assert.equal((await read('/api/integrations/github/connect?project=Alpha')).status,405);
  assert.equal((await read('/api/integrations/github/connect?project=Alpha',{method:'POST',headers:{'content-type':'application/json'},body:'{"redirect":"https://evil.invalid"}'})).status,400);
  assert.equal((await read('/api/integrations/github/repositories?project=Secret')).status,403);
  assert.equal((await read('/api/integrations/github/repositories?project=Alpha&project=Alpha')).status,400);
  assert.equal((await read('/api/integrations/github/selection?project=Alpha',{method:'POST',headers:{Origin:'https://github.com','content-type':'application/json'},body:'{}'})).status,403);
  const callback=await new Promise((resolve,reject)=>{const request=http.get(root+'/api/integrations/github/callback?state=TEST_ONLY_STATE&code=TEST_ONLY_CODE',{headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode,body}));});request.on('error',reject);});
  assert.equal(callback.status,200);const html=callback.body;assert.match(html,/github-return.mjs/);assert(!html.includes('TEST_ONLY_CODE'));assert.equal(calls.at(-1).action,'callback');
  assert.equal((await fetch(root+'/api/integrations/github/callback?state=x',{headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'cors'}})).status,403);
  hub.hosts[0].disabled=true;assert.equal((await read('/api/integrations/github/repositories?project=Alpha')).status,403);
 }finally{await new Promise(r=>server.close(r));}
});
