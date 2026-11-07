// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// These are exact external authorities, not trusted proxies or forwarded headers.
// Keep this runtime-only: a viewer/configuration draft cannot expand request trust.
export function validateProxyOrigins(value=[]){
 if(!Array.isArray(value)||value.length>8)throw new Error('Invalid proxy origins: expected at most eight HTTPS origins');
 const hosts=new Set(),origins=[];
 for(const origin of value){
  let url;try{if(typeof origin!=='string'||origin.length>512)throw new Error();url=new URL(origin);}catch{throw new Error('Invalid proxy origin');}
  if(url.protocol!=='https:'||url.username||url.password||url.origin!==origin||url.hostname.includes('*')||hosts.has(url.host))throw new Error('Invalid or duplicate proxy origin');
  hosts.add(url.host);origins.push(origin);
 }
 return Object.freeze(origins);
}

export function createRequestOriginPolicy({publicOrigin,proxyOrigins,tls,crossSiteNavigationPaths=[]}={}){
 const origins=validateProxyOrigins(proxyOrigins),scheme=tls?'https':'http',allowed=new Map();
 const add=(host,origin)=>{if(!allowed.has(host))allowed.set(host,new Set());allowed.get(host).add(origin);};
 const direct=publicOrigin?new URL(publicOrigin):null;
 if(direct){add(direct.host,`${scheme}://${direct.host}`);add(direct.host,publicOrigin);}
 for(const origin of origins){const url=new URL(origin);if(direct&&direct.host===url.host&&direct.origin!==origin)throw new Error('Conflicting proxy origin for the direct host');add(url.host,origin);}
 return Object.freeze({accepts(req){
  const headers=req?.headers||{},host=headers.host,origin=headers.origin,site=headers['sec-fetch-site'];
  const navigation=['GET','HEAD'].includes(req.method)&&headers['sec-fetch-mode']==='navigate'&&headers['sec-fetch-dest']==='document'&&(req.url==='/'||req.url==='/?github=complete'||crossSiteNavigationPaths.includes(String(req.url).split('?')[0]))&&origin===undefined;
  if(typeof host!=='string'||origin!==undefined&&typeof origin!=='string'||site!==undefined&&typeof site!=='string'||site==='cross-site'&&!navigation)return false;
  const port=req?.socket?.localPort,loopback=Number.isInteger(port)&&port>0&&port<=65535&&(host===`127.0.0.1:${port}`||host===`localhost:${port}`);
  if(!loopback&&!allowed.has(host))return false;
  return origin===undefined||allowed.get(host)?.has(origin)===true||loopback&&origin===`${scheme}://${host}`;
 }});
}
