import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/engine.js';
import {KEY,MODEL,summaryChunks,fingerprint,newRecord,sourceOf,validRecord,bookPages} from '../src/core.js';
import {Embedder} from '../src/embedding.js';
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
const story=chat=>chat.filter(m=>!m.extra?.folio_note&&!m.extra?.folio_summary);
function message(text,i=0,user=false){return {mes:text,name:user?'玩家':'角色',is_user:user,send_date:`t${i}`,extra:{}};}
function ready(r){for(const p of bookPages(r.c.chat)){const x=newRecord(p.message,p.playerInput);x.summary=p.body;x.done=true;p.message.extra[KEY]=x;r.engine.vectors.set(r.engine.vectorKey(x),[[1,0]]);}}
function rig(messages=[message('港口的兩人交換信物，約定明日再見。')]) {
    const c={chat:[],chatId:'a',mainApi:'openai',saveSettingsDebounced(){}};
    const settings={enabled:true};let calls=0,saves=0;
    const host={context:()=>c,identity:()=>c.chatId,settings:()=>settings,model:'fixture-mini',
        count:async text=>text.length,save:async()=>{saves++;},complete:async(system,prompt)=>{calls++;return '{"summary":"兩人在港口交換信物，約定明日再見。"}';}};
    const cache=new MemoryCache();
    const embedder={embed:async texts=>texts.map(()=>[1,0]),stop(){}};
    const engine=new Engine(host,cache,embedder);engine.schedule=()=>{};engine.changed();c.chat.push(...messages);engine.newResponse();
    return {engine,host,cache,embedder,c,stats:()=>({calls,saves})};
}

test('memory preferences limit recalled pages and history while preserving the latest complete pair',async()=>{
    const r=rig(Array.from({length:10},(_,i)=>message('信件正文'+i,i,i%2===0)));ready(r);
    r.host.memory=()=>({recentPages:1,recallPages:1,historyBudget:40});
    r.host.complete=async()=>'{"ids":["p1","p3","p5"]}';
    const core=structuredClone(r.c.chat);await r.engine.intercept(core,10000,()=>assert.fail('abort'),'normal');
    assert.deepEqual(story(core).map(m=>m.send_date),['t0','t1','t8','t9']);assert.equal(core.findIndex(m=>m.extra?.folio_note),core.findIndex(m=>m.send_date==='t8')-1);
    assert.equal(r.engine.last.budget,40);assert.equal(r.engine.last.candidates.filter(p=>p.selected).length,1);
    r.host.complete=async()=>{const error=new Error('助手輸入超過進階設定的上下文上限');error.name='FolioContextError';throw error;};
    await r.engine.intercept(structuredClone(r.c.chat),10000,()=>assert.fail('abort'),'normal');
    assert.equal(r.engine.last.mode,'fallback');assert.match(r.engine.warning,/上下文上限/);
});

test('partial summaries retain their split boundaries when advanced settings change',async()=>{
    const text='完整正文。'.repeat(300),r=rig([message(text)]),chunks=[];
    r.host.summaryChunkSize=()=>500;r.host.complete=async(_s,prompt)=>{chunks.push(JSON.parse(prompt).text);return '{"summary":"分段摘要"}';};
    await r.engine.tick();assert.equal(bookPages(r.c.chat)[0].record.chunkSize,500);
    r.host.summaryChunkSize=()=>900;
    for(let i=0;i<10&&!bookPages(r.c.chat)[0].record.done;i++)await r.engine.tick();
    assert.equal(chunks.join(''),text);assert.equal(bookPages(r.c.chat)[0].record.done,true);
});

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

test('missing-only preserves ready manual summaries and vectors, fills missing pages once',async()=>{
    const r=rig([message('已整理',0),message('待補正文',1)]);ready(r);r.engine.toggle(false);
    r.c.chat[0].extra[KEY].edited=true;r.c.chat[0].extra[KEY].pinned=true;
    const preserved=JSON.stringify(r.c.chat[0]);delete r.c.chat[1].extra[KEY];
    await r.engine.refreshMissing();assert.equal(r.engine.snapshot().rebuild.mode,'missing');assert.equal(r.engine.snapshot().rebuild.total,1);
    for(let i=0;i<3;i++)await r.engine.tick();
    assert.equal(r.stats().calls,1);assert.equal(JSON.stringify(r.c.chat[0]),preserved);assert.equal(r.engine.snapshot().missing,0);
    assert.ok(r.engine.vectors.has(r.engine.vectorKey(r.c.chat[0].extra[KEY])));
    await r.engine.refreshMissing();assert.equal(r.stats().calls,1);assert.match(r.engine.status,/沒有未整理/);
});

test('missing-only resumes valid partial chunks but rebuilds invalid source summaries',async()=>{
    const r=rig([message('甲'.repeat(1500),0),message('舊文字',1),message('有效人工摘要',2)]);ready(r);r.engine.toggle(false);
    const partial=r.c.chat[0].extra[KEY];Object.assign(partial,{done:false,parts:['第一段已有摘要'],summary:'第一段已有摘要',chunkSize:800});
    r.c.chat[1].mes='已修改的正文';const saved=JSON.stringify(r.c.chat[2]);const inputs=[];
    r.host.complete=async(_s,p)=>{inputs.push(JSON.parse(p).text);return '{"summary":"新段摘要"}';};
    await r.engine.refreshMissing();for(let i=0;i<4;i++)await r.engine.tick();
    assert.deepEqual(inputs,['甲'.repeat(700),'已修改的正文']);assert.equal(r.c.chat[0].extra[KEY].parts[0],'第一段已有摘要');
    assert.equal(JSON.stringify(r.c.chat[2]),saved);
});

test('missing-only repairs unloaded vectors without re-summarizing completed pages',async()=>{
    const r=rig();ready(r);r.engine.toggle(false);r.engine.vectors.clear();const before=structuredClone(r.c.chat[0].extra[KEY]);
    assert.equal(r.engine.snapshot().missing,1);assert.equal(r.engine.snapshot().summaryMissing,0);assert.equal(r.engine.snapshot().vectorMissing,1);
    await r.engine.refreshMissing();await r.engine.tick();assert.equal(r.stats().calls,0);assert.equal(r.engine.snapshot().missing,0);
    const after=r.c.chat[0].extra[KEY];for(const key of Object.keys(before))assert.deepEqual(after[key],before[key]);
});

test('opening restores every valid cached vector, including hidden/recent pages, without inference or saving chat',async()=>{
    const r=rig([message('隱藏舊頁',0),message('近期已整理',1),message('未整理舊頁',2)]);ready(r);
    r.c.chat[0].is_system=true;delete r.c.chat[2].extra[KEY];
    r.embedder=new Embedder(r.cache);r.engine.embedder=r.embedder;
    r.embedder.request=()=>assert.fail('opening must not run inference');
    for(const p of r.engine.pages().filter(p=>p.record?.done))for(const text of summaryChunks(p.record.summary)){
        await r.cache.put('vectors',MODEL+':'+fingerprint(text),{text,vector:Array(512).fill(.1)});
    }
    const before=JSON.stringify(r.c.chat);r.c.chatId='reopened';r.engine.changed();
    assert.equal(r.engine.snapshot().vectorLoading,true);await r.engine.tick();
    const s=r.engine.snapshot();assert.equal(s.vectorLoading,false);assert.equal(s.ready,2);assert.equal(s.indexed,2);assert.equal(s.missing,1);
    assert.equal(s.vectorMissing,0);assert.equal(JSON.stringify(r.c.chat),before);assert.deepEqual(r.stats(),{calls:0,saves:0});
    r.engine.dispose();
});

