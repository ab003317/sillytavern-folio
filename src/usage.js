export const USAGE_LIMIT=20;

export function mergeUsage(...groups) {
    const byId=new Map();
    for(const record of groups.flat()){
        if(!record?.id||record.preview||record.stage!=='observed'||!record.final||!Array.isArray(record.items))continue;
        const old=byId.get(record.id);
        if(!old||(record.final.observedAt??0)>(old.final.observedAt??0))byId.set(record.id,record);
    }
    return [...byId.values()].sort((a,b)=>(b.final.observedAt??b.createdAt)-(a.final.observedAt??a.createdAt)).slice(0,USAGE_LIMIT);
}

// Historical item positions stay historical. Never resolve old items by their floor index.
export function usageView(records,stamps) {
    const positions=new Map();
    for(const [i,stamp]of stamps.entries()){
        if(!positions.has(stamp))positions.set(stamp,[]);positions.get(stamp).push(i);
    }
    return records.map(record=>({...record,
        sourceChanged:!Array.isArray(record.stamps)||record.stamps.some((stamp,i)=>stamps[i]!==stamp),
        items:record.items.map(item=>{
            const stamp=item.sourceStamp??record.stamps?.[item.index],found=positions.get(stamp)??[];
            return {...item,sourceState:!stamp?'unknown':found.length===1?'present':found.length?'ambiguous':'missing',currentIndex:found.length===1?found[0]:null};
        }),
    }));
}
