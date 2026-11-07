/* Author: Bishop Crockett · Owner: Argellan.com · License: MIT · SPDX-License-Identifier: MIT */
const rows=context=>Array.isArray(context)?context:[context?.installation||context,...(context?.peers||context?.installation?.peers||[])].filter(Boolean);
const identities=row=>[row?.id,row?.installationId,row?.hostId].filter(value=>typeof value==='string'&&value);
/** Resolve names only by immutable identity; never by hostname or address. */
export function installationName(hostOrId,context={}){
 const id=typeof hostOrId==='string'?hostOrId:hostOrId?.hostId||hostOrId?.id;
 const all=rows(context),row=all.find(item=>identities(item).includes(id));
 const fallback=typeof hostOrId==='object'?(hostOrId.name||hostOrId.hostName||id):id;
 if(!row?.name)return fallback||'Unknown installation';
 const duplicates=all.filter(other=>other!==row&&other.name===row.name&&!identities(other).some(key=>identities(row).includes(key)));
 const stable=String(row.id||row.hostId),short=stable.slice(-8),suffix=duplicates.some(other=>String(other.id||other.hostId).slice(-8)===short)?stable:short;
 return duplicates.length?row.name+' · '+suffix:row.name;
}
/** Presentation projection only. Original input and immutable identity/provenance remain intact. */
export function presentInstallationNames(snapshot,status){
 if(!snapshot||!status)return snapshot;
 const project=(row,host=false)=>{const id=host?row.id:row.hostId||row.installationId;if(!id)return row;const known=rows(status).some(item=>identities(item).includes(id));if(!known)return row;const name=installationName(id,status),out={...row};if(host){out.provenanceHostName=row.provenanceHostName??row.name;out.name=name;}else{out.displayInstallationName=name;if(Object.hasOwn(row,'hostName')){out.provenanceHostName=row.provenanceHostName??row.hostName;out.hostName=name;}}return out;};
 const listKeys=['hosts','sessions','events','workers','sources','records','observations','entries','items','historyRecords','batches'];
 const visit=value=>{if(!value||typeof value!=='object'||Array.isArray(value))return value;const result={...project(value)};for(const key of listKeys)if(Array.isArray(value[key]))result[key]=value[key].map(row=>key==='hosts'?project(row,true):visit(row));for(const key of ['history','export','exports','page','data'])if(value[key]&&typeof value[key]==='object')result[key]=Array.isArray(value[key])?value[key].map(visit):visit(value[key]);return result;};
 return visit(snapshot);
}
