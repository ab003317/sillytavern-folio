import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/engine.js';
import {KEY,newRecord,sourceOf,validRecord,bookPages} from '../src/core.js';
import {sha256} from '../src/hash.js';
import {mergeUsage} from '../src/usage.js';

class MemoryCache {
    constructor(){this.data=new Map();this.owner=null;}
    async get(s,k){return structuredClone(this.data.get(s+k));}
    async put(s,k,v){this.data.set(s+k,structuredClone(v));}
    async putMany(s,entries){for(const [k,v]of entries)await this.put(s,k,v);}
    async appendUsage(identity,records){const merged=mergeUsage(records,await this.get('records','usage:'+identity)??[]);await this.put('records','usage:'+identity,merged);return merged;}
    async pruneRecords(identity,hashes){const prefix='records'+identity+':',keep=new Set(hashes);for(const key of this.data.keys())if(key.startsWith(prefix)&&!keep.has(key.slice(prefix.length)))this.data.delete(key);}
    async lease(k,o,release=false){if(release){if(this.owner===o)this.owner=null;return false;}if(this.owner&&this.owner!==o)return false;this.owner=o;return true;}
    close(){}
}
function message(text,i=0,user=false){return {mes:text,name:user?'玩家':'角色',is_user:user,send_date:`t${i}`,extra:{}};}
function ready(r){for(const p of bookPages(r.c.chat)){const x=newRecord(p.message,p.playerInput);x.summary=p.body;x.done=true;p.message.extra[KEY]=x;r.engine.vectors.set(r.engine.vectorKey(x),[[1,0]]);}}
function rig(messages=[message('港口的兩人交換信物，約定明日再見。')]) {
    const c={chat:messages,chatId:'a',mainApi:'openai',saveSettingsDebounced(){}};
    const settings={enabled:true};let calls=0,saves=0;
    const host={context:()=>c,identity:()=>c.chatId,settings:()=>settings,model:'fixture-mini',
        count:async text=>text.length,save:async()=>{saves++;},complete:async(system,prompt)=>{calls++;return '{"summary":"兩人在港口交換信物，約定明日再見。"}';}};
    const cache=new MemoryCache();
    const embedder={embed:async texts=>texts.map(()=>[1,0]),stop(){}};
    const engine=new Engine(host,cache,embedder);engine.schedule=()=>{};
    return {engine,host,cache,embedder,c,stats:()=>({calls,saves})};
}

test('manual refresh really calls summary while auto memory is paused, preserving the automatic setting',async()=>{
    const r=rig();await r.engine.tick();const before=r.stats().calls;r.engine.toggle(false);
    await r.engine.refresh(r.engine.snapshot().entries[0].ref);
    assert.equal(r.engine.snapshot().entries[0].previousSummary,true);assert.equal(r.engine.snapshot().rebuild.pending,1);
    await r.engine.tick();await r.engine.tick();
    assert.equal(r.stats().calls,before+1);assert.equal(r.host.settings().enabled,false);assert.equal(r.engine.snapshot().rebuild.complete,true);
    assert.equal(r.engine.snapshot().rebuild.vectors,1);assert.equal(r.engine.snapshot().entries[0].rebuilt,true);
});

test('requested page has priority over earlier unfinished pages',async()=>{
    const r=rig([message('最早待整理',0),message('指定末頁',1)]);let requested;
    r.host.complete=async(s,p)=>{requested=JSON.parse(p).text;return '{"summary":"重整了指定末頁"}';};
    await r.engine.refresh(r.engine.snapshot().entries[1].ref);await r.engine.tick();
    assert.equal(requested,'指定末頁');assert.equal(r.c.chat[0].extra[KEY],undefined);
    assert.equal(bookPages(r.c.chat)[1].record.summary,'重整了指定末頁');
});

test('one-click rebuild summarizes every selected existing page exactly once, preserves pins and raw chat',async()=>{
    const r=rig([message('玩家一',0,true),message('信件',1),message('玩家二',2,true),message('晚餐',3)]);ready(r);
    bookPages(r.c.chat)[0].record.pinned=true;const source=r.c.chat.map(m=>m.mes);
    await r.engine.refreshAll();for(let i=0;i<5;i++)await r.engine.tick();
    assert.equal(r.stats().calls,2);assert.deepEqual(r.c.chat.map(m=>m.mes),source);assert.equal(bookPages(r.c.chat)[0].record.pinned,true);
    assert.equal(r.engine.snapshot().rebuild.total,2);assert.equal(r.engine.snapshot().rebuild.done,2);assert.equal(r.engine.snapshot().rebuild.vectors,2);
    assert.equal(r.c.chat[0].extra[KEY],undefined);assert.equal(r.c.chat[2].extra[KEY],undefined);
});

test('duplicate click does not enqueue a second rebuild or multiply API cost',async()=>{
    const r=rig();ready(r);await r.engine.refreshAll();await assert.rejects(r.engine.refreshAll(),/已有重整任務/);
    await r.engine.tick();await r.engine.tick();assert.equal(r.stats().calls,1);
});

