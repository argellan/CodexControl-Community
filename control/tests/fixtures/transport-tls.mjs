// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// TEST_ONLY ephemeral localhost TLS fixture. Not an installation certificate.
// Uses built-in crypto only; no external tools, filesystem writes or trust-store changes.
// Private material exists only in the disposable test process, never in source.
import {generateKeyPairSync,randomBytes,sign,createHash,X509Certificate} from 'node:crypto';

const der=(tag,bytes)=>{const n=bytes.length,tail=[];for(let v=n;v>0;v=Math.floor(v/256))tail.unshift(v%256);return Buffer.concat([Buffer.from([tag,...(n<128?[n]:[0x80|tail.length,...tail])]),bytes]);};
const sequence=(...parts)=>der(0x30,Buffer.concat(parts));
const oid=hex=>der(0x06,Buffer.from(hex,'hex'));
const algorithm=()=>sequence(oid('2a8648ce3d040302'));
function certificateTime(value){const date=new Date(value),text=date.toISOString().replace(/[-:]/g,'').replace('T','').slice(0,14),utc=date.getUTCFullYear()>=1950&&date.getUTCFullYear()<2050;return der(utc?0x17:0x18,Buffer.from((utc?text.slice(2):text)+'Z'));}
function issue(subject){
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),serial=randomBytes(16);serial[0]=(serial[0]&0x7f)||1;
 const name=sequence(der(0x31,sequence(oid('550403'),der(0x0c,Buffer.from(subject))))),now=Date.now();
 const extensions=der(0xa3,sequence(
  sequence(oid('551d13'),der(0x01,Buffer.from([0xff])),der(0x04,sequence(der(0x01,Buffer.from([0xff]))))),
  sequence(oid('551d11'),der(0x04,sequence(der(0x82,Buffer.from('localhost')))))
 ));
 const tbs=sequence(der(0xa0,der(0x02,Buffer.from([2]))),der(0x02,serial),algorithm(),name,sequence(certificateTime(now-60000),certificateTime(now+86400000)),name,publicKey.export({type:'spki',format:'der'}),extensions);
 const raw=sequence(tbs,algorithm(),der(0x03,Buffer.concat([Buffer.from([0]),sign('sha256',tbs,privateKey)])));
 const cert='-----BEGIN CERTIFICATE-----\n'+raw.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----\n';
 if(!new X509Certificate(cert).checkPrivateKey(privateKey))throw Error('TEST_ONLY_CERTIFICATE_MISMATCH');
 return {privateKey,cert,pin:createHash('sha256').update(raw).digest('hex')};
}
export function createTestOnlyTlsFixture(){
 const server=issue('TEST_ONLY.localhost'),wrong=issue('TEST_ONLY.wrong-CA');
 return Object.freeze({key:server.privateKey.export({type:'pkcs8',format:'pem'}),cert:server.cert,wrongCa:wrong.cert,pin:server.pin});
}
const fixture=createTestOnlyTlsFixture();
export const TEST_ONLY_KEY=fixture.key,TEST_ONLY_CERT=fixture.cert,TEST_ONLY_WRONG_CA=fixture.wrongCa,TEST_ONLY_PIN=fixture.pin;