test('missing browser-local vectors rebuild automatically from completed summaries and skip unsummarized pages',async()=>{
    const r=rig([message('有效人工摘要',0),message('舊聊天尚無摘要',1)]);ready(r);delete r.c.chat[1].extra[KEY];
    r.c.chat[0].extra[KEY].edited=true;r.c.chat[0].extra[KEY].pinned=true;r.c.chat[0].is_system=true;
    const original=structuredClone(r.c.chat[0].extra[KEY]);r.embedder.cached=async()=>null;let embeddings=0;
    r.embedder.embed=async()=>{embeddings++;return [[1,0]];};r.host.helper=()=>({connection:'direct',model:''});
    r.c.mainApi='kobold';r.c.chatId='new-browser';r.engine.changed();await r.engine.tick();
    assert.equal(embeddings,1);assert.deepEqual(r.stats(),{calls:0,saves:0});assert.equal(r.engine.snapshot().missing,1);
    assert.equal(r.engine.snapshot().vectorMissing,0);assert.equal(r.engine.snapshot().summaryMissing,1);
    r.engine.toggle(false);await r.engine.repairVectors();await r.engine.tick();assert.equal(embeddings,1);
    for(const key of Object.keys(original))assert.deepEqual(r.c.chat[0].extra[KEY][key],original[key]);
    assert.equal(r.c.chat[1].extra[KEY],undefined);assert.equal(r.c.chat[0].is_system,true);assert.equal(r.host.settings().enabled,false);
});

test('selection waits for automatic vector hydration instead of silently using lexical-only candidates',async()=>{
    const r=rig(Array.from({length:9},(_,i)=>message(`相關舊正文 ${i}`.repeat(40),i,i%2===0)));ready(r);r.engine.vectors.clear();
    const calls=[];r.embedder.cached=async()=>null;r.embedder.embed=async(texts,_signal,query)=>{calls.push({texts:texts.length,query:!!query});return texts.map(()=>[1,0]);};
    r.host.complete=async()=>'\u007b"ids":[]\u007d';r.c.chatId='automatic-vector-browser';r.engine.changed();
    const core=structuredClone(r.c.chat);await r.engine.intercept(core,2000,()=>assert.fail('abort'),'normal');
    assert.ok(calls.some(x=>!x.query),'completed summaries must receive document vectors');assert.ok(calls.some(x=>x.query),'the query must receive a query vector');
    assert.ok(r.engine.last.candidates.some(x=>x.semantic>0));assert.equal(r.engine.snapshot().vectorMissing,0);assert.deepEqual(r.stats(),{calls:0,saves:0});
});

test('mixed missing job only pays for missing summaries, retaining vector-only page contents',async()=>{
    const r=rig([message('只有向量遺失',0),message('需新摘要',1),message('兩者已完成',2)]);ready(r);r.engine.toggle(false);
    const keep=JSON.stringify(r.c.chat[2]);r.engine.vectors.delete(r.engine.vectorKey(r.c.chat[0].extra[KEY]));delete r.c.chat[1].extra[KEY];
    await r.engine.refreshMissing();assert.equal(r.engine.snapshot().rebuild.total,2);
    for(let i=0;i<4;i++)await r.engine.tick();assert.equal(r.stats().calls,1);assert.equal(r.engine.snapshot().missing,0);
    assert.equal(r.c.chat[0].extra[KEY].summary,'只有向量遺失');assert.equal(JSON.stringify(r.c.chat[2]),keep);
});

test('late cached vectors cannot repopulate a deleted page or switched chat',async()=>{
    for(const action of ['delete','switch','edit']){
        const r=rig();ready(r);r.engine.vectors.clear();let release;r.embedder.cached=()=>new Promise(resolve=>{release=resolve;});
        const loading=r.engine.loadVectors();assert.equal(r.engine.snapshot().vectorLoading,true);
        if(action==='delete')r.c.chat=[];else if(action==='switch'){r.c.chatId='other';r.c.chat=[];}else r.c.chat[0].mes='修改後正文';
        r.engine.changed();release([[1,0]]);await loading;await r.engine.vectorHydration;
        assert.equal(r.engine.vectors.size,0);assert.equal(r.engine.snapshot().vectorLoading,false);assert.equal(r.stats().calls,0);
    }
});

test('late cache for a replaced summary is discarded even if the body is unchanged',async()=>{
    const r=rig();ready(r);r.engine.vectors.clear();let release;r.embedder.cached=()=>new Promise(resolve=>{release=resolve;});
    const old=r.c.chat[0].extra[KEY],loading=r.engine.loadVectors();r.c.chat[0].extra[KEY]={...old,summary:'新的人工摘要'};
    release([[1,0]]);await loading;assert.equal(r.engine.vectors.size,0);assert.equal(r.stats().calls,0);
});

test('in-place summary changes cannot store an older cached vector under the newer summary key',async()=>{
    const r=rig();ready(r);r.engine.vectors.clear();let release;r.embedder.cached=()=>new Promise(resolve=>{release=resolve;});
    const loading=r.engine.loadVectors();r.c.chat[0].extra[KEY].summary='原物件上改寫的摘要';
    release([[1,0]]);await loading;assert.equal(r.engine.vectors.size,0);
});

test('failed vector repair stays missing and can be retried without summary requests',async()=>{
    const r=rig();ready(r);r.engine.toggle(false);r.engine.vectors.clear();
    r.embedder.embed=async()=>{throw new Error('worker unavailable');};
    await r.engine.repairVectors();await r.engine.tick();
    const s=r.engine.snapshot();assert.equal(s.rebuild.complete,true);assert.equal(s.rebuild.vectorFallback,true);assert.equal(s.missing,1);assert.equal(s.vectorMissing,1);
    assert.match(s.warning,/補齊本機向量/);r.embedder.embed=async()=>[[1,0]];
    await r.engine.refreshMissing();await r.engine.tick();assert.equal(r.engine.snapshot().missing,0);assert.equal(r.stats().calls,0);
});

test('vector repair can be stopped mid-inference without adopting late output or automatically restarting',async()=>{
    const r=rig();ready(r);r.engine.vectors.clear();let entered;
    const started=new Promise(resolve=>{entered=resolve;});
    r.embedder.embed=async(_texts,signal)=>{entered();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return [[1,0]];};
    await r.engine.repairVectors();const running=r.engine.tick();await started;await r.engine.stopRebuild();await running;
    assert.equal(r.engine.snapshot().indexed,0);assert.equal(r.engine.snapshot().rebuild.cancelled,1);assert.equal(r.c.chat[0].extra[KEY].done,true);
    await r.engine.tick();assert.equal(r.engine.snapshot().indexed,0);assert.equal(r.stats().calls,0);
});

test('vector repair queued during main generation can be cancelled without aborting main selection',async()=>{
    const r=rig();ready(r);r.engine.vectors.clear();r.engine.toggle(false);r.engine.generationStarted();
    r.engine.selectController=new AbortController();const main=r.engine.selectController;
    await r.engine.repairVectors();assert.equal(r.engine.snapshot().rebuildMode,'vectors');await r.engine.stopRebuild();assert.equal(main.signal.aborted,false);
    await r.engine.generationEnded();await r.engine.tick();assert.equal(r.engine.snapshot().indexed,0);assert.equal(r.stats().calls,0);
});

test('saved vector-only work resumes after reload with auto off and no summary API configured',async()=>{
    const r=rig([message('已保存的摘要',0),message('沒有摘要的頁',1)]);ready(r);delete r.c.chat[1].extra[KEY];r.engine.vectors.clear();r.engine.toggle(false);
    await r.engine.repairVectors();r.engine.dispose();r.c.mainApi='kobold';
    const other=new Engine(r.host,r.cache,r.embedder);other.schedule=()=>{};other.changed();await other.tick();
    assert.equal(other.snapshot().rebuild.mode,'vectors');assert.equal(other.snapshot().indexed,1);assert.equal(other.snapshot().summaryMissing,1);assert.equal(r.stats().calls,0);other.dispose();
});

test('deletion during vector inference never attaches results to the shifted replacement',async()=>{
    const r=rig([message('刪除目標',0),message('保留目標',1)]);ready(r);r.engine.vectors.clear();r.engine.toggle(false);let release,started;
    const entering=new Promise(resolve=>{started=resolve;});r.embedder.embed=async()=>{started();return new Promise(resolve=>{release=resolve;});};
    await r.engine.repairVectors();const running=r.engine.tick();await entering;r.c.chat.shift();r.engine.changed({deleted:true});release([[1,0]]);await running;
    assert.equal(r.engine.snapshot().indexed,0);assert.equal(r.engine.snapshot().rebuild.removed,1);assert.equal(r.stats().calls,0);
    r.embedder.embed=async()=>[[0,1]];await r.engine.tick();assert.equal(r.engine.snapshot().indexed,1);assert.equal(r.c.chat[0].extra[KEY].summary,'保留目標');
});