test('completed receipt from an older revision cannot replace a forced rebuild',async()=>{
    const r=rig();ready(r);const old=structuredClone(bookPages(r.c.chat)[0].record);
    await r.engine.refreshAll();await r.cache.put('records','a:'+old.hash,old);await r.engine.tick();
    assert.equal(r.stats().calls,1);assert.notEqual(bookPages(r.c.chat)[0].record.summary,old.summary);
});

test('manual rebuild resumes after reload with automatic memory off, without repeating completed pages',async()=>{
    const r=rig([message('第一頁',0),message('第二頁',1)]);ready(r);r.engine.toggle(false);await r.engine.refreshAll();await r.engine.tick();
    const other=new Engine(r.host,r.cache,r.embedder);other.schedule=()=>{};other.changed();
    await other.tick();await other.tick();await other.tick();
    assert.equal(r.stats().calls,2);assert.equal(other.snapshot().rebuild.complete,true);assert.equal(other.snapshot().rebuild.vectors,2);
    assert.equal(r.host.settings().enabled,false);
});

test('failed rebuild retains previous summary and stopping restores it without erasing chat',async()=>{
    const r=rig();ready(r);const old=bookPages(r.c.chat)[0].record.summary;r.engine.toggle(false);await r.engine.refreshAll();
    r.host.complete=async()=>{throw new Error('fixture unavailable');};await r.engine.tick();
    assert.equal(r.engine.snapshot().entries[0].summary,old);assert.equal(r.engine.snapshot().rebuild.pending,1);assert.match(r.engine.warning,/fixture unavailable/);
    await r.engine.stopRebuild();assert.equal(bookPages(r.c.chat)[0].record.done,true);assert.equal(bookPages(r.c.chat)[0].record.summary,old);
    assert.equal(r.engine.snapshot().rebuild.cancelled,1);await r.engine.tick();assert.equal(r.stats().calls,0);
});

test('stop keeps completed new summaries and restores only unfinished pages',async()=>{
    const r=rig([message('原第一頁',0),message('原第二頁',1)]);ready(r);r.engine.toggle(false);await r.engine.refreshAll();await r.engine.tick();await r.engine.stopRebuild();
    assert.match(bookPages(r.c.chat)[0].record.summary,/交換信物/);assert.equal(bookPages(r.c.chat)[1].record.summary,'原第二頁');
    assert.equal(r.engine.snapshot().rebuild.done,1);assert.equal(r.engine.snapshot().rebuild.cancelled,1);assert.equal(r.engine.snapshot().rebuild.complete,true);
});

test('delete queued page before processing skips it and never assigns its job to the next floor',async()=>{
    const r=rig([message('待刪頁',0),message('保留頁',1)]);ready(r);r.engine.toggle(false);await r.engine.refreshAll();
    r.c.chat.splice(0,1);r.engine.changed({deleted:true});await r.engine.tick();await r.engine.tick();
    assert.equal(r.stats().calls,1);assert.equal(r.engine.snapshot().rebuild.removed,1);assert.equal(r.engine.snapshot().rebuild.done,1);
});

test('rebuild waits for aborted in-flight summary before replacing its revision',async()=>{
    const r=rig();let finish;r.host.complete=()=>new Promise(resolve=>{finish=resolve;});
    const old=r.engine.tick();await new Promise(resolve=>setTimeout(resolve,0));const queued=r.engine.refreshAll();
    finish('{"summary":"stale result"}');await old;await queued;
    assert.equal(bookPages(r.c.chat)[0].record.done,false);assert.ok(bookPages(r.c.chat)[0].record.rebuild);
    r.host.complete=async()=>'{"summary":"new result"}';await r.engine.tick();assert.equal(bookPages(r.c.chat)[0].record.summary,'new result');
});

test('rebuild transaction failure leaves original summaries untouched and unlocks controls',async()=>{
    const r=rig();ready(r);const before=JSON.stringify(r.c.chat);r.cache.putMany=async()=>{throw Error('storage full');};
    await assert.rejects(r.engine.refreshAll(),/storage full/);assert.equal(JSON.stringify(r.c.chat),before);assert.equal(r.engine.resetting,false);assert.equal(r.cache.owner,null);
});

test('another tab lease or main generation gives a visible error before any reset',async()=>{
    const r=rig();ready(r);const before=JSON.stringify(r.c.chat);r.cache.owner='other';await assert.rejects(r.engine.refreshAll(),/另一個視窗/);
    assert.equal(JSON.stringify(r.c.chat),before);r.cache.owner=null;r.engine.generationStarted();await assert.rejects(r.engine.refreshAll(),/正文正在生成/);
    assert.equal(JSON.stringify(r.c.chat),before);await assert.rejects(r.engine.refreshAll('different-chat'),/聊天已切換/);
});

