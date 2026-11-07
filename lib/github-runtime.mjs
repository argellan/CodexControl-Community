// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {GitHubIntegration} from './github-integration.mjs';
import {validateGitHubConfiguration,githubScopeAllowed} from './github-metadata.mjs';
import {readPrivateKeyFile} from './private-key-file.mjs';
import {archiveGitHubOnce} from '../scripts/archive-github.mjs';

export function validateGitHubRuntime(value){
  if(value===undefined)return {sources:[]};
  if(!value||Object.keys(value).some(k=>!['sources','archiveSenderConfigFile'].includes(k))||!Array.isArray(value.sources)||value.sources.length>8)throw new Error('Invalid GitHub integration settings');
  if(value.archiveSenderConfigFile!==undefined&&(!path.isAbsolute(value.archiveSenderConfigFile)||/^(?:\\\\|\/\/)/.test(value.archiveSenderConfigFile)))throw new Error('Local archive sender configuration required');
  const ids=new Set();
  const sources=value.sources.map(source=>{
    const {credentialFile,enabled=true,...binding}=source;
    if(typeof enabled!=='boolean'||typeof credentialFile!=='string'||!path.isAbsolute(credentialFile)||/^(?:\\\\|\/\/)/.test(credentialFile))throw new Error('Private GitHub credential file required');
    const configuration=validateGitHubConfiguration(binding);
    if(ids.has(configuration.sourceId))throw new Error('Duplicate GitHub source');ids.add(configuration.sourceId);
    return {configuration,credentialFile,enabled};
  });
  return {...value,sources};
}

export async function openGitHubRuntime({configuration,dataDirectory,getHosts,fetchImpl=fetch,tickMs=15000}={}){
  const config=validateGitHubRuntime(configuration),sources=[];let stopped=false,timer,running,archiveAt=0;
  if(!config.sources.length)return null;
  const directory=path.join(dataDirectory,'github');await fs.mkdir(directory,{recursive:true,mode:0o700});
  if(process.platform!=='win32')await fs.chmod(directory,0o700);
  try{
    for(const source of config.sources){
      const file=path.join(directory,source.configuration.sourceId+'.sqlite');
      const active=()=>source.enabled&&githubScopeAllowed(source.configuration,{hostIds:null,projectIds:null},getHosts());
      let credential=null,credentialAt=0,credentialMark='';
      const tokenProvider=async()=>{
        if(stopped||!active())throw new Error('Source disabled');
        const stat=await fs.stat(source.credentialFile),mark=[stat.mtimeMs,stat.ctimeMs,stat.size].join(':');
        if(!credential||mark!==credentialMark||Date.now()-credentialAt>60000){
          credential=(await readPrivateKeyFile(source.credentialFile,{maxBytes:512})).toString('utf8').trim();
          if(!/^(github_pat_|ghs_)[A-Za-z0-9_]{20,240}$/.test(credential)){credential=null;throw new Error('Dedicated read-only GitHub credential required');}
          credentialMark=mark;credentialAt=Date.now();
        }
        return credential;
      };
      const integration=new GitHubIntegration({file,configuration:source.configuration,tokenProvider,fetchImpl});
      sources.push({...source,file,active,integration,clear:()=>{credential=null;}});
    }
  }catch(error){for(const source of sources)source.integration.close();throw error;}
  const tick=async()=>{
    if(stopped||running)return;
    running=(async()=>{
      for(const source of sources){if(stopped)break;if(source.active())await source.integration.poll({requestBudget:2});else source.clear();}
      if(!stopped&&config.archiveSenderConfigFile&&Date.now()-archiveAt>=60000){
        archiveAt=Date.now();for(const source of sources){if(stopped)break;await archiveGitHubOnce({file:source.file,configFile:config.archiveSenderConfigFile});}
      }
    })();
    try{await running;}catch{/* Safe states are recorded by the source; never log upstream bodies. */}finally{running=null;}
  };
  timer=setInterval(tick,tickMs);timer.unref();void tick();
  return {
    read(options){
      const permitted=sources.filter(source=>source.active()&&githubScopeAllowed(source.configuration,options.viewer,options.hosts));
      if(options.source){const source=permitted.find(s=>s.configuration.sourceId===options.source);if(!source)throw Object.assign(new Error('GitHub source not permitted'),{status:403});return options.view==='history'?source.integration.read(options):source.integration.snapshot(options);}
      if(options.view==='history')throw Object.assign(new Error('Select a source for history'),{status:400});
      return {state:permitted.length?'configured':'unavailable',reason:permitted.length?null:'no_permitted_sources',sources:permitted.map(source=>source.integration.snapshot(options))};
    },
    async close(){stopped=true;clearInterval(timer);try{if(running)await running;}finally{for(const source of sources){source.clear();source.integration.close();}}},
  };
}
