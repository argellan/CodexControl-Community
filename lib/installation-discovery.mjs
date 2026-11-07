// Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
// Discovery carries public hints only. Pairing must independently authenticate every candidate.
import dgram from 'node:dgram';
import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
import {installationName} from '../public/installation-identity.mjs';

const SERVICE='_argellan-cc._tcp.local', MAX_PACKET=4096, TTL=120;
const decoder=new TextDecoder('utf-8',{fatal:true});
const clean=(value,max=120)=>typeof value==='string'&&value.length>0&&value.isWellFormed()&&Buffer.byteLength(value)<=max&&!/[\x00-\x1f\x7f-\x9f]/.test(value);
function checkIdentity(identity){let fullName;try{fullName=installationName(identity?.name);}catch{throw new Error('Valid public installation identity required');}if(!identity||!clean(identity.id,100)||!clean(identity.hostId,100)||!['standalone','hub','node'].includes(identity.role))throw new Error('Valid public installation identity required');return {...identity,name:fullName};}
// Public discovery is an untrusted hint. Authenticated pairing retains the full product name.
function discoveryName(fullName){let hint='',bytes=0;for(const point of fullName){const size=Buffer.byteLength(point);if(bytes+size>120)break;hint+=point;bytes+=size;}return hint;}
const u16=value=>{const b=Buffer.alloc(2);b.writeUInt16BE(value);return b;};
const u32=value=>{const b=Buffer.alloc(4);b.writeUInt32BE(value);return b;};
function name(value){const labels=value.replace(/\.$/,'').split('.');if(labels.some(label=>!label||Buffer.byteLength(label)>63))throw new Error('Invalid DNS name');return Buffer.concat([...labels.flatMap(label=>[Buffer.from([Buffer.byteLength(label)]),Buffer.from(label)]),Buffer.from([0])]);}
function readName(packet,offset){let cursor=offset,end=null,length=0;const seen=new Set(),labels=[];for(let hops=0;hops<128;hops++){if(cursor>=packet.length||seen.has(cursor))throw new Error('Invalid DNS name pointer');seen.add(cursor);const size=packet[cursor++];if((size&0xc0)===0xc0){if(cursor>=packet.length)throw new Error('Truncated DNS pointer');const pointer=((size&63)<<8)|packet[cursor++];end??=cursor;cursor=pointer;continue;}if(size&0xc0||size>63||cursor+size>packet.length)throw new Error('Invalid DNS label');if(size===0)return {value:labels.join('.'),end:end??cursor};const label=decoder.decode(packet.subarray(cursor,cursor+size));if(/[\x00-\x1f\x7f-\x9f]/.test(label))throw new Error('Invalid DNS label text');labels.push(label);length+=size+1;if(length>254)throw new Error('DNS name exceeds bound');cursor+=size;}throw new Error('DNS pointer exceeds bound');}
function parse(packet){
 if(!Buffer.isBuffer(packet)||packet.length<12||packet.length>MAX_PACKET)throw new Error('Packet size exceeds bound');
 if(packet.readUInt16BE(2)&0x7a0f)throw new Error('Unsupported DNS opcode, truncation or response code');
 const counts=[4,6,8,10].map(offset=>packet.readUInt16BE(offset));
 if(counts.reduce((a,b)=>a+b,0)>64)throw new Error('Record count exceeds bound');
 let cursor=12;const questions=[],records=[];
 for(let i=0;i<counts[0];i++){
  const q=readName(packet,cursor);cursor=q.end;if(cursor+4>packet.length)throw new Error('Truncated question');
  questions.push({name:q.value,type:packet.readUInt16BE(cursor),class:packet.readUInt16BE(cursor+2)});cursor+=4;
 }
 for(let i=0;i<counts[1]+counts[2]+counts[3];i++){
  const n=readName(packet,cursor);cursor=n.end;if(cursor+10>packet.length)throw new Error('Truncated record');
  const type=packet.readUInt16BE(cursor),classBits=packet.readUInt16BE(cursor+2),rrclass=classBits&0x7fff,ttl=packet.readUInt32BE(cursor+4),size=packet.readUInt16BE(cursor+8),start=cursor+10,end=start+size;
  if(end>packet.length)throw new Error('Truncated record data');let value;
  if(type===12){const result=readName(packet,start);if(result.end!==end)throw new Error('Invalid PTR');value=result.value;}
  else if(type===33){if(size<7)throw new Error('Invalid SRV');const target=readName(packet,start+6);if(target.end!==end)throw new Error('Invalid SRV target');value={port:packet.readUInt16BE(start+4),target:target.value};}
  else if(type===16){
   value=Object.create(null);let index=start;
   while(index<end){const count=packet[index++];if(index+count>end)throw new Error('Invalid TXT');const part=decoder.decode(packet.subarray(index,index+count)),equal=part.indexOf('=');if(/[\x00-\x1f\x7f-\x9f]/.test(part))throw new Error('Invalid TXT text');index+=count;if(equal<1)continue;const key=part.slice(0,equal);if(Object.hasOwn(value,key))throw new Error('Duplicate TXT key');value[key]=part.slice(equal+1);}
  }else if(type===1&&size===4)value=[...packet.subarray(start,end)].join('.');
  else if(type===28&&size===16)value=Array.from({length:8},(_,j)=>packet.readUInt16BE(start+j*2).toString(16)).join(':');
  if(value!==undefined&&rrclass===1)records.push({name:n.value,type,ttl,value,cacheFlush:Boolean(classBits&0x8000)});cursor=end;
 }
 if(cursor!==packet.length)throw new Error('Trailing DNS data');
 return {response:Boolean(packet.readUInt16BE(2)&0x8000),questions,records};
}
function record(owner,type,data,ttl){return Buffer.concat([name(owner),u16(type),u16(type===12?1:0x8001),u32(ttl),u16(data.length),data]);}
function ipBytes(address){if(isIP(address)===4)return Buffer.from(address.split('.').map(Number));const segments=address.toLowerCase().split('::');let left=segments[0]?segments[0].split(':'):[],right=segments[1]?segments[1].split(':'):[];const expand=list=>list.flatMap(part=>part.includes('.')?[((Number(part.split('.')[0])<<8)|Number(part.split('.')[1])).toString(16),((Number(part.split('.')[2])<<8)|Number(part.split('.')[3])).toString(16)]:[part]);left=expand(left);right=expand(right);const parts=segments.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left;return Buffer.concat(parts.map(part=>u16(parseInt(part,16))));}
function advertisement(identity,address,port,ttl){const suffix=createHash('sha256').update(identity.id+'\0'+identity.hostId).digest('hex').slice(0,24),instance=`cc-${suffix}.${SERVICE}`,target=`cc-${suffix}.local`;const txt={id:identity.id,role:identity.role,name:discoveryName(identity.name),v:'1'};const fields=Object.entries(txt).map(([key,value])=>{const field=Buffer.from(`${key}=${value}`);if(field.length>255)throw new Error('Discovery TXT exceeds bound');return field;});const records=[record(SERVICE,12,name(instance),ttl),record(instance,33,Buffer.concat([u16(0),u16(0),u16(port),name(target)]),ttl),record(instance,16,Buffer.concat(fields.flatMap(field=>[Buffer.from([field.length]),field])),ttl),record(target,isIP(address)===4?1:28,ipBytes(address),ttl)];const header=Buffer.alloc(12);header.writeUInt16BE(0x8400,2);header.writeUInt16BE(records.length,6);const packet=Buffer.concat([header,...records]);if(packet.length>MAX_PACKET)throw new Error('Packet size exceeds bound');return packet;}
function query(){const header=Buffer.alloc(12);header.writeUInt16BE(1,4);return Buffer.concat([header,name(SERVICE),u16(12),u16(1)]);}
function abortError(){const error=new Error('Discovery canceled');error.name='AbortError';return error;}