test('manual vector failure reports fallback and does not repeat paid summaries endlessly',async()=>{
    const r=rig();ready(r);r.engine.toggle(false);await r.engine.refreshAll();r.embedder.embed=async()=>{throw Error('wasm');};
    for(let i=0;i<4;i++)await r.engine.tick();assert.equal(r.stats().calls,1);assert.equal(r.engine.snapshot().rebuild.complete,true);
    assert.equal(r.engine.snapshot().rebuild.vectorFallback,true);assert.equal(r.engine.snapshot().rebuild.vectors,0);assert.match(r.engine.warning,/向量/);
});
test('background summary is idempotent across events and reopen',async()=>{
    const r=rig();await r.engine.tick();assert.equal(r.stats().calls,1);assert.ok(validRecord(r.c.chat[0]).done);
    await r.engine.tick();await r.engine.tick();r.engine.changed();await r.engine.tick();assert.equal(r.stats().calls,1);
    const engine=new Engine(r.host,r.cache,r.embedder);engine.schedule=()=>{};await engine.tick();assert.equal(r.stats().calls,1);
});
test('automatic progress reports pending pages, current phase, generation wait and completion',async()=>{
    const r=rig([message('第一頁',0),message('第二頁',1)]);
    r.host.complete=async(_system,prompt)=>{const text=JSON.parse(prompt).text;return JSON.stringify({summary:`${text}的摘要`});};
    r.engine.changed();let auto=r.engine.snapshot().auto;
    assert.equal(auto.active,true);assert.equal(auto.phase,'summary');assert.equal(auto.pendingSummaries,2);assert.equal(auto.done,0);assert.equal(auto.total,2);
    r.engine.generationStarted();auto=r.engine.snapshot().auto;assert.equal(auto.active,true);assert.equal(auto.waitingForGeneration,true);r.engine.generationEnded();
    await r.engine.tick();auto=r.engine.snapshot().auto;assert.equal(auto.ready,1);assert.equal(auto.pendingSummaries,1);assert.equal(auto.active,true);
    await r.engine.tick();auto=r.engine.snapshot().auto;assert.equal(auto.ready,2);assert.equal(auto.indexed,1);assert.equal(auto.active,true);
    await r.engine.tick();auto=r.engine.snapshot().auto;assert.equal(auto.active,false);assert.equal(auto.complete,true);assert.equal(auto.indexed,2);
    r.engine.toggle(false);assert.equal(r.engine.snapshot().auto.available,false);
});
test('save gap recovers completed receipt without calling model again',async()=>{
    const r=rig();await r.engine.tick();delete r.c.chat[0].extra[KEY];await r.engine.tick();assert.equal(r.stats().calls,1);assert.ok(validRecord(r.c.chat[0]).done);
});
test('partial long-body receipt resumes only missing segments',async()=>{
    const r=rig([message('長篇正文。'.repeat(1300))]);await r.engine.tick();assert.equal(r.stats().calls,1);assert.equal(validRecord(r.c.chat[0]).done,false);
    delete r.c.chat[0].extra[KEY];await r.engine.tick();assert.equal(r.stats().calls,2);assert.equal(validRecord(r.c.chat[0]).parts.length,2);
});
test('edits cause one new summary; reverting recovers its own cached version',async()=>{
    const r=rig();r.engine.changed();await r.engine.tick();const old=r.c.chat[0].mes;r.c.chat[0].mes='改為森林的情節';r.engine.changed();await r.engine.tick();assert.equal(r.stats().calls,2);
    r.c.chat[0].mes=old;r.engine.changed();await r.engine.tick();assert.equal(r.stats().calls,2);
});
test('chat switch while request is pending never writes stale data',async()=>{
    const r=rig();let resolve;r.host.complete=()=>new Promise(res=>{resolve=res;});
    const task=r.engine.tick();await new Promise(res=>setTimeout(res,0));
    const old=r.c.chat[0];r.c.chatId='b';r.c.chat=[message('新聊天')];r.engine.changed();resolve('{"summary":"舊摘要"}');await task;
    assert.equal(old.extra[KEY],undefined);assert.equal(r.c.chat[0].extra[KEY],undefined);
});
test('deleted/edited message during slow response cannot receive stale summary',async()=>{
    const r=rig();let resolve;r.host.complete=()=>new Promise(res=>{resolve=res;});
    const task=r.engine.tick();await new Promise(res=>setTimeout(res,0));r.c.chat[0].mes='已修改';resolve('{"summary":"舊摘要"}');await task;
    assert.equal(r.c.chat[0].extra[KEY],undefined);
});
test('two engine instances share transactional lease; only one model request',async()=>{
    const r=rig();let resolve, calls=0;r.host.complete=()=>{calls++;return new Promise(res=>{resolve=res;});};
    const other=new Engine(r.host,r.cache,r.embedder);other.schedule=()=>{};
    const first=r.engine.tick();await new Promise(res=>setTimeout(res,0));await other.tick();assert.equal(calls,1);
    resolve('{"summary":"記憶"}');await first;await other.tick();assert.equal(calls,1);
});
test('vector failure never causes a repeated summary and does not starve new pages',async()=>{
    const r=rig([message('第一頁'),message('第二頁',1)]);await r.engine.tick();r.embedder.embed=async()=>{throw Error('wasm');};await r.engine.tick();
    assert.equal(r.stats().calls,2);assert.ok(validRecord(r.c.chat[1]).done);
});
test('main generation and pause do not run background model calls',async()=>{
    const r=rig();r.engine.generationStarted();await r.engine.tick();assert.equal(r.stats().calls,0);
    r.engine.generationEnded();r.engine.toggle(false);await r.engine.tick();assert.equal(r.stats().calls,0);
});
test('invalid model JSON is not saved as completed memory',async()=>{
    const r=rig();r.host.complete=async()=>'{"summary":""}';await r.engine.tick();assert.equal(validRecord(r.c.chat[0]),null);assert.match(r.engine.status,/自動重試/);
});
test('vectors survive new-message events, while chat changes isolate them',()=>{
    const r=rig();r.engine.changed();r.engine.vectors.set('key',[[1]]);r.engine.changed();assert.ok(r.engine.vectors.has('key'));
    r.c.chatId='b';r.engine.changed();assert.equal(r.engine.vectors.size,0);
});
test('selection injects original bodies chronologically into coreChat only',async()=>{
    const source=Array.from({length:12},(_,i)=>message(`第${i}頁：`+(i===1?'港口船長信物':'日常飯食')+'情節。'.repeat(30),i,i%2===0));
    source.at(-1).mes='我想起了港口船長的信物。';source.at(-1).is_user=true;
    const r=rig(source);ready(r);
    r.host.complete=async()=>'{"ids":["p1","fake"]}';const before=JSON.stringify(source);const core=structuredClone(source);
    await r.engine.intercept(core,2000,()=>assert.fail('unexpected abort'),'normal');
    assert.equal(JSON.stringify(source),before);assert.ok(core.some(m=>m.mes===source[1].mes));assert.ok(core.length<source.length);
    assert.equal(core.at(-1).mes,source.at(-1).mes);assert.ok(core.every(m=>source.some(s=>s.mes===m.mes)));
    assert.deepEqual(core.map(m=>m.send_date),[...core].sort((a,b)=>Number(a.send_date.slice(1))-Number(b.send_date.slice(1))).map(m=>m.send_date));
});
test('valid empty selection keeps recent conversation only, no forced hallucinated memories',async()=>{
    const r=rig(Array.from({length:10},(_,i)=>message('前文的情節。'.repeat(50),i,i%2===0)));r.c.chat.at(-1).mes='繼續';r.c.chat.at(-1).is_user=true;
    ready(r);r.host.complete=async()=>'{"ids":[]}';const core=structuredClone(r.c.chat);await r.engine.intercept(core,1000,()=>{},'normal');assert.ok(core.length<10);assert.ok(r.engine.last.items.every(x=>x.recent));
});
test('selector/embedding failures fall back and keep latest user',async()=>{
    const r=rig(Array.from({length:8},(_,i)=>message('舊約定。'.repeat(80),i,i%2===0)));r.c.chat.at(-1).mes='提及舊約定';r.c.chat.at(-1).is_user=true;
    ready(r);r.host.complete=async()=>{throw Error('timeout');};r.embedder.embed=async()=>{throw Error('wasm');};
    const core=structuredClone(r.c.chat);await r.engine.intercept(core,2000,()=>assert.fail('abort'),'normal');
    assert.equal(core.at(-1).mes,'提及舊約定');assert.equal(r.engine.last.mode,'fallback');assert.match(r.engine.warning,/暫不可用/);
});
test('multimodal/tool history is left to the host instead of breaking protocol',async()=>{
    const r=rig(Array.from({length:8},(_,i)=>message('正文。'.repeat(100),i,i%2===0)));r.c.chat[0].extra.media=[{type:'image'}];
    r.host.complete=async()=>'{"ids":[]}';const core=structuredClone(r.c.chat),before=JSON.stringify(core);
    await r.engine.intercept(core,2000,()=>{},'normal');assert.equal(JSON.stringify(core),before);
});
test('quiet and impersonation requests do not trigger memory selection',async()=>{
    const r=rig();await r.engine.intercept(r.c.chat,2000,()=>{},'quiet');await r.engine.intercept(r.c.chat,2000,()=>{},'impersonate');assert.equal(r.stats().calls,0);
});
test('active Anima conflict prevents automatic summaries and history mutation',async()=>{
    const r=rig();r.engine.conflict='third-party/Anima-Memory-System';
    const before=JSON.stringify(r.c.chat);await r.engine.tick();await r.engine.intercept(r.c.chat,500,()=>{},'normal');
    assert.equal(r.stats().calls,0);assert.equal(JSON.stringify(r.c.chat),before);
    r.engine.changed();assert.match(r.engine.status,/Anima/);
});
test('text completion is untouched and does not issue a selector request',async()=>{
    const r=rig();r.c.mainApi='textgenerationwebui';const before=JSON.stringify(r.c.chat);
    await r.engine.intercept(r.c.chat,500,()=>{},'normal');assert.equal(r.stats().calls,0);assert.equal(JSON.stringify(r.c.chat),before);
});

