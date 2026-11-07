// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import * as github from '../public/github-workspace.mjs';

class Node {
 constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.listeners={};this.attributes={};this.textContent='';}
 append(...items){this.children.push(...items);}
 setAttribute(key,value){this.attributes[key]=value;}
 addEventListener(key,listener){this.listeners[key]=listener;}
}
const document={createElement:tag=>new Node(tag)};
const find=(node,tag)=>[...(node.tagName===tag?[node]:[]),...node.children.filter(child=>typeof child==='object').flatMap(child=>find(child,tag))];
const text=node=>node.textContent+node.children.map(child=>typeof child==='string'?child:text(child)).join(' ');
const sha='a'.repeat(40),when='2026-10-30T02:00:00Z';
test('repository records have honest readable labels, draft/merged states and compact facts',()=>{
 assert.equal(typeof github.githubRecordSummary,'function');
 const branch=github.githubRecordSummary({kind:'branch',name:'main',headSha:sha,protected:false});
 assert.equal(branch.label,'main');assert.equal(branch.state,'Unprotected');assert(branch.facts.some(([key,value])=>key==='Commit'&&value===sha));
 const draft=github.githubRecordSummary({kind:'pull-list',number:7,state:'open',draft:true,base:{sha},head:{sha}});
 assert.equal(draft.label,'Pull request #7');assert.equal(draft.state,'Draft · Open');
 assert.equal(github.githubRecordSummary({kind:'pull',number:7,state:'closed',merged:true}).state,'Merged');
 assert.equal(github.githubRecordSummary({kind:'check',id:8,status:'completed',conclusion:null}).state,'Completed');
 assert.equal(github.githubRecordSummary({kind:'artifact',id:9,expired:false,sizeBytes:0}).state,'Available');
});
test('captured-history status never misreports the separately configured GitHub account',()=>{
 assert.equal(typeof github.githubHistoryStatus,'function');
 assert.equal(github.githubHistoryStatus(0),'No captured history for this project.');
 assert.match(github.githubHistoryStatus(2,'10:00'),/^Captured history · refreshed 10:00$/);
});
test('repository overview shows readable counts and all groups; exact metadata is lazy and lossless',()=>{
 assert.equal(typeof github.renderGitHubOverview,'function');
 const records=[{kind:'branch',name:'main',headSha:sha,protected:true,observedAt:when,extra:'<unsafe>'},{kind:'pull-list',id:3,number:7,state:'open',draft:true,base:{sha},head:{sha},updated_at:when}];
 const overview=github.renderGitHubOverview({document,repository:'argellan/test',records,observedAt:when,state:'partial'});
 assert.match(text(overview),/Partial coverage/);assert.match(text(overview),/Pull request #7/);assert.match(text(overview),/Draft · Open/);
 for(const name of ['Branches','Pull requests','Checks & statuses','Workflow runs','Artifacts'])assert(text(overview).includes(name));
 assert.equal(find(overview,'pre').length,0);
 const details=find(overview,'details').filter(item=>item.className==='github-technical');assert.equal(details.length,2);
 details[0].open=true;details[0].listeners.toggle();
 const raw=find(details[0],'pre');assert.equal(raw.length,1);assert.deepEqual(JSON.parse(raw[0].textContent),records[0]);
 details[0].listeners.toggle();assert.equal(find(details[0],'pre').length,1);
 const links=find(overview,'a');assert(links.some(link=>link.href==='https://github.com/argellan/test/pull/7'));
});
test('empty groups describe the returned view without inventing repository-wide absence',()=>{
 assert.equal(typeof github.renderGitHubOverview,'function');
 const overview=github.renderGitHubOverview({document,repository:'argellan/test',records:[],state:'partial'});
 assert.match(text(overview),/No checks or statuses returned/);assert.match(text(overview),/No workflow runs returned/);
 assert(!text(overview).includes('All checks passed'));
});
test('repository metadata and coverage remain available without expanding record details',()=>{
 const record={kind:'repository',fullName:'argellan/test',private:true,archived:true,created_at:when};
 const coverage={unavailable:['checks'],bounded:true,completeRepositoryHistory:false};
 const overview=github.renderGitHubOverview({document,repository:record.fullName,records:[record],state:'partial',coverage});
 assert.match(text(overview),/Private · Archived/);assert.match(text(overview),/Unavailable: Checks/);
 const details=find(overview,'details').find(node=>node.className==='github-technical github-repository-technical');
 assert(details);assert.equal(find(details,'pre').length,0);details.open=true;details.listeners.toggle();
 assert.deepEqual(JSON.parse(find(details,'pre')[0].textContent),{repository:record,coverage});
});