// No socket is created unless a caller explicitly authorizes real multicast.
export class MdnsTransport{
 constructor({enabled=false}={}){this.enabled=enabled;this.sockets=[];this.failures=0;this.closed=false;}
 async open({onMessage,interfaces}={}){if(!this.enabled)throw new Error('Multicast is disabled');if(this.sockets.length||this.closed)throw new Error('Transport already opened or closed');const adapters=interfaces??[{family:'IPv4'},{family:'IPv6'}];if(!Array.isArray(adapters)||adapters.length>16)throw new Error('At most 16 multicast interfaces permitted');for(const adapter of adapters){if(!['IPv4','IPv6'].includes(adapter.family)){this.failures++;continue;}const ipv6=adapter.family==='IPv6',group=ipv6?'ff02::fb':'224.0.0.251',socket=dgram.createSocket({type:ipv6?'udp6':'udp4',reuseAddr:true,ipv6Only:ipv6});try{await new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(5353,ipv6?'::':'0.0.0.0',()=>{socket.removeListener('error',reject);resolve();});});socket.on('error',()=>{this.failures++;});socket.setMulticastTTL(255);socket.setMulticastLoopback(true);socket.addMembership(group,adapter.address);if(adapter.address)socket.setMulticastInterface(adapter.address);socket.on('message',(packet,rinfo)=>{if(!this.closed)onMessage(packet,rinfo);});this.sockets.push({socket,group,family:adapter.family});}catch{this.failures++;try{socket.close();}catch{}}}if(!this.sockets.length)throw new Error('No multicast interface available');}
 async send(packet){if(this.closed||packet.length>MAX_PACKET)return;await Promise.all(this.sockets.map(({socket,group})=>new Promise(resolve=>{try{socket.send(packet,5353,group,error=>{if(error)this.failures++;resolve();});}catch{this.failures++;resolve();}})));}
 status(){return {families:[...new Set(this.sockets.map(item=>item.family))],interfaceFailures:this.failures,synthetic:false};}
 async close(){this.closed=true;await Promise.all(this.sockets.splice(0).map(({socket})=>new Promise(resolve=>{try{socket.close(resolve);}catch{resolve();}})));}
}