test('one assistant body is one page; player input is context, never an independent summary',async()=>{
    const r=rig([message('我要把信送走',0,true),message('<正文>船長交出了藍色信件。</正文><状态栏>饥饿</状态栏>',1),message('下一步去哪',2,true)]);
    let request;r.host.complete=async(s,p)=>{request=JSON.parse(p);return '{"title":"船長的信","summary":"船長交出藍色信件。"}';};
    await r.engine.tick();await r.engine.tick();assert.equal(r.engine.snapshot().total,1);assert.equal(request.playerInput,'我要把信送走');assert.equal(request.text,'船長交出了藍色信件。');assert.equal(r.c.chat[0].extra[KEY],undefined);assert.equal(r.engine.snapshot().ready,1);
    r.c.chat[0].mes='我要拒絕收信';assert.equal(r.engine.snapshot().ready,0,'changed player context invalidates only its page');
});
test('old completed v1 assistant summaries migrate without paid regeneration',async()=>{
    const r=rig([message('玩家背景',0,true),message('船長交付信件。',1)]),m=r.c.chat[1];
    const source=sha256(JSON.stringify([1,false,m.name,m.mes]));m.extra[KEY]={v:1,hash:source,source,parts:['已有摘要'],summary:'已有摘要',done:true,pinned:true};
    await r.engine.tick();assert.equal(r.stats().calls,0);assert.equal(bookPages(r.c.chat)[0].record.summary,'已有摘要');assert.equal(bookPages(r.c.chat)[0].record.v,2);
});
test('incomplete catalogue does not pass raw excerpts to selector or discard history',async()=>{
    const r=rig(Array.from({length:9},(_,i)=>message('正文。'.repeat(100),i,i%2===0))),core=structuredClone(r.c.chat),before=JSON.stringify(core);
    await r.engine.intercept(core,500,()=>{},'normal');assert.equal(r.stats().calls,0);assert.equal(JSON.stringify(core),before);assert.equal(r.engine.last.mode,'building');
});
test('selected older page carries its player context exactly once and never its summary',async()=>{
    const r=rig(Array.from({length:9},(_,i)=>message('港口信件'+i+'。'.repeat(35),i,i%2===0)));ready(r);
    for(const p of bookPages(r.c.chat))p.record.summary='這是目錄，不應放进歷史';
    r.host.complete=async()=>'{"ids":["p1","p1"],"reasons":{"p1":"舊約定"}}';const core=structuredClone(r.c.chat);
    for(const p of bookPages(r.c.chat))r.engine.vectors.set(r.engine.vectorKey(p.record),[[1,0]]);
    await r.engine.intercept(core,650,()=>{},'normal');
    assert.equal(core.filter(m=>m.send_date==='t1').length,1);assert.equal(core.filter(m=>m.send_date==='t0').length,1);assert.ok(!JSON.stringify(core.map(m=>m.mes)).includes('這是目錄'));
    assert.ok(r.engine.last.candidates.find(c=>c.id==='p1').selected);
});
test('final request audit distinguishes removal and repeated text without double matching',async()=>{
    const r=rig([message('same',0),message('same',1),message('question',2,true)]),core=structuredClone(r.c.chat);
    r.engine.changed();
    await r.engine.intercept(core,10000,()=>{},'normal');r.engine.captureFinal({type:'quiet',messages:[]});assert.equal(r.engine.last.stage,'awaiting-final');
    r.engine.captureFinal({type:'normal',messages:[{role:'assistant',content:'same'},{role:'user',content:'question'}]});
    assert.deepEqual(r.engine.last.items.map(x=>x.final),[true,false,true]);assert.equal(r.engine.last.final.dropped,1);
    const trace=r.engine.last;r.engine.changed();assert.equal(r.engine.last,trace,'new same-chat events preserve audit');
});
test('preview is side-effect free for chat and does not claim a final main request',async()=>{
    const r=rig();const before=JSON.stringify(r.c.chat);await r.engine.preview('試跑');
    assert.equal(JSON.stringify(r.c.chat),before);assert.equal(r.engine.last.preview,true);assert.equal(r.engine.awaitingFinal,false);assert.equal(r.stats().saves,0);
});

