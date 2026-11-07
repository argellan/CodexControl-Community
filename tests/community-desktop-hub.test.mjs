// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {requireCommunityRole} from '../lib/community-platform.mjs';
import {planInstallation} from '../lib/platform-installation.mjs';
test('a Pi/Linux computer retains Node installation while Hub deployment is refused',()=>{
 const options={platform:'linux',root:'/opt/codexcontrol',dataDirectory:'/home/test/.local/share/codexcontrol',executable:'/usr/bin/node'};
 const node=planInstallation({...options,role:'node'});
 assert.equal(node.newRole,'node');assert.equal(node.config.installationRole,'node');
 assert.equal(node.artifacts[0].kind,'systemd-user-unit');
 assert.throws(()=>planInstallation({...options,role:'hub'}),{code:'DESKTOP_HUB_REQUIRED'});
});
test('Windows Server can report as a Node and cannot become the Hub',()=>{
 const environment={platform:'win32',version:'Windows Server 2025 Datacenter'};
 assert.equal(requireCommunityRole('node',environment),'node');
 assert.throws(()=>requireCommunityRole('hub',environment),{code:'DESKTOP_HUB_REQUIRED'});
 assert.equal(requireCommunityRole('hub',{platform:'win32',version:'Windows 11 Pro for Workstations'}),'hub');
});