export class InstallationDiscovery{
 constructor({identity,transport,now=Date.now,maxCandidates=64,enableMulticast=false}={}){this.identity=checkIdentity(identity);if(!Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>256)throw new Error('Candidate bound must be 1 through 256');this.transport=transport??new MdnsTransport({enabled:enableMulticast});this.now=now;this.maxCandidates=maxCandidates;this.records=new Map();this.available=false;this.started=false;this.closed=false;this.sequence=0;this.browsing=false;this.waiters=new Set();this.lastResponse=-Infinity;this.rejectedPackets=0;this.packetWindow=-Infinity;this.packetCount=0;}
 async start({advertise=false,pairable=false,port,address,listen=true,interfaces}={}){if(this.started||this.closed)throw new Error('Discovery already started or closed');this.started=true;this.advertise=Boolean(advertise);this.pairable=Boolean(pairable);this.port=port;this.address=address;if(this.advertise&&(!isIP(address)||!Number.isInteger(port)||port<1||port>65535))throw new Error('Advertising requires literal IPv4/IPv6 address and valid port');if(!listen){this.reason='disabled';return this.status();}try{await this.transport.open({onMessage:(packet,rinfo)=>this.receive(packet,rinfo),interfaces});this.available=true;}catch{this.reason='discovery-unavailable';await this.transport.close();return this.status();}if(this.shouldAdvertise())await this.sendAdvertisement(TTL);return this.status();}
 shouldAdvertise(){return this.available&&!this.closed&&this.advertise&&(this.identity.role==='hub'||this.identity.role==='node'&&this.pairable);}
 async sendAdvertisement(ttl){await this.transport.send(advertisement(this.identity,this.address,this.port,ttl));}
 receive(packet){
  if(this.closed||!this.available)return;const time=this.now();
  if(time-this.packetWindow>=1000){this.packetWindow=time;this.packetCount=0;}
  if(++this.packetCount>128){this.rejectedPackets++;return;}
  try{
   const decoded=parse(packet);
   if(!decoded.response){
    if(this.shouldAdvertise()&&time-this.lastResponse>=1000&&decoded.questions.some(item=>item.name.toLowerCase()===SERVICE&&[12,255].includes(item.type)&&(item.class&0x7fff)===1)){
     this.lastResponse=time;void this.sendAdvertisement(TTL).catch(()=>{this.reason='send-failed';});
    }return;
   }
   this.prune();
   const incoming=decoded.records.filter(item=>item.name.toLowerCase()===SERVICE&&item.type===12||item.name.toLowerCase().endsWith('.'+SERVICE)&&[16,33].includes(item.type)||item.name.toLowerCase().endsWith('.local')&&[1,28].includes(item.type));
   const keyOf=item=>JSON.stringify([item.name.toLowerCase(),item.type,item.value]);
   const keys=new Set(incoming.map(keyOf));
   for(const record of incoming.filter(item=>item.cacheFlush&&item.ttl>0)){
    for(const [key,previous]of this.records)if(previous.name.toLowerCase()===record.name.toLowerCase()&&previous.type===record.type&&!keys.has(key))this.records.delete(key);
   }
   for(const item of incoming){const key=keyOf(item);if(item.ttl===0)this.records.delete(key);else if(this.records.has(key)||this.records.size<512)this.records.set(key,{...item,expiresAt:time+Math.min(item.ttl,TTL)*1000});}
  }catch{this.rejectedPackets++;}
 }
 prune(){const time=this.now();for(const [key,item]of this.records)if(item.expiresAt<=time)this.records.delete(key);}
 candidates(){this.prune();const records=[...this.records.values()],find=(owner,type)=>records.filter(item=>item.name.toLowerCase()===owner.toLowerCase()&&item.type===type);const found=[];const selfSuffix=createHash('sha256').update(this.identity.id+'\0'+this.identity.hostId).digest('hex').slice(0,24);for(const ptr of find(SERVICE,12)){const instance=ptr.value;if(instance.toLowerCase()===`cc-${selfSuffix}.${SERVICE}`)continue;const txt=find(instance,16).sort((a,b)=>b.expiresAt-a.expiresAt)[0],srv=find(instance,33).sort((a,b)=>b.expiresAt-a.expiresAt)[0];if(!txt||!srv)continue;const data=txt.value;if(data.v!=='1'||!clean(data.id,100)||!clean(data.name,120)||!['hub','node'].includes(data.role)||!srv.value.port)continue;for(const addressRecord of records.filter(item=>[1,28].includes(item.type)&&item.name.toLowerCase()===srv.value.target.toLowerCase())){const address=addressRecord.value;if(!isIP(address)||address==='0.0.0.0'||address==='0:0:0:0:0:0:0:0'||/^f[ef][89ab]/i.test(address)||address.startsWith('ff')||/^(22[4-9]|23\d)\./.test(address))continue;const literal=isIP(address)===6?`[${new URL(`https://[${address}]`).hostname.slice(1,-1)}]`:address;found.push({id:data.id,name:data.name,role:data.role,address:`https://${literal}:${srv.value.port}`,expiresAt:Math.min(ptr.expiresAt,txt.expiresAt,srv.expiresAt,addressRecord.expiresAt),instance,untrusted:true});}}const unique=[...new Map(found.map(item=>[item.id+'\0'+item.address+'\0'+item.instance,item])).values()];return unique.slice(0,this.maxCandidates).map(({instance,...item})=>({...item,collision:item.id===this.identity.id||unique.some(other=>other.id===item.id&&other.instance!==instance)}));}
 status(){return {available:this.available&&!this.closed,state:this.closed?'closed':this.available?'ready':this.reason??'not-started',manualAddressAvailable:true,untrusted:true,candidateCount:this.candidates().length,rejectedPackets:this.rejectedPackets,...this.transport.status?.(),ipv6LinkLocal:'not-supported-without-explicit-interface-scope'};}
 async browse({role,signal,timeoutMs=700}={}){if(signal?.aborted)throw abortError();if(this.browsing)throw new Error('Discovery browse already in progress');if(role!==undefined&&!['hub','node'].includes(role))throw new Error('Invalid discovery role');if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw new Error('Browse timeout must be 1 through 5000 ms');const targetRole=role??(this.identity.role==='hub'?'node':'hub');if(!this.available||this.closed)return [];this.browsing=true;const sequence=this.sequence,start=Date.now();try{for(const delay of [0,100,200]){if(delay)await this.delay(Math.min(delay,Math.max(0,timeoutMs-(Date.now()-start))),signal);if(signal?.aborted)throw abortError();if(this.closed||sequence!==this.sequence||Date.now()-start>=timeoutMs)break;await this.transport.send(query());}const remaining=timeoutMs-(Date.now()-start);if(remaining>0&&!this.closed)await this.delay(remaining,signal);if(signal?.aborted)throw abortError();return this.closed?[]:this.candidates().filter(item=>item.role===targetRole);}finally{this.browsing=false;}}
 delay(ms,signal){return new Promise((resolve,reject)=>{const complete=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.waiters.delete(complete);resolve();},abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.waiters.delete(complete);reject(abortError());},timer=setTimeout(complete,ms);this.waiters.add(complete);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});}
 async update({identity,pairable}={}){const next=identity?checkIdentity(identity):this.identity;if(next.id!==this.identity.id||next.hostId!==this.identity.hostId)throw new Error('Discovery cannot replace immutable identity');if(this.shouldAdvertise())await this.sendAdvertisement(0);this.identity=next;if(pairable!==undefined)this.pairable=Boolean(pairable);if(this.shouldAdvertise())await this.sendAdvertisement(TTL);return this.status();}
 async close(){if(this.closed)return;this.closed=true;this.available=false;this.sequence++;for(const complete of this.waiters)complete();this.records.clear();await this.transport.close();}
}