test('missing-only queue keeps its scope after generation, excludes completed pages and deleted sources',async()=>{
    const r=rig([message('完成',0),message('排隊時待整理',1),message('排隊時刪除',2)]);ready(r);r.engine.toggle(false);
    delete r.c.chat[1].extra[KEY];delete r.c.chat[2].extra[KEY];const keep=JSON.stringify(r.c.chat[0]);
    r.engine.generationStarted();await r.engine.refreshMissing();assert.equal(r.engine.snapshot().rebuildMode,'missing');
    r.c.chat.pop();r.engine.changed({deleted:true});r.c.chat.push(message('新回覆',3));
    await r.engine.generationEnded();assert.equal(r.engine.snapshot().rebuild.total,2);
    for(let i=0;i<4;i++)await r.engine.tick();assert.equal(r.stats().calls,2);assert.equal(JSON.stringify(r.c.chat[0]),keep);
});

test('missing queue cancels without starting later or accepting a second task',async()=>{
    const r=rig();r.engine.toggle(false);r.engine.generationStarted();await r.engine.refreshMissing();
    await assert.rejects(r.engine.refreshAll(),/已有重整任務/);await assert.rejects(r.engine.refresh(0),/已有重整任務/);
    await r.engine.stopRebuild();await r.engine.generationEnded();await r.engine.tick();assert.equal(r.stats().calls,0);
});

test('missing request rechecks completed pages after idle instead of resetting them',async()=>{
    const r=rig();r.engine.toggle(false);let release;r.engine.idle=new Promise(resolve=>{release=resolve;});
    const pending=r.engine.refreshMissing();await new Promise(resolve=>setTimeout(resolve,0));ready(r);const completed=JSON.stringify(r.c.chat);
    release();await pending;assert.equal(JSON.stringify(r.c.chat),completed);assert.equal(r.engine.snapshot().rebuild,null);assert.equal(r.stats().calls,0);
});

test('hidden story and players are included without unhiding; typed system notices are not pages',async()=>{
    const chat=[message('開場',0),message('玩家選擇',1,true),message('角色回應',2),message('另一選擇',3,true),message('後續',4)];
    for(const m of chat.slice(0,4))m.is_system=true;
    chat.splice(2,0,{...message('系統說明',99),is_system:true,extra:{type:'help'}});
    const r=rig(chat);r.c.chatId='loaded-old';r.engine.changed();const before=chat.map(m=>[m.mes,m.is_system]);
    assert.equal(r.engine.snapshot().total,3);assert.equal(r.engine.snapshot().hidden,2);
    assert.equal(r.engine.pages()[1].playerInput,'玩家選擇');assert.equal(r.engine.pages()[2].playerInput,'另一選擇');
    await r.engine.tick();assert.equal(r.stats().calls,0);await r.engine.refreshAll();for(let i=0;i<5;i++)await r.engine.tick();
    assert.equal(r.stats().calls,3);assert.deepEqual(chat.map(m=>[m.mes,m.is_system]),before);assert.equal(chat[2].extra[KEY],undefined);
});

test('hidden narrator is a story; native typed notices stay out even if manually unhidden',()=>{
    const chat=[{...message('旁白劇情'),is_system:true,extra:{type:'narrator'}},...['help','comment','welcome','generic','assistant_note'].map((type,i)=>({...message('通知',i+1),is_system:false,extra:{type}}))];
    assert.deepEqual(bookPages(chat).map(p=>p.body),['旁白劇情']);
});

test('missing queue whose last target completed meanwhile does not overwrite or create a job',async()=>{
    const r=rig();r.engine.toggle(false);r.engine.generationStarted();await r.engine.refreshMissing();ready(r);const before=JSON.stringify(r.c.chat);
    await r.engine.generationEnded();assert.equal(JSON.stringify(r.c.chat),before);assert.equal(r.engine.snapshot().rebuildQueued,false);assert.equal(r.engine.snapshot().rebuild,null);
});

test('missing task reload and stop preserve completed and partial old summaries without touching excluded pages',async()=>{
    const r=rig([message('待補第一頁',0),message('待補第二頁',1),message('已完成',2)]);ready(r);r.engine.toggle(false);
    delete r.c.chat[0].extra[KEY];r.c.chat[1].extra[KEY].done=false;r.c.chat[1].extra[KEY].parts=['有效的舊分段'];const before=JSON.stringify(r.c.chat[2]);
    await r.engine.refreshMissing();await r.engine.tick();
    const other=new Engine(r.host,r.cache,r.embedder);other.schedule=()=>{};other.changed();assert.equal(other.snapshot().rebuild.mode,'missing');
    await other.stopRebuild();assert.equal(r.c.chat[0].extra[KEY].done,true);assert.deepEqual(r.c.chat[1].extra[KEY].parts,['有效的舊分段']);
    assert.equal(JSON.stringify(r.c.chat[2]),before);await other.tick();assert.equal(r.stats().calls,1);
});

test('hidden-input restoration invalidates the old visible page summary for missing-only repair',async()=>{
    const user={...message('此前隱藏的選擇',0,true),is_system:true},answer=message('回應',1),r=rig([user,answer]);
    answer.extra[KEY]={...newRecord(answer,''),summary:'舊版遺漏背景的摘要',done:true};r.engine.toggle(false);
    assert.equal(r.engine.snapshot().missing,1);await r.engine.refreshMissing();await r.engine.tick();assert.ok(validRecord(answer,user.mes));
});

test('hidden recall enters filtered outgoing history exactly once with its player, never notices or saved unhide',async()=>{
    const r=rig([message('信件給誰',0,true),message('信件交給船長',1),message('其他問題',2,true),message('最近故事',3),message('信件的約定',4,true)]);
    r.c.chat[0].is_system=true;r.c.chat[1].is_system=true;ready(r);r.host.memory=()=>({recentPages:1,historyBudget:2000});
    r.host.complete=async()=>'{"ids":["p1","p1"]}';const before=JSON.stringify(r.c.chat);
    const outgoing=structuredClone(r.c.chat.filter(m=>!m.is_system));await r.engine.intercept(outgoing,10000,()=>assert.fail('abort'),'normal');
    assert.deepEqual(story(outgoing).map(m=>m.send_date),['t0','t1','t2','t3','t4']);assert.equal(outgoing[1].is_system,false);
    assert.equal(JSON.stringify(r.c.chat),before);assert.equal(r.engine.last.items.filter(i=>i.index===1).length,1);
    r.c.chat.splice(0,2);r.engine.changed({deleted:true});const next=structuredClone(r.c.chat);await r.engine.intercept(next,10000,()=>assert.fail('abort'),'normal');
    assert.ok(!next.some(m=>m.mes==='信件交給船長'));
});

test('hidden recall not selected stays out; hidden background of a recent page remains paired',async()=>{
    const r=rig([message('舊信件',0),message('隱藏玩家背景',1,true),message('最近角色回應',2)]);
    r.c.chat[0].is_system=true;r.c.chat[1].is_system=true;ready(r);r.host.memory=()=>({recentPages:1});r.host.complete=async()=>'{"ids":[]}';
    const outgoing=structuredClone(r.c.chat.filter(m=>!m.is_system));await r.engine.intercept(outgoing,10000,()=>assert.fail('abort'),'normal');
    assert.deepEqual(story(outgoing).map(m=>m.send_date),['t1','t2']);
    assert.equal(outgoing[0].extra.folio_summary,true);assert.match(outgoing[0].mes,/第 1 頁.*：舊信件/,'unsent hidden page reaches the model as its summary');assert.ok(!outgoing.some(m=>m.mes==='舊信件'));
});