test('deleting a middle pair removes its record/vector/trace without re-summarizing survivors',async()=>{
    const r=rig([message('信件玩家',0,true),message('藍信約定',1),message('晚餐玩家',2,true),message('牛肉麵晚餐',3),message('住宿玩家',4,true),message('銀匙旅店',5)]);r.engine.changed();
    const complete=r.host.complete;r.host.complete=async(s,p)=>{await complete(s,p);return JSON.stringify({summary:JSON.parse(p).text});};
    for(let i=0;i<4;i++)await r.engine.tick();const old=bookPages(r.c.chat)[1].record,keep=bookPages(r.c.chat)[2].record;
    await r.engine.intercept(structuredClone(r.c.chat),10000,()=>{},'normal');assert.ok(r.engine.last);
    r.c.chat.splice(2,2);r.engine.changed({deleted:true});await r.engine.maintenance;
    assert.equal(r.engine.last,null);assert.equal(await r.cache.get('records','trace:a'),null);assert.equal(await r.cache.get('records','a:'+old.hash),undefined);
    assert.equal(r.engine.vectors.has(r.engine.vectorKey(old)),false);await r.engine.tick();assert.equal(r.stats().calls,3);
    const pages=bookPages(r.c.chat);assert.equal(pages[1].index,3);assert.equal(pages[1].record.summary,keep.summary);
    assert.equal(r.engine.snapshot().entries.some(p=>p.body.includes('牛肉麵')),false);
});
test('deleting a player input invalidates that page summary but not later complete pairs',async()=>{
    const r=rig([message('願望一',0,true),message('角色一',1),message('願望二',2,true),message('角色二',3)]);await r.engine.tick();await r.engine.tick();
    const second=bookPages(r.c.chat)[1].record.hash;r.c.chat.splice(0,1);r.engine.changed({deleted:true});
    assert.equal(bookPages(r.c.chat)[0].record,null);assert.equal(bookPages(r.c.chat)[1].record.hash,second);
    await r.engine.tick();assert.equal(r.stats().calls,3);assert.equal(r.engine.snapshot().ready,2);
});
test('deleting an assistant only re-associates orphan inputs and invalidates the affected next page',async()=>{
    const r=rig([message('第一輸入',0,true),message('第一正文',1),message('第二輸入',2,true),message('第二正文',3)]);ready(r);
    r.c.chat.splice(1,1);r.engine.changed({deleted:true});const p=bookPages(r.c.chat)[0];assert.equal(p.record,null);assert.equal(p.playerInput,'第一輸入\n第二輸入');
});
for(const withEvent of [true,false])test(`delete during slow selection cancels stale coreChat commit (event=${withEvent})`,async()=>{
    const r=rig(Array.from({length:9},(_,i)=>message('信件情節。'.repeat(50),i,i%2===0)));ready(r);r.engine.changed();
    let finish;r.host.complete=()=>new Promise(resolve=>{finish=resolve;});const core=structuredClone(r.c.chat),before=JSON.stringify(core);let aborted=false;
    const pending=r.engine.intercept(core,1000,()=>{aborted=true;},'normal');await new Promise(resolve=>setTimeout(resolve,0));assert.ok(finish);
    r.c.chat.splice(0,2);if(withEvent)r.engine.changed({deleted:true});finish('{"ids":["p1"]}');await pending;
    assert.equal(aborted,true);assert.equal(JSON.stringify(core),before);assert.equal(r.engine.last,null);
});
test('delete during slow summary cannot attach its result to the new occupant of that floor',async()=>{
    const r=rig([message('待刪正文',0),message('後一頁正文',1)]);let finish;r.host.complete=()=>new Promise(resolve=>{finish=resolve;});
    const removed=r.c.chat[0],pending=r.engine.tick();await new Promise(resolve=>setTimeout(resolve,0));r.c.chat.splice(0,1);r.engine.changed({deleted:true});finish('{"summary":"待刪內容"}');await pending;
    assert.equal(removed.extra[KEY],undefined);assert.equal(r.c.chat[0].extra[KEY],undefined);assert.equal(r.stats().saves,0);
});
test('stale reader operations fail instead of modifying the next page at the same floor',async()=>{
    const r=rig([message('第一頁',0),message('第二頁',1)]);ready(r);const ref=r.engine.snapshot().entries[0].ref;
    r.c.chat.splice(0,1);await assert.rejects(r.engine.pin(ref),/已刪除或變更/);await assert.rejects(r.engine.editSummary(ref,'錯誤摘要'),/已刪除或變更/);
    assert.equal(r.c.chat[0].extra[KEY].pinned,false);assert.equal(r.c.chat[0].extra[KEY].summary,'第二頁');
});
test('a surviving reader handle follows its own message after earlier floors are deleted',async()=>{
    const r=rig([message('第一頁',0),message('第二頁',1)]);ready(r);const ref=r.engine.snapshot().entries[1].ref;
    r.c.chat.splice(0,1);await r.engine.pin(ref);assert.equal(r.c.chat[0].extra[KEY].pinned,true);
});
test('delete while a manual cache write is pending cannot trigger a stale chat save',async()=>{
    const r=rig([message('第一頁',0),message('第二頁',1)]);ready(r);let finish;r.cache.put=()=>new Promise(resolve=>{finish=resolve;});
    const pending=r.engine.pin(r.engine.snapshot().entries[0].ref);r.c.chat.splice(0,1);finish();await assert.rejects(pending,/已刪除或變更/);assert.equal(r.stats().saves,0);
});
test('reload validates persisted trace against current membership and prunes deleted receipts',async()=>{
    const r=rig([message('舊頁',0),message('保留頁',1)]);await r.engine.tick();await r.engine.tick();const removed=bookPages(r.c.chat)[0].record;
    await r.engine.intercept(structuredClone(r.c.chat),10000,()=>{},'normal');r.c.chat.splice(0,1);
    const reopened=new Engine(r.host,r.cache,r.embedder);reopened.schedule=()=>{};reopened.changed();await reopened.maintenance;await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(reopened.last,null);assert.equal(await r.cache.get('records','a:'+removed.hash),undefined);assert.match(reopened.snapshot().notice,/失效/);
});
test('new selection after deleting old pair cannot retrieve stale summary under shifted ID',async()=>{
    const r=rig(Array.from({length:11},(_,i)=>message((i===1?'刪除機密':'保留信件')+'情節。'.repeat(60),i,i%2===0)));ready(r);
    r.c.chat.splice(0,2);r.engine.changed({deleted:true});let catalogue;
    r.host.complete=async(s,p)=>{catalogue=JSON.parse(p).catalogue;return '{"ids":["p1"]}';};const core=structuredClone(r.c.chat);
    await r.engine.intercept(core,1800,()=>assert.fail('abort'),'normal');assert.ok(catalogue);assert.ok(!JSON.stringify(catalogue).includes('刪除機密'));assert.ok(!JSON.stringify(core).includes('刪除機密'));
});
test('ambiguous timestamp and body collisions are rejected, never guessed into the wrong floor',async()=>{
    const r=rig([message('相同正文',0),message('相同正文',0)]);assert.equal(r.engine.sourceIndex(structuredClone(r.c.chat[0])),-1);
    let aborted=false;await r.engine.intercept(structuredClone(r.c.chat),10000,()=>{aborted=true;},'normal');assert.equal(aborted,true);
});
test('delete after selection invalidates pending final request audit',async()=>{
    const r=rig([message('舊頁',0),message('新頁',1)]),core=structuredClone(r.c.chat);await r.engine.intercept(core,10000,()=>{},'normal');
    r.c.chat.splice(0,1);const body={type:'normal',messages:core.map(m=>({role:'assistant',content:m.mes}))};r.engine.captureFinal(body);assert.throws(()=>JSON.stringify(body),/生成已取消/);assert.equal(r.engine.last,null);assert.equal(r.engine.awaitingFinal,false);
});
test('delete event between interception and final assembly blocks sending even after UI invalidates trace',async()=>{
    const r=rig([message('舊頁',0),message('新頁',1)]),core=structuredClone(r.c.chat);r.engine.changed();await r.engine.intercept(core,10000,()=>{},'normal');
    r.c.chat.splice(0,1);r.engine.changed({deleted:true});assert.equal(r.engine.last,null);
    let stopped=false;r.c.stopGeneration=()=>{stopped=true;};const body={type:'normal',messages:core.map(m=>({role:'assistant',content:m.mes}))};r.engine.captureFinal(body);assert.throws(()=>JSON.stringify(body),/生成已取消/);assert.equal(stopped,true);assert.deepEqual(body.messages,[]);
});
test('delete all followed by new floor zero cannot inherit deleted data',async()=>{
    const r=rig();await r.engine.tick();r.c.chat.splice(0);r.engine.changed({deleted:true});await r.engine.maintenance;assert.equal(r.engine.snapshot().total,0);
    r.c.chat.push(message('全新故事',0));await r.engine.tick();assert.equal(r.stats().calls,2);assert.equal(bookPages(r.c.chat)[0].record.hash,sourceOf(r.c.chat[0]).hash);
});

