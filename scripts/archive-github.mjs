// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {DatabaseSync} from 'node:sqlite';
import {gzipSync} from 'node:zlib';
import {installGitHubArchive,selectGitHubArchiveBatch,acknowledgeGitHubArchive,githubArchiveStatus} from '../lib/github-archive.mjs';
import {loadArchiveSenderConfig,sendArchiveOverSsh,receiptOf} from './archive-usage.mjs';

// Shares the existing pinned, forced-command transport and exact receipt
// validation. This family has its own immutable journal and pending batch.
export async function archiveGitHubOnce({file,configFile},{load=loadArchiveSenderConfig,send=sendArchiveOverSsh}={}) {
  const db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL;');installGitHubArchive(db);
  try{
    db.prepare("INSERT OR REPLACE INTO archive_health VALUES(1,?,NULL)").run(new Date().toISOString());
    const config=await load(configFile),batch=selectGitHubArchiveBatch(db);
    if(batch){
      const compressed=gzipSync(Buffer.from(batch.body),{level:1});
      const raw=await send({config,compressed});
      acknowledgeGitHubArchive(db,batch,receiptOf(raw,batch,compressed,config.receiverId));
    }
    return githubArchiveStatus(db);
  }catch{
    db.prepare("INSERT OR REPLACE INTO archive_health VALUES(1,?,'archive_unavailable')").run(new Date().toISOString());
    return githubArchiveStatus(db);
  }finally{db.close();}
}