test('an unfinished old page is kept verbatim while finished pages are still searched',async()=>{
    const r=rig([message('已整理隱藏正文',0),message('<状态栏>未整理</状态栏>未整理舊正文',1),message('最近正文',2)]);ready(r);r.c.chat[0].is_system=true;delete r.c.chat[1].extra[KEY];r.host.memory=()=>({recentPages:1});
    r.host.complete=async()=>'{"ids":[]}';const outgoing=structuredClone(r.c.chat.filter(m=>!m.is_system)),before=JSON.stringify(outgoing);
    await r.engine.intercept(outgoing,10000,()=>assert.fail('abort'),'normal');
    assert.equal(r.engine.last.mode,'hybrid');assert.equal(r.engine.last.unready,1);assert.equal(r.engine.last.candidates.length,1);assert.match(r.engine.warning,/1 頁舊正文尚未整理/);
    assert.equal(JSON.stringify(story(outgoing)),before,'unselected hidden body stays out; unfinished page is not reformatted or dropped');
    assert.match(outgoing[0].mes,/已整理隱藏正文/);assert.deepEqual(r.engine.last.summary.pages,[1]);
});

test('hidden unfinished, tool/media, removed swipe and typed notices cannot be recalled',async()=>{
    const r=rig([message('隱藏未整理',0),message('隱藏圖片',1),message('可見最近',2),message('被 swipe 排除',3)]);ready(r);
    for(const i of [0,1,3])r.c.chat[i].is_system=true;delete r.c.chat[0].extra[KEY];r.c.chat[1].extra.media=[{url:'fixture'}];
    r.c.chat.push({...message('系統通知',4),is_system:true,extra:{type:'comment'}});
    r.host.complete=async()=>assert.fail('No eligible catalogue candidates');
    const outgoing=structuredClone([r.c.chat[2]]);await r.engine.intercept(outgoing,10000,()=>assert.fail('abort'),'swipe');assert.equal(outgoing.length,1);
});

test('mode switch while checking host state cancels helper test before a request is made',async()=>{
    const r=rig();let release;r.host.generationActive=()=>new Promise(resolve=>{release=resolve;});
    const pending=r.engine.testHelper('summary');r.engine.cancel();r.engine.connectionTests={summary:null,selection:null};release(false);await pending;
    assert.equal(r.stats().calls,0);assert.equal(r.engine.connectionTests.summary,null);
});

test('late helper test cannot replace results after switching connection mode',async()=>{
    const r=rig();let finish;r.host.complete=()=>new Promise(resolve=>{finish=resolve;});
    const pending=r.engine.testHelper('summary');await new Promise(resolve=>setTimeout(resolve,0));assert.ok(finish);
    r.engine.cancel();r.engine.connectionTests={summary:null,selection:null};finish('{"summary":"old provider reply"}');await pending;
    assert.equal(r.engine.connectionTests.summary,null);
});