let sentSequence=0;
async function sent(r,label='生成回覆'){
    const core=structuredClone(r.c.chat);await r.engine.intercept(core,10000,()=>assert.fail('aborted'),'normal');
    r.engine.captureFinal({type:'normal',messages:core.map(m=>({role:m.is_user?'user':'assistant',content:m.mes}))});
    const sequence=++sentSequence;r.c.chat.push(message(`${label}-${sequence}`,1000+sequence));r.engine.responseReceived();
    await r.engine.usageWrite;return structuredClone(r.engine.snapshot().usages[0]);
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));

test('deleting newest response rolls recent usage back to the older receipt whose response still exists',async()=>{
    const r=rig([message('舊正文',0),message('繼續',1,true)]);r.engine.changed();const older=await sent(r,'舊回覆');
    r.c.chat.push(message('新問題',2,true));r.engine.changed();const newest=await sent(r,'最新回覆');assert.notEqual(newest.id,older.id);
    r.c.chat.pop();r.engine.changed({deleted:true});
    assert.equal(r.engine.last,null);assert.equal(r.engine.snapshot().usages[0].id,older.id);assert.equal(r.engine.snapshot().usageStoredCount,2);
    const reopened=new Engine(r.host,r.cache,r.embedder);reopened.schedule=()=>{};reopened.changed();await settle();
    assert.equal(reopened.snapshot().usages[0].id,older.id);assert.equal(reopened.snapshot().usages.length,1);
});

