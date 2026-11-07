// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createPrivateKey,X509Certificate} from 'node:crypto';
import * as tlsFixture from './fixtures/transport-tls.mjs';

test('TLS fixture generates fresh matching keys and localhost certificates without embedded material',()=>{
 assert.equal(typeof tlsFixture.createTestOnlyTlsFixture,'function');
 const a=tlsFixture.createTestOnlyTlsFixture(),b=tlsFixture.createTestOnlyTlsFixture();
 assert.equal(a.key===b.key,false);assert.notEqual(a.pin,b.pin);
 const certificate=new X509Certificate(a.cert),wrong=new X509Certificate(a.wrongCa);
 assert.equal(certificate.checkPrivateKey(createPrivateKey(a.key)),true);
 assert.equal(certificate.verify(certificate.publicKey),true);
 assert.equal(certificate.verify(wrong.publicKey),false);
 assert.equal(certificate.checkHost('localhost'),'localhost');
 assert.equal(certificate.checkIP('127.0.0.1'),undefined);
 assert.ok(Date.parse(certificate.validFrom)<=Date.now());
 assert.ok(Date.parse(certificate.validTo)>Date.now());
 assert.ok(Date.parse(certificate.validTo)-Date.parse(certificate.validFrom)<=2*86400000);
 const source=fs.readFileSync(new URL('./fixtures/transport-tls.mjs',import.meta.url),'utf8');
 assert.equal(source.includes(['-----BEGIN','PRIVATE KEY-----'].join(' ')),false);
 assert.equal(/child_process|writeFile|execFile|spawn\(/.test(source),false);
});
