// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {validateArchiveSenderConfig} from '../scripts/archive-usage.mjs';
import {validateHistoricalAnalyticsConfig} from '../lib/historical-analytics.mjs';
const local={python:process.execPath,script:path.resolve('TEST_ONLY-receiver.py'),config:path.resolve('TEST_ONLY-receiver.json')};
const receiverId='70105d47-af72-42fb-a835-97e2509d28b8';
test('native local archive transport does not require SSH credentials',()=>{
 const config=validateArchiveSenderConfig({version:1,database:path.resolve('TEST_ONLY.sqlite'),receiverId,local});
 assert.deepEqual(config.local,local);assert.equal(Object.hasOwn(config,'ssh'),false);
});
test('local transport rejects ambiguous remote/local and UNC or relative paths',()=>{
 for(const bad of [{...local,python:'python'},{...local,config:'\\\\server\\share\\receiver.json'},{...local,command:'arbitrary'}])assert.throws(()=>validateArchiveSenderConfig({version:1,database:path.resolve('TEST_ONLY.sqlite'),receiverId,local:bad}));
 assert.throws(()=>validateArchiveSenderConfig({version:1,database:path.resolve('TEST_ONLY.sqlite'),receiverId,local,ssh:{}}));
});
test('native historical analytics uses the same receiver binding with no SSH identity',()=>{
 const config=validateHistoricalAnalyticsConfig({version:1,engine:'duckdb',expectedReceiverId:receiverId,local});
 assert.deepEqual(config.local,local);assert.equal(Object.hasOwn(config,'ssh'),false);
 assert.throws(()=>validateHistoricalAnalyticsConfig({version:1,engine:'duckdb',expectedReceiverId:receiverId,local:{...local,config:'relative'}}));
});