test('journal snapshots retain missing source bodies and original numbers but never retrieve them again',async()=>{
    const r=rig([message('刪除秘密',0),message('保留正文',1),message('提問',2,true)]);r.engine.changed();await sent(r);
    const archived=JSON.stringify(await r.cache.get('records','usage:a'));r.c.chat.splice(0,1);r.engine.changed({deleted:true});await r.engine.maintenance;
    const log=r.engine.snapshot().usages[0];assert.equal(log.sourceChanged,true);assert.equal(log.items[0].sourceState,'missing');
    assert.equal(log.items[0].body,'刪除秘密');assert.equal(log.items[1].index,1);assert.equal(log.items[1].currentIndex,0);
    assert.equal(JSON.stringify(await r.cache.get('records','usage:a')),archived);
    const core=structuredClone(r.c.chat);await r.engine.intercept(core,10000,()=>{},'normal');assert.ok(!JSON.stringify(core).includes('刪除秘密'));
    assert.equal(r.engine.snapshot().usages[0].id,log.id,'unobserved selection must not replace latest receipt');
});

test('preview, quiet events and aborted stale requests do not enter sent journal',async()=>{
    const r=rig();r.engine.changed();const first=await sent(r);
    await r.engine.preview();r.engine.captureFinal({type:'normal',messages:[]});assert.equal(r.engine.snapshot().usages.length,1);
    const core=structuredClone(r.c.chat);await r.engine.intercept(core,10000,()=>{},'normal');r.engine.captureFinal({type:'quiet',messages:[]});
    assert.equal(r.engine.snapshot().usages[0].id,first.id);
    r.c.chat.pop();r.engine.changed({deleted:true});const stale={type:'normal',messages:[{role:'assistant',content:'stale'}]};r.engine.captureFinal(stale);
    assert.throws(()=>JSON.stringify(stale),/生成已取消/);assert.equal(r.engine.snapshot().usages.length,0);assert.equal(r.engine.snapshot().usageStoredCount,1);
});

