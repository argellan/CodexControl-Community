// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import os from 'node:os';
// Desktop Hubs manage network Nodes. Servers and Pis retain Node capability.
export function requireCommunityRole(role,{platform=process.platform,version=os.version()}={}){
 if(role==='hub'&&(!['win32','darwin'].includes(platform)||platform==='win32'&&/\bServer\b/i.test(version)))throw Object.assign(new Error('Install the Hub on a Windows or Mac desktop. Use Node on this computer.'),{status:400,code:'DESKTOP_HUB_REQUIRED'});
 return role;
}
