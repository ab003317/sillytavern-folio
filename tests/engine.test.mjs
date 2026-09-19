import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/engine.js';
import {KEY,newRecord,sourceOf,validRecord} from '../src/core.js';

class MemoryCache {
    constructor(){this.data=new Map();this.owner=null;}
    async get(s,k){return structuredClone(this.data.get(s+k));}
    async put(s,k,v){this.data.set(s+k,structuredClone(v));}
    async lease(k,o,release=false){if(release){if(this.owner===o)this.owner=null;return false;}if(this.owner&&this.owner!==o)return false;this.owner=o;return true;}
    close(){}
}
function message(text,i=0,user=false){return {mes:text,name:user?'玩家':'角色',is_user:user,send_date:`t${i}`,extra:{}};}
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
test('background summary is idempotent across events and reopen',async()=>{
    const r=rig();await r.engine.tick();assert.equal(r.stats().calls,1);assert.ok(validRecord(r.c.chat[0]).done);
    await r.engine.tick();await r.engine.tick();r.engine.changed();await r.engine.tick();assert.equal(r.stats().calls,1);
    const engine=new Engine(r.host,r.cache,r.embedder);engine.schedule=()=>{};await engine.tick();assert.equal(r.stats().calls,1);
});
test('save gap recovers completed receipt without calling model again',async()=>{
    const r=rig();await r.engine.tick();delete r.c.chat[0].extra[KEY];await r.engine.tick();assert.equal(r.stats().calls,1);assert.ok(validRecord(r.c.chat[0]).done);
});
test('partial long-body receipt resumes only missing segments',async()=>{
    const r=rig([message('長篇正文。'.repeat(1300))]);await r.engine.tick();assert.equal(r.stats().calls,1);assert.equal(validRecord(r.c.chat[0]).done,false);
    delete r.c.chat[0].extra[KEY];await r.engine.tick();assert.equal(r.stats().calls,2);assert.equal(validRecord(r.c.chat[0]).parts.length,2);
});
test('edits cause one new summary; reverting recovers its own cached version',async()=>{
    const r=rig();await r.engine.tick();const old=r.c.chat[0].mes;r.c.chat[0].mes='改為森林的情節';r.engine.changed();await r.engine.tick();assert.equal(r.stats().calls,2);
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
    const r=rig(source);for(const m of source){const x=newRecord(m);x.summary=m.mes;x.done=true;m.extra[KEY]=x;r.engine.vectors.set(r.engine.vectorKey(x),[[1,0]]);}
    r.host.complete=async()=>'{"ids":["p1","fake"]}';const before=JSON.stringify(source);const core=structuredClone(source);
    await r.engine.intercept(core,2000,()=>assert.fail('unexpected abort'),'normal');
    assert.equal(JSON.stringify(source),before);assert.ok(core.some(m=>m.mes===source[1].mes));assert.ok(core.length<source.length);
    assert.equal(core.at(-1).mes,source.at(-1).mes);assert.ok(core.every(m=>source.some(s=>s.mes===m.mes)));
    assert.deepEqual(core.map(m=>m.send_date),[...core].sort((a,b)=>Number(a.send_date.slice(1))-Number(b.send_date.slice(1))).map(m=>m.send_date));
});
test('valid empty selection keeps recent conversation only, no forced hallucinated memories',async()=>{
    const r=rig(Array.from({length:10},(_,i)=>message('前文的情節。'.repeat(50),i,i%2===0)));r.c.chat.at(-1).mes='繼續';r.c.chat.at(-1).is_user=true;
    r.host.complete=async()=>'{"ids":[]}';const core=structuredClone(r.c.chat);await r.engine.intercept(core,1000,()=>{},'normal');assert.ok(core.length<10);assert.ok(r.engine.last.items.every(x=>x.reason==='近期正文'));
});
test('selector/embedding failures fall back and keep latest user',async()=>{
    const r=rig(Array.from({length:8},(_,i)=>message('舊約定。'.repeat(80),i,i%2===0)));r.c.chat.at(-1).mes='提及舊約定';r.c.chat.at(-1).is_user=true;
    r.host.complete=async()=>{throw Error('timeout');};r.embedder.embed=async()=>{throw Error('wasm');};
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