test('actual sends are separate immutable receipts, deduplicated and capped at twenty per chat',async()=>{
    const r=rig();r.engine.changed();const first=await sent(r);r.engine.last.items[0].body='mutated working trace';
    assert.equal(r.engine.snapshot().usages[0].items[0].body,first.items[0].body);
    for(let i=0;i<22;i++)await sent(r);
    assert.equal(r.engine.snapshot().usages.length,20);assert.equal((await r.cache.get('records','usage:a')).length,20);
    assert.ok(!r.engine.snapshot().usages.some(x=>x.id===first.id));const latest=r.engine.snapshot().usages[0];r.engine.rememberUsage(latest);await r.engine.usageWrite;
    assert.equal(r.engine.snapshot().usages.length,20);assert.equal(r.engine.snapshot().usages[0].id,latest.id);
});

test('journal isolates chat switches, restores each chat and ignores late loads from the previous chat',async()=>{
    const r=rig();r.engine.changed();const first=await sent(r);const get=r.cache.get.bind(r.cache);let release;
    r.cache.get=(s,k)=>k==='usage:a'?new Promise(resolve=>{release=resolve;}):get(s,k);
    r.engine.loadUsage('a');r.c.chatId='b';r.engine.changed();release([first]);await settle();assert.equal(r.engine.snapshot().usages.length,0);
    const second=await sent(r);assert.equal(r.engine.snapshot().usages.length,1);assert.notEqual(second.id,first.id);
    r.cache.get=get;r.c.chatId='a';r.engine.changed();await settle();assert.equal(r.engine.snapshot().usages[0].id,first.id);
});

test('legacy observed trace migrates even after a source deletion, while unobserved trace never migrates',async()=>{
    const r=rig();r.engine.changed();const receipt=await sent(r);await r.cache.put('records','usage:a',[]);r.c.chat.splice(0,1);
    const reopened=new Engine(r.host,r.cache,r.embedder);reopened.schedule=()=>{};reopened.changed();await settle();await reopened.usageWrite;
    assert.equal(reopened.last,null);assert.equal(reopened.snapshot().usages[0].id,receipt.id);
    const pending={...receipt,id:'pending',stage:'awaiting-final',final:undefined};await r.cache.put('records','trace:b',pending);
    r.c.chatId='b';reopened.changed();await settle();assert.deepEqual(reopened.snapshot().usages,[]);
});

test('request-ready receipt stays hidden until a response is attached, and a swipe binds the replacement floor',async()=>{
    const r=rig([message('問題',0,true)]);r.engine.changed();const core=structuredClone(r.c.chat);
    await r.engine.intercept(core,10000,()=>{},'normal');r.engine.captureFinal({type:'normal',messages:[{role:'user',content:'問題'}]});
    assert.equal(r.engine.snapshot().usages.length,0);assert.equal(r.engine.snapshot().usageStoredCount,1);
    r.c.chat.push(message('第一個回覆',1));r.engine.responseReceived();await r.engine.usageWrite;assert.equal(r.engine.snapshot().usages.length,1);
    r.c.chat.push(message('再生成',2,true));r.engine.changed();const swipeCore=structuredClone(r.c.chat);await r.engine.intercept(swipeCore,10000,()=>{},'normal');
    r.engine.captureFinal({type:'normal',messages:swipeCore.map(m=>({role:m.is_user?'user':'assistant',content:m.mes}))});
    r.c.chat.at(-1).mes='替換成角色回覆';r.c.chat.at(-1).is_user=false;r.engine.responseReceived({replacement:true});await r.engine.usageWrite;
    assert.equal(r.engine.snapshot().usages.length,2);assert.equal(r.engine.snapshot().usages[0].resultIndex,r.c.chat.length-1);
});

test('failed journal storage is visible without blocking send, then next write recovers both receipts',async()=>{
    const r=rig();r.engine.changed();const append=r.cache.appendUsage.bind(r.cache);r.cache.appendUsage=async()=>{throw Error('full');};
    const first=await sent(r);assert.ok(first);assert.match(r.engine.snapshot().usageError,/保存失敗/);
    r.cache.appendUsage=append;await sent(r);assert.equal(r.engine.snapshot().usageError,'');assert.equal((await r.cache.get('records','usage:a')).length,2);
});

test('rebuilding summaries preserves sent journal and recorded bodies',async()=>{
    const r=rig();ready(r);r.engine.changed();const first=await sent(r);await r.engine.refreshAll();await r.engine.tick();await r.engine.tick();
    assert.equal(r.engine.snapshot().usages[0].id,first.id);assert.equal(r.engine.snapshot().usages[0].items[0].body,first.items[0].body);
});
