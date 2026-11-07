// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Collector delivery is evidence about reporting, never a machine power probe.
export function sourceConnection(host={}){
 const status=host.status,at=host.receivedAt||null;
 if(status==='online')return {label:host.role==='hub'?'Hub reporting':'Reporting',detail:'Recent source report received. This is collector/telemetry delivery, not proof of every worker state.',at,needsSetup:false};
 if(status==='not connected')return {label:'Collector not reporting',detail:'No source report received in this hub runtime. Opening the dashboard only displays data. Install and start the collector on the computer you want to observe; an administrator supplies its enrollment package.',at,needsSetup:true};
 if(status==='disconnected')return {label:'Source reports stopped',detail:'A previous source report aged out. The collector, its network path or hub receipt needs checking. Machine power state is unknown.',at,needsSetup:false};
 if(status==='stale')return {label:'Source reports late',detail:'The most recent source report is late. Machine power and current worker activity are unknown.',at,needsSetup:false};
 return {label:status==='disabled'?'Source access disabled':status==='expired'?'Source access expired':'Source status unknown',detail:'No current source-delivery claim. Machine power state is not observed.',at,needsSetup:false};
}

