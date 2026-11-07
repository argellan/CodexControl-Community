// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const read=relative=>fs.readFile(new URL(relative,import.meta.url),'utf8');
test('Community installer has a native offline runtime and payload contract',async()=>{
 const contract=JSON.parse(await read('../release/windows/installer-contract.json'));
 assert.equal(contract.edition,'Community');assert.equal(contract.version,'0.1.0');
 assert.equal(contract.platform,'win32-x64');assert.equal(contract.requiresWsl,false);
 assert.equal(contract.requiresVirtualMachine,false);assert.equal(contract.requiresContainer,false);
 assert.deepEqual(contract.bundledRuntimes.sort(),['node','python']);
 assert.equal(contract.privateDataOutsideApplication,true);assert.equal(contract.uninstallPreservesData,true);
 assert.equal(contract.archiveTransport,'local-native');assert.equal(contract.repoVisibility,'private');
});
test('Installer provides a native executable build and bounded local qualification entry points',async()=>{
 const source=await read('../release/windows/Installer.cs');
 assert.match(source,/static int Main/);assert.match(source,/SHA256/);
 assert.match(source,/ZipArchive/);assert.match(source,/TEST_ONLY/);
 const build=await read('../scripts/build-windows-installer.mjs');
 assert.match(build,/win32/);assert.match(build,/0\.1\.0/);
});
