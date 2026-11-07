// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Token identity is independent of brand, source-event categories and alerts.
// Cached input is a subset of inclusive input; these colors never imply money.
export const TOKEN_PALETTE_OPTIONS=Object.freeze({semantic:'Semantic · gold / coral / teal',coins:'Original · gold / silver / magenta'});
const types={
 input:{field:'uncachedInputTokens',label:'New input',glyph:'I',pattern:'solid',dash:'',className:'burn-input'},
 output:{field:'outputTokens',label:'Output',glyph:'O',pattern:'dashed',dash:'7 4',className:'burn-output'},
 cached:{field:'cachedInputTokens',label:'Cached input',glyph:'C',pattern:'dotted',dash:'1 5',className:'burn-cache'}
};
const definitions={
 semantic:{dark:['#F5C451','#FF8475','#2DD4BF'],light:['#8A5A00','#B73D36','#0F766E'],names:['Gold','Coral','Teal']},
 coins:{dark:['#FFD15C','#DCE6F2','#ED67FF'],light:['#875900','#475569','#9C287F'],names:['Gold','Silver','Magenta']}
};
const palettes={};
for(const [name,definition] of Object.entries(definitions))for(const theme of ['dark','light']){
 const series=Object.freeze(Object.fromEntries(Object.entries(types).map(([kind,type],index)=>[kind,Object.freeze({...type,color:definition[theme][index],colorName:definition.names[index]})])));
 const legend=Object.freeze(Object.entries(series).map(([kind,value])=>Object.freeze({kind,...value})));
 palettes[name+':'+theme]=Object.freeze({id:name+':'+theme,name,theme,face:theme==='light'?'#FBFDFF':'#101722',series,legend,
  description:legend.map(value=>`${value.glyph} / ${value.colorName}: ${value.label.toLowerCase()}, ${value.pattern} line`).join('; ')});
}
export const DEFAULT_TOKEN_PALETTE=palettes['semantic:dark'];
export function getTokenPalette(name='semantic',theme='dark'){return palettes[(name==='coins'?'coins':'semantic')+':'+(theme==='light'?'light':'dark')];}
const applied=new WeakMap();
// Called only when saved presentation preferences/theme change, never per frame.
export function applyTokenPalette(root,name='semantic',theme='dark'){
 const palette=getTokenPalette(name,theme);if(applied.get(root)===palette)return palette;
 root.dataset.tokenPalette=palette.name;
 for(const [kind,series] of Object.entries(palette.series))root.style.setProperty('--token-'+kind,series.color);
 root.style.setProperty('--token-face',palette.face);applied.set(root,palette);return palette;
}
