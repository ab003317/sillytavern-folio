export const USAGE_LIMIT=20;
export const USAGE_KEY='folio_usage';
export const RESPONSE_KEY='folio_usage_id';

// Reply identity must survive edits, hiding and continuation. Swipe identity is
// separate: navigating back to an older variant restores that variant's receipt.
export function responseKey(message){return typeof message?.extra?.[RESPONSE_KEY]==='string'?`${message.extra[RESPONSE_KEY]}:${message.swipe_id??0}`:'';}
export function bindResponse(message,index,stamp,id,{fresh=false}={}){
    message.extra??={};
    if(fresh||!message.extra[RESPONSE_KEY])message.extra[RESPONSE_KEY]=id;
    const swipe=message.swipe_id??0,info=message.swipe_info?.[swipe];
    if(info){info.extra??={};info.extra[RESPONSE_KEY]=message.extra[RESPONSE_KEY];}
    return {messageId:message.extra[RESPONSE_KEY],swipeId:swipe,sourceStamp:stamp,index,boundAt:Date.now()};
}

export function usageOverview(record) {
    const bodies=(record?.items??[]).filter(x=>x.role!=='user'),kept=bodies.filter(x=>x.final===true);
    const selected=new Set((record?.candidates??[]).filter(x=>x.selected).map(x=>x.index));
    const recalled=kept.filter(x=>!x.recent&&selected.has(x.index)).length,recent=kept.filter(x=>x.recent).length;
    return {bodies:kept.length,recalled,recent,retained:kept.length-recalled-recent,partials:kept.filter(x=>x.partial).length,unverified:bodies.length-kept.length,
        players:(record?.items??[]).filter(x=>x.role==='user'&&x.final===true).length,selected:selected.size,skipped:record?.skipped?.length??0};
}

// Use associations saved for that request, never today's shifted floor numbers.
// Older receipts did not save pageIndex, so fall back only to their own item order.
export function playerOwner(record,item) {
    if(item.pageIndex!==undefined)return item.pageIndex;
    return record.items.filter(x=>x.role!=='user'&&x.index>item.index).sort((a,b)=>a.index-b.index)[0]?.index;
}

export function mergeUsage(...groups) {
    const byId=new Map();
    for(const record of groups.flat()){
        if(!record?.id||record.preview||record.stage!=='observed'||!record.final||!Array.isArray(record.items)||(record.receiptVersion>=2&&!record.result))continue;
        const old=byId.get(record.id);
        const newer=(record.final.observedAt??0)-(old?.final.observedAt??0);
        const binding=r=>(r?.result?.messageId?2:r?.result?1:0);
        if(!old||newer>0||(newer===0&&(binding(record)>binding(old)||(binding(record)===binding(old)&&(record.result?.boundAt??0)>(old.result?.boundAt??0)))))byId.set(record.id,record);
    }
    const byTime=(a,b)=>(b.final.observedAt??b.createdAt)-(a.final.observedAt??a.createdAt),ordered=[...byId.values()].sort(byTime);
    // Legacy request-only entries must not evict proven reply-bound receipts.
    return [...ordered.filter(r=>r.result),...ordered.filter(r=>!r.result)].slice(0,USAGE_LIMIT).sort(byTime);
}

// Historical item positions stay historical. Never resolve old items by their floor index.
export function usageView(records,stamps,roles=[],chat=[]) {
    const positions=new Map();
    for(const [i,stamp]of stamps.entries()){
        if(!positions.has(stamp))positions.set(stamp,[]);positions.get(stamp).push(i);
    }
    const anchors=new Map();for(const [i,m]of chat.entries())if(roles[i]==='assistant'&&responseKey(m)){const key=responseKey(m);if(!anchors.has(key))anchors.set(key,[]);anchors.get(key).push(i);}
    const inferredTargets=new Map();
    for(const r of records)if(r.receiptVersion!==2&&!r.result?.sourceStamp&&Array.isArray(r.stamps)&&r.stamps.every((s,i)=>stamps[i]===s)&&roles[r.stamps.length]==='assistant')inferredTargets.set(r.stamps.length,(inferredTargets.get(r.stamps.length)??0)+1);
    return records.map(record=>{
        const resultStamp=record.result?.sourceStamp,anchor=record.result?.messageId?`${record.result.messageId}:${record.result.swipeId??0}`:'';
        const resultPositions=anchor?(anchors.get(anchor)??[]):resultStamp?(positions.get(resultStamp)??[]):[];
        const expected=record.stamps?.length,prefix=Array.isArray(record.stamps)&&record.stamps.every((stamp,i)=>stamps[i]===stamp);
        const inferred=record.receiptVersion!==2&&!resultStamp&&prefix&&expected<stamps.length&&roles[expected]==='assistant'&&inferredTargets.get(expected)===1;
        const resultState=resultStamp?(resultPositions.length===1?'present':resultPositions.length?'ambiguous':'missing'):(inferred?'present':'unbound');
        return {...record,resultState,resultIndex:resultPositions.length===1?resultPositions[0]:inferred?expected:null,
        sourceChanged:!Array.isArray(record.stamps)||record.stamps.some((stamp,i)=>stamps[i]!==stamp),
        items:record.items.map(item=>{
            const stamp=item.sourceStamp??record.stamps?.[item.index],found=positions.get(stamp)??[];
            return {...item,sourceState:!stamp?'unknown':found.length===1?'present':found.length?'ambiguous':'missing',currentIndex:found.length===1?found[0]:null};
        }),
    };});
}