test('cancelled helper test does not overwrite a newer pending test',async()=>{
    const r=rig(),resolvers=[];r.host.complete=()=>new Promise(resolve=>resolvers.push(resolve));
    const first=r.engine.testHelper('summary');await new Promise(resolve=>setTimeout(resolve,0));const second=r.engine.testHelper('summary');await new Promise(resolve=>setTimeout(resolve,0));
    const pending=r.engine.connectionTests.summary;resolvers[0]('{"summary":"old"}');await first;assert.equal(r.engine.connectionTests.summary,pending);
    resolvers[1]('{"summary":"new"}');await second;assert.equal(r.engine.connectionTests.summary.summary,'new');
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

test('another tab lease waits, exposes cancellation, then takes over without losing summaries',async()=>{
    const r=rig();ready(r);const before=JSON.stringify(r.c.chat);r.cache.owner='other';const pending=r.engine.refreshAll();
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(r.engine.snapshot().leaseWaiting,true);assert.match(r.engine.status,/自動接手/);assert.equal(JSON.stringify(r.c.chat),before);
    r.cache.owner=null;await pending;assert.equal(r.engine.snapshot().leaseWaiting,false);assert.equal(r.engine.snapshot().rebuild.pending,1);
    await assert.rejects(r.engine.refreshAll('different-chat'),/聊天已切換/);
});

test('waiting for another tab can be stopped without changing existing summaries',async()=>{
    const r=rig();ready(r);const before=JSON.stringify(r.c.chat);r.cache.owner='other';const pending=r.engine.refreshAll();
    await new Promise(resolve=>setTimeout(resolve,20));await r.engine.stopRebuild();await pending;
    assert.equal(r.engine.snapshot().leaseWaiting,false);assert.equal(r.engine.snapshot().rebuild,null);assert.equal(JSON.stringify(r.c.chat),before);assert.equal(r.cache.owner,'other');
});

test('one-click rebuild queues during generation and starts after the reply ends',async()=>{
    const r=rig();ready(r);const before=JSON.stringify(r.c.chat);r.engine.generationStarted();await r.engine.refreshAll();
    assert.equal(r.engine.snapshot().rebuildQueued,true);assert.equal(r.engine.snapshot().rebuild,null);assert.equal(JSON.stringify(r.c.chat),before);
    r.engine.generationEnded();await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(r.engine.snapshot().rebuildQueued,false);assert.equal(r.engine.snapshot().rebuild.pending,1);
    await r.engine.tick();await r.engine.tick();assert.equal(r.engine.snapshot().rebuild.complete,true);assert.equal(r.stats().calls,1);
});

test('dry-run and quiet starts do not latch generation or abort work; real start is preserved',()=>{
    const r=rig();r.engine.controller=new AbortController();r.engine.generationGuard={test:true};
    r.engine.generationStarted('normal',{},true);r.engine.generationStarted('quiet');
    assert.equal(r.engine.generating,false);assert.equal(r.engine.controller.signal.aborted,false);assert.deepEqual(r.engine.generationGuard,{test:true});
    r.engine.generationStarted('normal',{},false);r.engine.generationStarted('quiet');
    assert.equal(r.engine.generating,true);assert.equal(r.engine.controller.signal.aborted,true);
});

test('authoritative idle state repairs a missing generation end and drains the queue without a new reply',async()=>{
    const r=rig();ready(r);let active=true;r.host.generationActive=async()=>active;
    r.engine.generationStarted();await r.engine.refreshAll();assert.equal(r.engine.snapshot().rebuildQueued,true);
    active=false;await r.engine.tick();await r.engine.tick();await r.engine.tick();
    assert.equal(r.engine.snapshot().rebuildQueued,false);assert.equal(r.engine.snapshot().rebuild.complete,true);assert.equal(r.stats().calls,1);
});

test('a late end event cannot drain a queue while the host is still generating',async()=>{
    const r=rig();ready(r);r.host.generationActive=async()=>true;
    await r.engine.refreshAll();r.engine.selectController=new AbortController();await r.engine.generationEnded();await r.engine.tick();
    assert.equal(r.engine.selectController.signal.aborted,false);
    assert.equal(r.engine.snapshot().rebuildQueued,true);assert.equal(r.engine.snapshot().rebuild,null);assert.equal(r.stats().calls,0);
});

test('a delayed idle probe cannot overwrite a newer generation start',async()=>{
    const r=rig();let resolve;r.host.generationActive=()=>new Promise(done=>{resolve=done;});
    const check=r.engine.reconcileGeneration();r.engine.generationStarted();resolve(false);await check;
    assert.equal(r.engine.generating,true);
});

test('cancel queued rebuild preserves the main selection and does not restart after generation ends',async()=>{
    const r=rig();ready(r);const before=JSON.stringify(r.c.chat);r.engine.generationStarted();await r.engine.refreshAll();
    r.engine.selectController=new AbortController();const epoch=r.engine.epoch;
    await r.engine.stopRebuild();assert.equal(r.engine.selectController.signal.aborted,false);assert.equal(r.engine.epoch,epoch);
    assert.equal(r.engine.snapshot().rebuildQueued,false);r.engine.generationEnded();await r.engine.tick();
    assert.equal(r.stats().calls,0);assert.equal(JSON.stringify(r.c.chat),before);assert.equal(r.engine.snapshot().rebuild,null);
});

test('cancelling on the generation-ended boundary prevents a deferred queue from reviving',async()=>{
    const r=rig();ready(r);r.engine.generationStarted();await r.engine.refreshAll();r.engine.generationEnded();
    await r.engine.stopRebuild();await new Promise(resolve=>setTimeout(resolve,0));await r.engine.tick();
    assert.equal(r.engine.snapshot().rebuildQueued,false);assert.equal(r.engine.snapshot().rebuild,null);assert.equal(r.stats().calls,0);
});

test('cancellation during cache commit rolls back the staged job and is not automatically resumed',async()=>{
    const r=rig();let release,entered;const gate=new Promise(done=>{entered=done;}),put=r.cache.putMany.bind(r.cache);let first=true;
    r.cache.putMany=async(...args)=>{await put(...args);if(first){first=false;entered();await new Promise(done=>{release=done;});}};
    const start=r.engine.refreshAll();await gate;const stopping=r.engine.stopRebuild();assert.equal(r.engine.snapshot().stopping,true);
    release();await Promise.all([start,stopping]);await r.engine.tick();
    assert.equal(r.engine.snapshot().rebuild,null);assert.equal(r.c.chat[0].extra[KEY],undefined);assert.equal(r.stats().calls,0);
    assert.equal(await r.cache.get('records','a:'+bookPages(r.c.chat)[0].hash),null);assert.equal(r.cache.owner,null);
});

test('failed chat save restores both records and cache instead of leaving a runnable phantom job',async()=>{
    const r=rig();ready(r);await r.engine.maintenance;const old=structuredClone(bookPages(r.c.chat)[0].record);await r.cache.put('records','a:'+old.hash,old);
    r.host.save=async()=>{throw Error('save rejected');};await assert.rejects(r.engine.refreshAll(),/save rejected/);
    assert.deepEqual(bookPages(r.c.chat)[0].record,old);assert.deepEqual(await r.cache.get('records','a:'+old.hash),old);
    assert.equal(r.engine.resetting,false);assert.equal(r.engine.snapshot().rebuild,null);assert.equal(r.cache.owner,null);
});

test('stop during a slow summary discards its late result and does not resume through automatic memory',async()=>{
    const r=rig();let finish,calls=0;r.host.complete=async()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
    await r.engine.refreshAll();const work=r.engine.tick();await new Promise(resolve=>setTimeout(resolve,0));
    const stopped=r.engine.stopRebuild();finish('{"summary":"取消後才到的結果"}');await Promise.all([work,stopped]);await r.engine.tick();
    assert.equal(calls,1);assert.equal(bookPages(r.c.chat)[0].record.done,false);assert.equal(r.engine.autoPages.size,0);assert.equal(r.engine.snapshot().rebuild.pending,0);
    r.host.complete=async()=>{calls++;return '{"summary":"真正的新回覆"}';};r.c.chat.push(message('未來的新回覆',1));r.engine.newResponse();await r.engine.tick();assert.equal(calls,2);
});

test('cancel during vector work preserves a completed new summary and stops inference',async()=>{
    const r=rig();ready(r);await r.engine.refreshAll();await r.engine.tick();const summary=bookPages(r.c.chat)[0].record.summary;let started;
    const gate=new Promise(resolve=>{started=resolve;});r.embedder.embed=async(_texts,signal)=>new Promise((_resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
    const work=r.engine.tick();await gate;await r.engine.stopRebuild();await work;await r.engine.tick();
    assert.equal(bookPages(r.c.chat)[0].record.summary,summary);assert.equal(bookPages(r.c.chat)[0].record.done,true);assert.equal(r.engine.snapshot().rebuild.pending,0);assert.equal(r.stats().calls,1);
});

test('deleting a pending page while stopping does not prevent stopping the surviving pages',async()=>{
    const r=rig([message('待刪除頁',0),message('仍存在頁',1)]);ready(r);await r.engine.refreshAll();let finish;
    r.host.complete=()=>new Promise(resolve=>{finish=resolve;});const work=r.engine.tick();await new Promise(resolve=>setTimeout(resolve,0));
    const stop=r.engine.stopRebuild();r.c.chat.splice(0,1);r.engine.changed({deleted:true});finish('{"summary":"過時"}');await Promise.all([work,stop]);
    assert.equal(bookPages(r.c.chat)[0].record.summary,'仍存在頁');assert.equal(r.engine.snapshot().rebuild.pending,0);assert.equal(r.engine.stopping,false);
});

test('switching chats drops the waiting request without writing to either chat',async()=>{
    const r=rig();ready(r);const old=JSON.stringify(r.c.chat);r.engine.generationStarted();await r.engine.refreshAll();
    const previous=r.c.chat;r.c.chat=[message('另一聊天',0)];r.c.chatId='b';r.engine.changed();r.engine.generationEnded();await r.engine.tick();
    assert.equal(r.engine.snapshot().rebuildQueued,false);assert.equal(r.c.chat[0].extra[KEY],undefined);assert.equal(JSON.stringify(previous),old);assert.equal(r.stats().calls,0);
});

test('invalid targets are rejected before creating a generation wait queue',async()=>{
    const r=rig([]);r.engine.generationStarted();await assert.rejects(r.engine.refreshAll(),/沒有可整理/);assert.equal(r.engine.queuedRebuild,null);
});

test('generation beginning during setup cannot reset existing records',async()=>{
    const r=rig();ready(r);const before=JSON.stringify(r.c.chat);let release;
    r.engine.maintenance=new Promise(resolve=>{release=resolve;});const pending=r.engine.refreshAll();await new Promise(resolve=>setTimeout(resolve,0));
    r.engine.generationStarted();release();await assert.rejects(pending,/正文已開始/);assert.equal(JSON.stringify(r.c.chat),before);assert.equal(r.engine.resetting,false);
});

test('failed stop persistence suspends further model calls until stop can be saved',async()=>{
    const r=rig();ready(r);await r.engine.refreshAll();const save=r.host.save;r.host.save=async()=>{throw Error('save unavailable');};
    await assert.rejects(r.engine.stopRebuild(),/save unavailable/);await r.engine.tick();await r.engine.tick();
    assert.equal(r.stats().calls,0);assert.equal(r.engine.snapshot().stopFailed,true);assert.equal(r.engine.snapshot().rebuild.pending,1);
    r.host.save=save;await r.engine.stopRebuild();await r.engine.tick();
    assert.equal(r.engine.snapshot().stopFailed,false);assert.equal(r.engine.snapshot().rebuild.pending,0);assert.equal(r.stats().calls,0);
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
test('opening unfinished old chat never summarizes until one-click rebuild',async()=>{
    const r=rig([message('舊聊天正文一',0),message('舊聊天正文二',1)]);r.c.chatId='opened-old-chat';r.engine.changed();
    await r.engine.tick();await r.engine.tick();assert.equal(r.stats().calls,0);assert.equal(bookPages(r.c.chat).every(p=>!p.record),true);
    assert.equal(r.engine.snapshot().auto.active,false);assert.equal(r.engine.snapshot().auto.manualPending,2);
    await r.engine.refreshAll();await r.engine.tick();await r.engine.tick();assert.equal(r.stats().calls,2);assert.equal(bookPages(r.c.chat).every(p=>p.record?.done),true);
});
test('only a response arriving after the old-chat boundary is automatic',async()=>{
    const r=rig([message('舊正文',0)]);r.c.chatId='old-plus-new';r.engine.changed();r.c.chat.push(message('新問題',1,true),message('新回覆',2));r.engine.newResponse();
    await r.engine.tick();assert.equal(r.stats().calls,1);const pages=bookPages(r.c.chat);assert.equal(pages[0].record,null);assert.equal(pages[1].record?.done,true);
    assert.equal(r.engine.snapshot().auto.manualPending,1);
});
test('responses received while automatic memory is off stay manual after re-enabling',async()=>{
    const r=rig([]);r.engine.toggle(false);r.c.chat.push(message('關閉期間的回覆',0));r.engine.newResponse();r.engine.toggle(true);await r.engine.tick();
    assert.equal(r.stats().calls,0);assert.equal(bookPages(r.c.chat)[0].record,null);assert.equal(r.engine.snapshot().auto.manualPending,1);
});
test('editing an old summary explicitly indexes it even while automatic memory is off',async()=>{
    const r=rig();r.c.chatId='edit-old';r.engine.changed();r.engine.toggle(false);const ref=r.engine.snapshot().entries[0].ref;
    await r.engine.editSummary(ref,'玩家手動寫入的舊頁摘要');await r.engine.tick();
    assert.equal(r.stats().calls,0);assert.equal(r.engine.snapshot().entries[0].indexed,true);assert.equal(bookPages(r.c.chat)[0].record.edited,true);
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
    assert.equal(JSON.stringify(source),before);assert.ok(core.some(m=>m.mes===source[1].mes));assert.ok(story(core).length<source.length);
    assert.equal(core.at(-1).mes,source.at(-1).mes);assert.ok(story(core).every(m=>source.some(s=>s.mes===m.mes)));
    assert.deepEqual(story(core).map(m=>m.send_date),[...story(core)].sort((a,b)=>Number(a.send_date.slice(1))-Number(b.send_date.slice(1))).map(m=>m.send_date));
});
test('long-context models keep a fixed recent window, so older pages are really recalled and pointed out',async()=>{
    const pages=Array.from({length:6},(_,i)=>message(i%2?(i===1?'船長把藍色信件交給旅人，約定冬天前送到山城。':'街市的日常。')+'情節。'.repeat(2500):'玩家背景'+i,i,i%2===0));
    const r=rig([...pages,message('那封信後來怎樣？',6,true)]);ready(r);
    r.host.modelLimits=async()=>({model:'deepseek/deepseek-v3.2',context:163840,source:'list',hostContext:2000000,reply:30000,unlocked:true});
    let request;r.host.complete=async(_s,p)=>{request=JSON.parse(p);return '{"ids":["p1"],"reasons":{"p1":"信件約定"}}';};
    const core=structuredClone(r.c.chat);await r.engine.intercept(core,1970000,()=>assert.fail('abort'),'normal');
    const last=r.engine.last;assert.equal(last.limits.capacity,133840);assert.equal(last.limits.tier,'standard');assert.equal(last.budget,64000);
    assert.ok(request.catalogue.length>0,'older pages go through the catalogue on a 2M-slider setting');
    assert.ok(story(core).some(m=>m.send_date==='t1'));assert.ok(!story(core).some(m=>m.send_date==='t3'),'unselected older page is not sent');
    const note=core.find(m=>m.extra?.folio_note);assert.equal(core.indexOf(note),core.length-2);assert.equal(note.extra.type,'narrator');assert.match(note.mes,/第 1 頁/);assert.match(note.mes,/信件約定/);
    assert.deepEqual(last.note.pages,[1]);
    r.engine.captureFinal({type:'normal',messages:[{role:'user',content:core.map(m=>m.mes).join('\n\n')}]});
    assert.equal(last.note.final,true);assert.equal(last.final.dropped,0,'merged roles are not reported as dropped');
    r.host.memory=()=>({recallNote:false});const off=structuredClone(r.c.chat);await r.engine.intercept(off,1970000,()=>assert.fail('abort'),'normal');
    assert.ok(!off.some(m=>m.extra?.folio_note));assert.equal(r.engine.last.note,undefined);
});
test('short player input borrows the latest scene when ranking catalogue pages',async()=>{
    const r=rig([message('背景',0,true),message('港口船長交出藍色信件。',1),message('背景',2,true),message('夜市小吃。',3),message('背景',4,true),message('他握著藍色信件猶豫。',5),message('繼續',6,true)]);ready(r);
    r.engine.embedder.embed=async()=>{throw Error('wasm');};r.host.memory=()=>({recentPages:1});let request;r.host.complete=async(_s,p)=>{request=JSON.parse(p);return '{"ids":[]}';};
    await r.engine.intercept(structuredClone(r.c.chat),10000,()=>assert.fail('abort'),'normal');
    assert.equal(request.catalogue[0].id,'p1');assert.equal(r.engine.last.query,'繼續');
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
test('default summary receives only adjacent raw context and saves evidence anchored to current text',async()=>{
    const before='上一頁由阿璃守在鐘樓，洛嵐站在門外。',current='她把銀色鑰匙交給洛嵐，但沒有離開鐘樓。';
    const r=rig([message(before,0),message('追問鑰匙的去向',1,true),message(current,2)]);ready(r);
    bookPages(r.c.chat)[0].record.summary='錯誤的舊摘要不應成為上下文';delete r.c.chat[2].extra[KEY];let request;
    r.host.advanced=()=>({prompt:''});r.host.complete=async(_system,prompt)=>{request=JSON.parse(prompt);return JSON.stringify({title:'銀色鑰匙',sections:{entities:[{entry:'洛嵐：收到銀色鑰匙',evidence:'銀色鑰匙交給洛嵐'}],events:[{entry:'主體不明：把銀色鑰匙交給洛嵐',evidence:'她把銀色鑰匙交給洛嵐'}],relations:[],open:[]}});};
    await r.engine.tick();assert.equal(request.contextBefore,before);assert.equal(request.playerInput,'追問鑰匙的去向');assert.equal(request.text,current);assert.ok(!request.contextBefore.includes('錯誤的舊摘要'));
    assert.match(bookPages(r.c.chat)[1].record.summary,/主體不明/);
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
test('selected body that cannot fit whole is sent as a relevant source excerpt instead of disappearing',async()=>{
    const old='港口藍色信件的交付約定。'+'無關長段。'.repeat(500),r=rig([message('舊背景',0,true),message(old,1),message('近期背景',2,true),message('近期正文',3),message('藍色信件後來如何？',4,true)]);ready(r);
    r.host.memory=()=>({recentPages:1,recallPages:8});r.host.complete=async()=>'\u007b"ids":["p1"],"reasons":{"p1":"藍色信件約定"}\u007d';
    const core=structuredClone(r.c.chat);await r.engine.intercept(core,800,()=>assert.fail('abort'),'normal');
    const recalled=r.engine.last.items.find(x=>x.index===1);
    assert.equal(recalled.partial,true);assert.match(recalled.body,/港口藍色信件/);assert.ok(recalled.body.length<old.length);assert.equal(r.engine.last.skipped.length,0);
    assert.ok(core.some(m=>m.mes===recalled.body));assert.ok(!core.some(m=>m.mes===old));
});
test('final request audit distinguishes removal and repeated text without double matching',async()=>{
    const r=rig([message('same',0),message('same',1),message('question',2,true)]),core=structuredClone(r.c.chat);
    r.engine.changed();
    await r.engine.intercept(core,10000,()=>{},'normal');r.engine.captureFinal({type:'quiet',messages:[]});assert.equal(r.engine.last.stage,'awaiting-final');
    r.engine.captureFinal({type:'normal',messages:[{role:'assistant',content:'same'},{role:'user',content:'question'}]});
    assert.deepEqual(r.engine.last.items.map(x=>x.final),[true,false,true]);assert.equal(r.engine.last.final.dropped,1);
    const trace=r.engine.last;r.engine.changed();assert.equal(r.engine.last,trace,'new same-chat events preserve audit');
});

test('recalled bodies come from the valid catalogue source even when prompt regex rewrites or empties incoming assistants',async()=>{
    for(const replacement of ['', '已被替換成短摘要']){
        const r=rig([message('前面的玩家背景',0,true),message('<story>舊頁完整正文不能丟失。</story><state_bar>狀態</state_bar>',1),message('最近玩家背景',2,true),message('近期完整正文。',3),message('詢問舊頁',4,true)]);ready(r);
        const before=JSON.stringify(r.c.chat);r.host.memory=()=>({recentPages:1});r.host.complete=async()=>'{"ids":["p1"]}';
        const outgoing=r.c.chat.map(m=>({...m,mes:m.is_user?m.mes:replacement}));await r.engine.intercept(outgoing,10000,()=>assert.fail('abort'),'normal');
        assert.deepEqual(story(outgoing).map(m=>m.mes),['前面的玩家背景','舊頁完整正文不能丟失。','最近玩家背景','近期完整正文。','詢問舊頁']);
        r.engine.captureFinal({type:'normal',messages:outgoing.map(m=>({role:m.is_user?'user':'assistant',content:m.mes}))});
        assert.equal(r.engine.last.items.filter(x=>x.role==='assistant'&&x.final).length,2);
        assert.equal(r.engine.last.items.find(x=>x.index===0).pageIndex,1);assert.equal(r.engine.last.items.find(x=>x.index===2).pageIndex,3);
        assert.equal(r.engine.last.items.find(x=>x.index===4).pageIndex,undefined);assert.equal(JSON.stringify(r.c.chat),before);
    }
});

test('narrator body is audited against the native system role but remains a body in the receipt',async()=>{
    const r=rig([{...message('旁白正文',0),extra:{type:'narrator'}},message('玩家提問',1,true)]);ready(r);
    const out=structuredClone(r.c.chat);await r.engine.intercept(out,10000,()=>assert.fail('abort'),'normal');
    r.engine.captureFinal({type:'normal',messages:[{role:'system',content:'旁白正文'},{role:'user',content:'玩家提問'}]});
    assert.equal(r.engine.last.items[0].role,'assistant');assert.equal(r.engine.last.items[0].wireRole,'system');assert.equal(r.engine.last.items[0].final,true);
});

test('uncatalogued prompt transforms and wholly removed visible pages are not silently restored',async()=>{
    const r=rig([message('未整理正文',0),message('已被其他插件移除的正文',1),message('最近正文',2),message('玩家提問',3,true)]);ready(r);delete r.c.chat[0].extra[KEY];
    const incoming=[{...r.c.chat[0],mes:'未整理頁的宿主副本'},...structuredClone(r.c.chat.slice(2))];r.host.memory=()=>({recentPages:1});
    await r.engine.intercept(incoming,10000,()=>assert.fail('abort'),'normal');
    assert.equal(incoming[0].mes,'未整理頁的宿主副本');assert.equal(incoming.some(m=>m.send_date==='t1'),false);assert.equal(r.engine.last.mode,'building');
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
    r.c.chat.push(message('全新故事',0));r.engine.newResponse();await r.engine.tick();assert.equal(r.stats().calls,2);assert.equal(bookPages(r.c.chat)[0].record.hash,sourceOf(r.c.chat[0]).hash);
});

let sentSequence=0;
async function sent(r,label='生成回覆'){
    const core=structuredClone(r.c.chat);await r.engine.intercept(core,10000,()=>assert.fail('aborted'),'normal');
    r.engine.captureFinal({type:'normal',messages:core.map(m=>({role:m.is_user?'user':'assistant',content:m.mes}))});
    const sequence=++sentSequence;r.c.chat.push(message(`${label}-${sequence}`,1000+sequence));r.engine.newResponse();
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
    assert.equal(r.engine.snapshot().usages.length,0);assert.equal(r.engine.snapshot().usageStoredCount,0,'A request without a reply must not consume a journal slot');
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

test('editing or hiding a surviving reply does not erase its latest usage, including reload',async()=>{
    const r=rig();const first=await sent(r);r.c.chat.at(-1).mes+='（玩家修正文句）';r.c.chat.at(-1).is_system=true;r.engine.changed();
    assert.equal(r.engine.snapshot().usages[0]?.id,first.id);
    const reopened=new Engine(r.host,r.cache,r.embedder);reopened.schedule=()=>{};reopened.changed();await settle();
    assert.equal(reopened.snapshot().usages[0]?.id,first.id);
});

test('continue replaces content and timestamp in place but binds the same surviving floor',async()=>{
    const r=rig();const first=await sent(r),core=structuredClone(r.c.chat);
    await r.engine.intercept(core,10000,()=>assert.fail('abort'),'continue');
    r.engine.captureFinal({type:'continue',messages:core.map(m=>({role:m.is_user?'user':'assistant',content:m.mes}))});
    const id=r.engine.last.id;r.c.chat.at(-1).mes+='續寫正文';r.c.chat.at(-1).send_date='continued';
    r.engine.newResponse({messageId:r.c.chat.length-1,type:'continue'});await r.engine.usageWrite;
    assert.equal(r.engine.snapshot().usages[0]?.id,id);assert.equal(r.engine.snapshot().usages.length,2);
    r.c.chat.pop();r.engine.changed({deleted:true});assert.equal(r.engine.snapshot().usages.length,0);
    assert.notEqual(first.id,id);
});

test('failed requests cannot evict the last successful receipt from the bounded journal',async()=>{
    const r=rig();const first=await sent(r);
    for(let i=0;i<25;i++){
        const core=structuredClone(r.c.chat);await r.engine.intercept(core,10000,()=>{},'normal');
        r.engine.captureFinal({type:'normal',messages:core.map(m=>({role:m.is_user?'user':'assistant',content:m.mes}))});
        await r.engine.generationEnded();
    }
    await r.engine.usageWrite;assert.equal(r.engine.snapshot().usages[0]?.id,first.id);
    assert.equal((await r.cache.get('records','usage:a')).length,1);
});

test('native swipe event binds a new variant and navigation restores the old variant receipt',async()=>{
    const r=rig([message('問題',0,true)]);const first=await sent(r),old=structuredClone(r.c.chat.at(-1)),reply=r.c.chat.at(-1);
    const core=structuredClone(r.c.chat.slice(0,-1));await r.engine.intercept(core,10000,()=>{},'swipe');
    r.engine.captureFinal({type:'swipe',messages:core.map(m=>({role:m.is_user?'user':'assistant',content:m.mes}))});
    const id=r.engine.last.id;reply.swipe_id=1;reply.mes='新候選回覆';reply.send_date='new-swipe';
    r.engine.newResponse({messageId:r.c.chat.length-1,type:'swipe'});await r.engine.usageWrite;
    assert.equal(r.engine.snapshot().usages[0].id,id);assert.equal(r.engine.snapshot().usages.length,1);
    assert.ok(r.engine.autoPages.has(reply),'Actual regenerated reply must enter auto-memory');
    const next=structuredClone(reply);Object.keys(reply).forEach(k=>delete reply[k]);Object.assign(reply,old);r.engine.changed();
    assert.equal(r.engine.snapshot().usages[0].id,first.id);
    Object.assign(reply,next);r.engine.changed();assert.equal(r.engine.snapshot().usages[0].id,id);
});

test('ordinary UI cancellation after send does not lose the eventual reply association',async()=>{
    const r=rig();const core=structuredClone(r.c.chat);await r.engine.intercept(core,10000,()=>{},'normal');
    r.engine.captureFinal({type:'normal',messages:core.map(m=>({role:'assistant',content:m.mes}))});
    const id=r.engine.last.id;r.engine.toggle(false);r.c.chat.push(message('仍然回來的正文',8));r.engine.newResponse({messageId:1,type:'normal'});
    await r.engine.usageWrite;assert.equal(r.engine.snapshot().usages[0].id,id);
});

test('generation end binds a finished reply if the receive notification was missed',async()=>{
    const r=rig();const core=structuredClone(r.c.chat);await r.engine.intercept(core,10000,()=>{},'normal');
    r.engine.captureFinal({type:'normal',messages:core.map(m=>({role:'assistant',content:m.mes}))});
    const id=r.engine.last.id;r.c.chat.push(message('收到但未通知',2));await r.engine.generationEnded();await r.engine.usageWrite;
    assert.equal(r.engine.snapshot().usages[0].id,id);
});

test('empty failed stream and cancelled chat switch never bind an unrelated later reply',async()=>{
    const r=rig();const core=structuredClone(r.c.chat);await r.engine.intercept(core,10000,()=>{},'normal');
    r.engine.captureFinal({type:'normal',messages:core.map(m=>({role:'assistant',content:m.mes}))});
    r.c.chat.push(message('',2));await r.engine.generationEnded();r.c.chat.at(-1).mes='手動補字';r.engine.newResponse();
    assert.equal(r.engine.snapshot().usages.length,0);
    await r.engine.intercept(structuredClone(r.c.chat),10000,()=>{},'normal');r.engine.captureFinal({type:'normal',messages:[]});
    r.c.chatId='b';r.engine.changed();r.c.chat.push(message('另一個聊天',5));r.engine.newResponse();assert.equal(r.engine.snapshot().usages.length,0);
});

test('chat backup restores receipts even if the browser journal is missing or unreadable',async()=>{
    const r=rig();const first=await sent(r);const backup=structuredClone(r.engine.usages);
    r.host.readUsage=()=>backup;const cache=new MemoryCache();cache.get=async()=>{throw Error('storage unavailable');};
    const reopened=new Engine(r.host,cache,r.embedder);reopened.schedule=()=>{};reopened.changed();await settle();
    assert.equal(reopened.snapshot().usages[0].id,first.id);assert.equal(reopened.snapshot().usageLoading,false);
    assert.match(reopened.snapshot().usageError,/已顯示聊天/);
});

test('legacy exact binding upgrades to a persistent reply ID; already missing old bindings stay inspectable',async()=>{
    const r=rig();const first=await sent(r);const legacy=structuredClone(first);delete legacy.result.messageId;delete legacy.result.swipeId;delete legacy.receiptVersion;
    const missing={...structuredClone(legacy),id:'missing-old',result:{sourceStamp:'never-found'},final:{observedAt:0}};
    await r.cache.put('records','usage:a',[legacy,missing]);await r.cache.put('records','trace:a',null);
    const reopened=new Engine(r.host,r.cache,r.embedder);reopened.schedule=()=>{};reopened.changed();await settle();await reopened.usageWrite;
    assert.ok(reopened.snapshot().usages[0].result.messageId);assert.equal(reopened.snapshot().usageArchive[0].id,'missing-old');
    r.c.chat.at(-1).mes+=' changed';reopened.changed();assert.equal(reopened.snapshot().usages[0].id,first.id);
});

test('settings view reports the model window and flags an unlocked host slider',async()=>{
    const r=rig();r.c.chatCompletionSettings={openai_max_context:2000000,openai_max_tokens:30000};
    r.host.modelLimits=async()=>({model:'deepseek/deepseek-v3.2',context:163840,source:'list',hostContext:2000000,reply:30000,unlocked:true});
    r.engine.refreshLimits();await new Promise(resolve=>setTimeout(resolve,0));
    const c=r.engine.snapshot().capacity;assert.equal(c.capacity,133840);assert.equal(c.recent,12000);assert.equal(c.recentPages,4);assert.equal(c.recallPages,6);assert.ok(c.hostContext>c.context);
    r.host.memory=()=>({recentPages:2,recallPages:8,historyBudget:20000});const custom=r.engine.snapshot().capacity;
    assert.equal(custom.history,20000);assert.equal(custom.recentPages,2);assert.equal(custom.recallPages,8);
});

test('recall note quotes the recalled source text unchanged apart from whitespace',async()=>{
    const r=rig([message('背景',0,true),message('The captain signs   the ships\nlog at sunset.',1),message('背景',2,true),message('Later scene.',3),message('What did the captain sign?',4,true)]);ready(r);
    r.host.memory=()=>({recentPages:1});r.host.complete=async()=>'{"ids":["p1"],"reasons":{"p1":"captain signs"}}';
    const core=structuredClone(r.c.chat);await r.engine.intercept(core,10000,()=>assert.fail('abort'),'normal');
    assert.match(core.find(m=>m.extra?.folio_note).mes,/The captain signs the ships log at sunset\./);
});

test('history squashed into one user message with an assistant prefill is still audited as sent',async()=>{
    const r=rig([message('第一段玩家輸入，說明要去港口。',0,true),message('船長在港口交出藍色信件，約定冬天前送到山城。',1),message('第二段玩家輸入，問信件內容。',2,true),message('旅人拆開信，看見山城城主的封印與一張地圖。',3),message('繼續',4,true)]);ready(r);
    const core=structuredClone(r.c.chat);await r.engine.intercept(core,10000,()=>assert.fail('abort'),'normal');
    const wrapped=core.map((m,i)=>m.is_user?`<dream_instruction id='uid_${i+1}'>\n${m.mes}\n</dream_instruction>`:`<dream_plot id='uid_${i+1}'>\n${m.mes}\n</dream_plot>`).join('\n\n');
    r.engine.captureFinal({type:'normal',messages:[{role:'system',content:'預設'},{role:'user',content:wrapped},{role:'assistant',content:'<dream_plot>'}]});
    assert.equal(r.engine.last.final.dropped,0);assert.ok(r.engine.last.items.filter(x=>x.role==='assistant').every(x=>x.final===true));
    r.engine.captureFinal({type:'normal',messages:[]});
});

test('pages not sent in full reach the model as a chronological digest that degrades oldest first',async()=>{
    const source=[];for(let i=0;i<8;i++){source.push(message('玩家'+i,2*i,true),message(`第${i}段正文`+'。'.repeat(300),2*i+1));}source.push(message('現在怎麼辦？',16,true));
    const r=rig(source);ready(r);bookPages(r.c.chat).forEach((p,i)=>{p.record.summary=`事件與結果：第${i}段的事\n關係與狀態：狀態${i}`;p.record.title='標題'+i;});
    r.host.memory=()=>({recentPages:2});r.host.complete=async()=>'{"ids":["p11"],"reasons":{"p11":"相關"}}';
    const core=structuredClone(r.c.chat);await r.engine.intercept(core,20000,()=>assert.fail('abort'),'normal');
    const digest=core[0];assert.equal(digest.extra.folio_summary,true);assert.equal(digest.extra.type,'narrator');
    assert.deepEqual(r.engine.last.summary.pages,[1,2,3,4,5],'recalled page 6 and recent pages 7-8 are not repeated');
    assert.match(digest.mes,/第 1 頁〈標題0〉：事件與結果：第0段的事；關係與狀態：狀態0/);assert.ok(digest.mes.indexOf('第 1 頁')<digest.mes.indexOf('第 5 頁'));
    assert.ok(!digest.mes.includes('第5段的事'),'the recalled page is sent as body, not summary');
    const pages=[...r.engine.last.summary.pages];
    // A tight budget turns the oldest entries into titles, then omits them with a count.
    r.host.memory=()=>({recentPages:2,historyBudget:500});r.host.complete=async()=>'{"ids":[]}';
    const tight=structuredClone(r.c.chat);await r.engine.intercept(tight,20000,()=>assert.fail('abort'),'normal');const s=r.engine.last.summary;
    assert.ok(s.titleOnly.length>0||s.omitted>0);if(s.titleOnly.length)assert.equal(s.titleOnly[0],s.pages[0],'oldest degrade first');
    assert.ok(s.tokens<=500);if(s.omitted)assert.match(tight[0].mes,/更早 \d+ 頁因容量省略/);
    r.host.memory=()=>({recentPages:2,summaryBlock:false});const off=structuredClone(r.c.chat);await r.engine.intercept(off,20000,()=>assert.fail('abort'),'normal');
    assert.ok(!off.some(m=>m.extra?.folio_summary));assert.equal(r.engine.last.summary,undefined);assert.ok(pages.length);
    r.engine.captureFinal({type:'normal',messages:[]});
});

test('summaries stay in story order around a recalled page in the middle',async()=>{
    const source=[];for(let i=0;i<8;i++){source.push(message('玩家'+i,2*i,true),message(`第${i}段正文`+'。'.repeat(300),2*i+1));}source.push(message('現在怎麼辦？',16,true));
    const r=rig(source);ready(r);bookPages(r.c.chat).forEach((p,i)=>{p.record.summary=`事件與結果：第${i}段的事`;p.record.title='標題'+i;});
    r.host.memory=()=>({recentPages:2});r.host.complete=async()=>'{"ids":["p5"],"reasons":{"p5":"相關"}}';
    const core=structuredClone(r.c.chat);await r.engine.intercept(core,20000,()=>assert.fail('abort'),'normal');
    const shape=core.map(m=>m.extra?.folio_summary?`digest:${[...m.mes.matchAll(/第 (\d+) 頁/g)].map(x=>x[1]).join(',')}`:m.extra?.folio_note?'note':m.send_date);
    assert.deepEqual(shape,['digest:1,2','t4','t5','digest:4,5,6','t12','t13','t14','t15','note','t16']);
    assert.match(core[0].mes,/^\[前情摘要：/);assert.match(core[3].mes,/^\[前情摘要（續）/);
    assert.deepEqual(r.engine.last.summary.pages,[1,2,4,5,6]);assert.equal(r.engine.last.summary.parts.length,2);
    r.engine.captureFinal({type:'normal',messages:[{role:'user',content:core.map(m=>m.mes).join('\n\n')}]});assert.equal(r.engine.last.summary.final,true);
});
