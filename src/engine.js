import { KEY, MODEL, bookPages, newRecord, migrateRecord, splitBody, summaryChunks, fingerprint, cleanBody, chatStamps, samePrefix, messageHandle,
    excerpt, parsePageSummary, parseSelection, selectionReasons, rankCandidates, budgetFor, recentPages, SUMMARY_SYSTEM, SELECT_SYSTEM } from './core.js';
import { uid } from './host.js';
import { mergeUsage, usageView } from './usage.js';

export class Engine {
    constructor(host, cache, embedder, notify = () => {}) {
        Object.assign(this,{host,cache,embedder,notify});
        this.owner=uid(); this.timer=null; this.controller=null; this.selectController=null;
        this.running=false; this.generating=false; this.epoch=0; this.failures=0; this.disposed=false;
        this.vectors=new Map(); this.currentIdentity=''; this.vectorRetryAt=0; this.conflict='';
        this.last=null; this.awaitingFinal=false; this.activity=[]; this.work=null; this.connectionTests={summary:null,selection:null};
        this.observedStamps=[];this.traceLoad=0;this.notice='';this.maintenance=Promise.resolve();this.generationGuard=null;
        this.status='等待開啟聊天'; this.warning='';
        this.resetting=false;this.idle=Promise.resolve();this.queuedRebuild=null;
        this.usages=[];this.usageIdentity='';this.usageLoad=0;this.usageWrite=Promise.resolve();this.usageError='';this.pendingUsage=null;
        this.autoPages=new Set();this.seenPages=new Set();this.indexPages=new Set();
    }
    pages() { const identity=this.host.identity();return bookPages(this.host.context().chat ?? []).map(p=>({...p,identity})); }
    pendingRebuild(record){return !!record?.rebuild&&!record.rebuild.cancelled&&(!record.done||(!record.rebuild.indexed&&!record.rebuild.vectorFallback));}
    rebuildState(pages=this.pages()) {
        const records=pages.map(p=>p.record).filter(r=>r?.rebuild);
        const newest=records.reduce((last,r)=>!last||r.rebuild.requestedAt>last.requestedAt?r.rebuild:last,null);
        if(!newest)return null;
        const group=records.filter(r=>r.rebuild.id===newest.id),pending=group.filter(r=>this.pendingRebuild(r)).length;
        return {id:newest.id,total:newest.total,done:group.filter(r=>r.done&&!r.rebuild.cancelled).length,pending,
            cancelled:group.filter(r=>r.rebuild.cancelled).length,removed:Math.max(0,newest.total-group.length),
            vectors:group.filter(r=>r.rebuild.indexed&&!r.rebuild.cancelled).length,vectorFallback:group.some(r=>r.rebuild.vectorFallback),complete:pending===0};
    }
    traceValid(trace){return trace&&samePrefix(trace.stamps,chatStamps(this.host.context().chat??[]));}
    loadUsage(identity) {
        this.usages=[];this.usageIdentity=identity;this.usageError='';const load=++this.usageLoad;
        if(!identity)return;
        this.cache.get('records','usage:'+identity).then(records=>{
            if(load!==this.usageLoad||identity!==this.host.identity())return;
            this.usages=mergeUsage(this.usages,Array.isArray(records)?records:[]);this.emit();
        }).catch(()=>{if(load===this.usageLoad){this.usageError='發送紀錄暫時無法讀取，請稍後重新開啟聊天';this.emit();}});
    }
    rememberUsage(trace,identity=this.host.identity()) {
        if(!identity||!mergeUsage([trace]).length)return;
        const receipt=structuredClone(trace);
        if(identity===this.host.identity()){
            if(this.usageIdentity!==identity)this.loadUsage(identity);
            this.usages=mergeUsage([receipt],this.usages);
        }
        const records=identity===this.usageIdentity?structuredClone(this.usages):[receipt];
        this.usageWrite=this.usageWrite.catch(()=>{}).then(()=>this.cache.appendUsage(identity,records)).then(saved=>{
            if(identity===this.host.identity()&&identity===this.usageIdentity){this.usages=mergeUsage(this.usages,saved);this.usageError='';this.emit();}
        }).catch(()=>{if(identity===this.host.identity()){this.usageError='發送紀錄暫時只保留在此視窗：本機保存失敗，請檢查瀏覽器儲存空間';this.emit();}});
    }
    responseReceived({replacement=false}={}) {
        const pending=this.pendingUsage;if(!pending||pending.identity!==this.host.identity())return;
        const chat=this.host.context().chat??[],stamps=chatStamps(chat);let index=pending.stamps.length;
        if(!samePrefix(pending.stamps,stamps)){
            const replaced=replacement&&stamps.length===pending.stamps.length&&index>0&&samePrefix(pending.stamps.slice(0,-1),stamps.slice(0,-1));
            if(!replaced)return;index--;
        }
        while(index<chat.length&&(chat[index].is_user||chat[index].is_system))index++;
        if(index>=chat.length)return;
        const receipt=this.usages.find(x=>x.id===pending.id);if(!receipt)return;
        const result={sourceStamp:stamps[index],index,boundAt:Date.now()};receipt.result=result;this.pendingUsage=null;
        if(this.last?.id===receipt.id){this.last.result=result;this.rememberTrace(this.last);}else this.emit();
        this.rememberUsage(receipt,pending.identity);
    }
    invalidateTrace(){
        this.last=null;this.awaitingFinal=false;this.traceLoad++;this.notice='聊天內容已改變；待發送的選頁已失效，已發送紀錄保留。下次將從現有正文重新查頁。';
        const identity=this.host.identity();if(identity)this.cache.put('records','trace:'+identity,null).catch(()=>{});
    }
    prune(){
        const pages=this.pages(),keys=new Set(pages.filter(p=>p.record?.done).map(p=>this.vectorKey(p.record)));
        for(const key of this.vectors.keys())if(!keys.has(key))this.vectors.delete(key);
        const identity=this.host.identity();
        this.maintenance=this.maintenance.catch(()=>{}).then(()=>this.cache.pruneRecords?.(identity,pages.map(p=>p.hash))).catch(()=>{this.warning='本機舊快取清理失敗；刪除頁仍不會參與查詢，稍後可重試';});
    }
    snapshot() {
        if(this.last&&!this.traceValid(this.last))this.invalidateTrace();
        const pages=this.pages(),entries=pages.map(p=>({index:p.index,ref:{chat:p.identity,handle:messageHandle(p.message),hash:p.hash},number:p.number,name:p.name,body:p.body,raw:p.message.mes,
            playerInput:p.playerInput,title:p.record?.title||p.record?.rebuild?.previous?.title||excerpt(p.body,32),summary:(!p.record?.done?p.record?.rebuild?.previous?.summary:'')||p.record?.summary||p.record?.parts?.join('\n')||'',
            ready:!!p.record?.done,indexed:!!p.record?.done&&this.vectors.has(this.vectorKey(p.record)),pinned:!!p.record?.pinned,
            rebuilding:this.pendingRebuild(p.record),rebuilt:!!p.record?.done&&!!p.record?.rebuild&&!p.record.rebuild.cancelled,previousSummary:!p.record?.done&&!!p.record?.rebuild?.previous?.summary,
            parts:p.record?.parts?.length??0,totalParts:splitBody(p.body).length,edited:!!p.record?.edited,automatic:this.autoPages.has(p.message)}));
        const helpers=Object.fromEntries(['summary','selection'].map(role=>{const h=this.host.helper?.(role)??{};return [role,{connection:h.connection??'current',label:h.label,model:h.model??'',lastModel:this.host.models?.[role]??'',provider:h.provider??'',baseUrl:h.baseUrl??'',hasKey:!!h.hasKey}];}));
        const chat=this.host.context().chat??[],usageRecords=this.usageIdentity===this.host.identity()?usageView(this.usages,chatStamps(chat),chat.map(m=>m.is_system?'system':m.is_user?'user':'assistant')).filter(x=>x.resultState==='present'):[];
        const total=entries.length,ready=entries.filter(p=>p.ready).length,indexed=entries.filter(p=>p.indexed).length,rebuild=this.rebuildState();
        const automaticEntries=entries.filter((_,i)=>this.autoPages.has(pages[i].message)),automaticTotal=automaticEntries.length;
        const automaticReady=automaticEntries.filter(p=>p.ready).length,automaticIndexed=automaticEntries.filter(p=>p.indexed).length;
        const pendingSummaries=automaticEntries.filter(p=>!p.ready&&!p.rebuilding).length,pendingVectors=automaticEntries.filter(p=>p.ready&&!p.indexed&&!p.rebuilding).length;
        const manualPending=entries.filter((p,i)=>!this.autoPages.has(pages[i].message)&&!p.rebuilding&&!p.ready).length;
        const automatic=!!this.host.settings().enabled&&!!this.host.identity()&&this.host.context().mainApi==='openai'&&!this.conflict&&!rebuild?.pending;
        const automaticWorking=!!this.work&&automaticEntries.some(p=>p.number===this.work.page);
        const phase=this.work?.stage==='vector'?'vector':this.work?.stage==='summary'?'summary':pendingSummaries?'summary':pendingVectors?'vector':'complete';
        const auto={active:automatic&&automaticTotal>0&&(automaticWorking||pendingSummaries>0||pendingVectors>0),available:automatic,total:automaticTotal,ready:automaticReady,indexed:automaticIndexed,phase,
            done:phase==='vector'?automaticIndexed:automaticReady,pendingSummaries,pendingVectors,manualPending,catalogueTotal:total,current:this.work?{...this.work}:null,
            waitingForGeneration:this.generating,complete:automaticTotal>0&&automaticReady===automaticTotal&&automaticIndexed===automaticTotal};
        return {entries,total,ready,indexed,
            status:this.status,warning:this.warning,last:this.last,model:this.host.model,enabled:this.host.settings().enabled,
            conflict:this.conflict,work:this.work,activity:this.activity,connectionTests:this.connectionTests,busy:this.running||!!this.selectController||this.resetting,notice:this.notice,helpers,
            resetting:this.resetting,rebuild,rebuildQueued:this.queuedRebuild?.identity===this.host.identity(),generating:this.generating,chatIdentity:this.host.identity(),auto,
            usages:usageRecords,usageStoredCount:this.usageIdentity===this.host.identity()?this.usages.length:0,usageError:this.usageError,
            profiles:(this.host.profiles?.()??[]).map(p=>({id:p.id,name:p.name,model:p.model}))};
    }
    emit() { this.notify(this.snapshot()); }
    log(message) { this.activity.unshift({time:Date.now(),message}); this.activity.length=Math.min(50,this.activity.length); }
    setStatus(text) { this.status=this.conflict?'Anima 仍啟用；書頁暫停，避免重複處理歷史':text; this.emit(); }
    schedule(ms=1800) { clearTimeout(this.timer); if(!this.disposed)this.timer=setTimeout(()=>{this.tick().catch(()=>{});},ms); }
    cancel() { this.epoch++;this.controller?.abort();this.selectController?.abort();this.awaitingFinal=false;this.pendingUsage=null; }
    changed({deleted=false}={}) {
        this.cancel();this.warning='';this.failures=0;
        const identity=this.host.identity(),stamps=chatStamps(this.host.context().chat??[]);
        if(identity!==this.currentIdentity){
            this.queuedRebuild=null;
            this.vectors.clear();this.autoPages.clear();this.indexPages.clear();this.last=null;this.activity=[];this.notice='';this.currentIdentity=identity;const load=++this.traceLoad;
            this.loadUsage(identity);
            if(identity)this.cache.get('records','trace:'+identity).then(trace=>{if(identity===this.currentIdentity&&load===this.traceLoad&&!this.last&&trace){
                if(trace.final&&!trace.preview)this.rememberUsage(trace,identity);
                if(this.traceValid(trace))this.last=trace;else this.invalidateTrace();this.emit();}}).catch(()=>{});
            this.prune();
        }else if(deleted||!samePrefix(this.observedStamps,stamps)){
            this.invalidateTrace();this.activity=[];
            this.log(deleted?'已刪除樓層：重新核對書頁；已發送紀錄保留':'正文已變更：待發送選頁失效，已發送紀錄保留');
            if(deleted)this.prune();
        }
        const livePages=new Set(this.pages().map(p=>p.message));for(const set of [this.autoPages,this.indexPages])for(const message of set)if(!livePages.has(message))set.delete(message);this.seenPages=livePages;
        this.observedStamps=stamps;
        this.setStatus(identity?'已就緒；舊聊天只在一鍵重新整理時處理':'等待開啟聊天');this.schedule();
    }
    newResponse({replacement=false}={}) {
        this.responseReceived({replacement});const pages=this.pages(),live=new Map(pages.map(p=>[p.message,p]));
        for(const message of this.autoPages)if(!live.has(message))this.autoPages.delete(message);
        const unfinished=[...this.autoPages].some(message=>{const p=live.get(message),r=p?.record;return p&&(!r?.done||!this.vectors.has(this.vectorKey(r)));});
        if(!unfinished)this.autoPages.clear();
        const candidates=pages.filter(p=>!this.seenPages.has(p.message));if(replacement&&pages.length&&!candidates.includes(pages.at(-1)))candidates.push(pages.at(-1));
        const allowed=this.host.settings().enabled&&!!this.host.identity()&&this.host.context().mainApi==='openai'&&!this.conflict;
        if(allowed)for(const p of candidates)this.autoPages.add(p.message);
        this.seenPages=new Set(pages.map(p=>p.message));
        if(allowed&&candidates.length)this.setStatus(`新回覆已加入自動整理；舊聊天不會自動處理`);else this.emit();
        this.schedule();
    }
    generationStarted() { this.generating=true;this.generationGuard=null;this.controller?.abort();this.emit(); }
    generationEnded() {
        this.generating=false;this.selectController?.abort();this.emit();this.schedule();
        const request=this.queuedRebuild;if(!request)return;
        this.queuedRebuild=null;
        Promise.resolve().then(()=>this.refreshAll(request.identity)).catch(e=>{
            if(request.identity!==this.host.identity())return;
            this.warning=String(e.message??e);this.setStatus('未能啟動已排隊的重新整理；請檢查提示後再按一次');
        });
    }
    toggle(enabled) {
        this.host.settings().enabled=enabled;this.host.context().saveSettingsDebounced();this.cancel();
        if(!enabled)this.embedder.stop();this.setStatus(enabled?'已開啟；只會處理接下來的新回覆':this.rebuildState()?.pending?'新回覆自動記憶已暫停；手動重整仍會繼續':'已暫停；舊聊天保持原狀');this.schedule();
    }
    retry() { this.failures=0;this.vectorRetryAt=0;this.warning='';this.schedule(0);this.emit(); }
    assertPage(page){if(page.identity!==this.host.identity()||this.pages().find(p=>p.message===page.message)?.source!==page.source)throw new DOMException('這頁已刪除或變更，操作已取消','AbortError');}
    assertPages(pages){const identity=this.host.identity(),live=new Map(this.pages().map(p=>[p.message,p]));
        for(const p of pages)if(p.identity!==identity||live.get(p.message)?.source!==p.source)throw new DOMException('這頁已刪除或變更，操作已取消','AbortError');return live;}
    resolvePage(ref){
        const page=typeof ref==='number'?this.pages().find(p=>p.index===ref):this.pages().find(p=>p.identity===ref?.chat&&messageHandle(p.message)===ref.handle&&p.hash===ref.hash);
        if(!page)throw new Error('這頁已刪除或變更，請重新選擇書頁');return page;
    }
    async savePage(page,record) {
        this.assertPage(page);await this.cache.put('records',page.identity+':'+record.hash,structuredClone(record));this.assertPage(page);
        page.message.extra??={};page.message.extra[KEY]=record;await this.host.save();this.emit();
    }
    async pin(index) {
        const p=this.resolvePage(index);
        const r=structuredClone(p.record??newRecord(p.message,p.playerInput));r.pinned=!r.pinned;await this.savePage(p,r);
    }
    async refresh(index) {return this.queueRebuild([this.resolvePage(index)]);}
    async refreshAll(identity=this.host.identity()) {
        if(identity!==this.host.identity())throw new Error('聊天已切換，請在目前聊天重新操作');
        if(this.resetting||this.rebuildState()?.pending||this.queuedRebuild)throw new Error('已有重整任務，請等完成或先停止本次重整');
        if(this.generating){
            this.queuedRebuild={identity,requestedAt:Date.now()};this.warning='';
            this.log('已接受一鍵重新整理；本次角色回覆完成後開始');
            this.setStatus('一鍵重新整理已排隊；等待本次角色回覆完成');return;
        }
        return this.queueRebuild(this.pages());
    }
    async persistRebuild(pairs) {
        this.assertPages(pairs.map(([p])=>p));
        await this.cache.putMany('records',pairs.map(([p,r])=>[p.identity+':'+r.hash,structuredClone(r)]));
        this.assertPages(pairs.map(([p])=>p));
        for(const [p,r]of pairs){if(p.record?.summary)this.vectors.delete(this.vectorKey(p.record));p.message.extra??={};p.message.extra[KEY]=r;}
        await this.host.save();
    }
    async queueRebuild(pages) {
        if(!pages.length)throw new Error('這段聊天沒有可整理的正文，請先開啟聊天');
        if(this.resetting||this.rebuildState()?.pending)throw new Error('已有重整任務，請等完成或先停止本次重整');
        if(this.conflict)throw new Error('Anima 仍在接管記憶，請先停用衝突插件');
        if(this.generating)throw new Error('正文正在生成，完成後再重新整理');
        if(this.host.context().mainApi!=='openai')throw new Error('請先使用酒館「聊天補全」模式');
        const helper=this.host.helper?.('summary');if(helper&&!helper.model)throw new Error('請先在記憶助手填寫總結模型');
        const identity=pages[0].identity;let locked=false;
        this.resetting=true;this.cancel();this.setStatus('正在建立手動重整任務…');
        try{
            await this.idle;await this.maintenance;this.assertPages(pages);
            locked=await this.cache.lease(identity,this.owner);if(!locked)throw new Error('另一個視窗正在整理，請稍後再試；原摘要未改動');
            const live=this.assertPages(pages),job={id:uid(),requestedAt:[...live.values()].reduce((n,p)=>Math.max(n,(p.record?.rebuild?.requestedAt??0)+1),Date.now()),total:pages.length};
            const pairs=pages.map(p=>{const current=live.get(p.message)?.record;
                const previous=current?structuredClone(current):null;if(previous)delete previous.rebuild;
                const r={...newRecord(p.message,p.playerInput),pinned:!!current?.pinned,revision:uid(),rebuild:{...job,previous}};return [p,r];});
            await this.persistRebuild(pairs);this.invalidateTrace();this.notice='記憶正在重整；待發送選頁已失效，已發送紀錄保留。';
            this.log(pages.length===1?`第 ${pages[0].number} 頁已排入優先重整`:`已排入 ${pages.length} 頁全文重整`);
            this.failures=0;this.vectorRetryAt=0;this.warning='';this.setStatus(`已排入 ${pages.length} 頁重整；不受自動記憶開關影響`);
        }catch(e){
            if(identity===this.host.identity()){this.warning=String(e.message??e);this.setStatus('未能啟動重整；請檢查錯誤後重試');}throw e;
        }finally{
            if(locked)await this.cache.lease(identity,this.owner,true).catch(()=>{});this.resetting=false;this.emit();this.schedule(0);
        }
    }
    async stopRebuild() {
        if(this.resetting)throw new Error('正在保存任務，請稍後再停止');
        const pages=this.pages().filter(p=>this.pendingRebuild(p.record));if(!pages.length)return;
        this.resetting=true;this.cancel();let locked=false;const identity=pages[0].identity;
        try{
            await this.idle;this.assertPages(pages);locked=await this.cache.lease(identity,this.owner);
            if(!locked)throw new Error('另一個視窗正在整理，請稍後再停止');
            const live=this.assertPages(pages);
            const pairs=pages.map(p=>{
                const current=live.get(p.message).record;
                // A completed summary is retained even if its vector step was pending.
                const r=structuredClone(current.done?current:current.rebuild.previous??newRecord(p.message,p.playerInput));
                r.pinned=current.pinned;r.revision=uid();r.rebuild={...current.rebuild,cancelled:!current.done,indexed:!!current.rebuild.indexed};delete r.rebuild.previous;
                if(current.done&&!r.rebuild.indexed)r.rebuild.vectorFallback=true;return [p,r];
            });
            await this.persistRebuild(pairs);this.warning='';this.log('已停止本次重整；未完成頁已恢復原摘要，完成頁保留新結果');this.setStatus('本次重整已停止');
        }catch(e){
            if(identity===this.host.identity()){this.warning=String(e.message??e);this.setStatus('未能停止重整；請檢查錯誤後重試');}throw e;
        }finally{if(locked)await this.cache.lease(identity,this.owner,true).catch(()=>{});this.resetting=false;this.emit();this.schedule();}
    }
    async editSummary(index,summary) {
        const p=this.resolvePage(index),text=cleanBody(summary).slice(0,3000);if(!text)throw new Error('摘要不能為空白');
        this.cancel();const r=structuredClone(p.record??newRecord(p.message,p.playerInput));
        Object.assign(r,{summary:text,parts:[text],done:true,edited:true,title:r.title||excerpt(text,32)});
        await this.savePage(p,r);this.indexPages.add(p.message);this.log(`已保存第 ${p.number} 頁的人工摘要`);this.retry();
    }
    vectorKey(record) { return MODEL+':'+fingerprint(record.summary); }
    async tick() {
        if(this.conflict)return;
        const pages=this.pages(),manual=pages.filter(p=>this.pendingRebuild(p.record)),manualMode=manual.length>0;
        const requestedIndexes=pages.filter(p=>this.indexPages.has(p.message)&&p.record?.done&&!this.vectors.has(this.vectorKey(p.record))),indexMode=!manualMode&&requestedIndexes.length>0;
        if(this.disposed||this.resetting||this.running||this.generating||this.selectController||(!this.host.settings().enabled&&!manualMode&&!indexMode)){this.schedule();return;}
        const c=this.host.context(),identity=this.host.identity();
        if(!identity||!c.chat?.length){this.setStatus('等待開啟聊天');return;}
        if(c.mainApi!=='openai'){this.setStatus('等待「聊天補全」連線');return;}
        const automatic=pages.filter(p=>this.autoPages.has(p.message)&&(!p.record?.done||!this.vectors.has(this.vectorKey(p.record))));
        if(!manualMode&&!indexMode&&!automatic.length){this.setStatus('已就緒；只會自動整理接下來的新回覆');this.schedule(15000);return;}
        this.running=true;let idleDone;this.idle=new Promise(resolve=>{idleDone=resolve;});const controller=new AbortController();this.controller=controller;
        const epoch=this.epoch,signal=controller.signal;let locked=false,renew=null,nextDelay=700;
        const active=p=>{
            signal.throwIfAborted();
            const current=this.pages().find(x=>x.message===p.message);
            if(this.disposed||epoch!==this.epoch||identity!==this.host.identity()||current?.source!==p.source||
                (current.record?.revision??'')!==(p.record?.revision??'')||(!this.host.settings().enabled&&!manualMode&&!indexMode))throw new DOMException('Changed','AbortError');
        };
        try{
            await this.maintenance;signal.throwIfAborted();
            locked=await this.cache.lease(identity,this.owner);
            if(!locked){this.setStatus('另一個視窗正在整理；這裡會自動更新');nextDelay=5000;return;}
            renew=setInterval(()=>this.cache.lease(identity,this.owner).then(ok=>{if(!ok)controller.abort();}).catch(()=>controller.abort()),25000);
            let target=null;
            for(const p of manualMode?manual:indexMode?requestedIndexes:automatic){
                let r=p.record;
                if(!r){r=migrateRecord(p);if(r){active(p);await this.savePage(p,r);this.log(`沿用第 ${p.number} 頁已有的摘要`);}}
                const cached=!r?.done?await this.cache.get('records',identity+':'+p.hash):null;active(p);
                if(cached?.source===p.source&&!r?.done&&(!r||(cached.revision??'')===(r.revision??''))&&(cached.done||(cached.parts?.length??0)>(r?.parts?.length??0))){
                    r={...structuredClone(cached),pinned:r?.pinned??cached.pinned};await this.savePage(p,r);p.record=r;active(p);
                }
                if(!r?.done){target={...p,record:structuredClone(r??newRecord(p.message,p.playerInput))};break;}
                if(!this.vectors.has(this.vectorKey(r))&&Date.now()>=this.vectorRetryAt){
                    this.work={stage:'vector',page:p.number};this.setStatus(`正在建立第 ${p.number} 頁的本機向量`);
                    try{const vectors=await this.embedder.embed(summaryChunks(r.summary),signal);active(p);this.vectors.set(this.vectorKey(r),vectors);this.warning='';}
                    catch(e){active(p);this.vectorRetryAt=Date.now()+60000;this.warning='向量暫不可用；摘要繼續整理，暫時使用文字檢索';}
                }
                if(manualMode){r.rebuild.indexed=this.vectors.has(this.vectorKey(r));r.rebuild.vectorFallback=!r.rebuild.indexed;await this.savePage(p,r);active(p);}
                if(indexMode&&this.vectors.has(this.vectorKey(r)))this.indexPages.delete(p.message);
            }
            if(!target){this.work=null;this.setStatus(manualMode?this.warning?'重整摘要已完成；向量暫用文字檢索':'本次重新整理已完成':indexMode?this.warning?'人工摘要已保存；向量暫用文字檢索':'人工摘要與向量已就緒':'已就緒；只會自動整理接下來的新回覆');nextDelay=manualMode?700:15000;return;}
            const p=target,r=p.record,parts=splitBody(p.body);
            this.work={stage:'summary',page:p.number,part:r.parts.length+1,total:parts.length};
            this.setStatus(`正在整理第 ${p.number} 頁（${r.parts.length+1}/${parts.length} 段）`);active(p);
            if(parts[r.parts.length]!==undefined){
                const raw=await this.host.complete(SUMMARY_SYSTEM,JSON.stringify({speaker:p.name,playerInput:excerpt(p.playerInput,1200),text:parts[r.parts.length]}),{signal});active(p);
                const parsed=parsePageSummary(raw);r.parts.push(parsed.summary);r.title||=parsed.title;
            }
            Object.assign(r,{summary:r.parts.join('\n'),done:r.parts.length===parts.length,model:this.host.models?.summary??this.host.model,updatedAt:Date.now()});
            if(r.done&&r.rebuild)delete r.rebuild.previous;
            await this.cache.put('records',identity+':'+r.hash,structuredClone(r));active(p);
            p.message.extra??={};p.message.extra[KEY]=r;await this.host.save();active(p);
            this.failures=0;this.warning='';if(r.done)this.log(`第 ${p.number} 頁摘要完成：${r.title}`);this.emit();
        }catch(e){
            if(!signal.aborted&&e.name!=='AbortError'){this.failures++;nextDelay=Math.min(300000,10000*2**Math.min(this.failures,5));this.warning=String(e.message??e);this.setStatus('暫時無法整理；會自動重試，聊天仍可使用');}
        }finally{
            clearInterval(renew);if(locked)await this.cache.lease(identity,this.owner,true).catch(()=>{});
            if(this.controller===controller)this.controller=null;this.running=false;this.work=null;this.emit();this.schedule(nextDelay);idleDone();
        }
    }
    sourceIndex(message) {
        const chat=this.host.context().chat,direct=chat.indexOf(message);if(direct>=0)return direct;
        const matches=chat.map((m,i)=>({m,i})).filter(({m})=>m.send_date===message.send_date&&m.name===message.name&&!!m.is_user===!!message.is_user);
        if(matches.length===1)return matches[0].i;
        const exact=matches.filter(({m})=>m.mes===message.mes);return exact.length===1?exact[0].i:-1;
    }
    rememberTrace(trace) {
        this.last=trace;this.notice='';this.emit();const identity=this.host.identity();
        if(identity)this.cache.put('records','trace:'+identity,structuredClone(trace)).catch(()=>{});
    }
    async intercept(chat,contextSize,abort,type,options={}) {
        if(this.conflict||this.host.context().mainApi!=='openai'||!this.host.settings().enabled||['quiet','impersonate'].includes(type)||!chat.length)return;
        if(chat.some(m=>m.extra?.tool_invocations?.length||m.extra?.media?.length)){
            this.warning='這次含工具或多媒體訊息，保留酒館原本的歷史處理';this.emit();return;
        }
        this.controller?.abort();this.selectController?.abort();this.awaitingFinal=false;
        const controller=new AbortController();this.selectController=controller;
        const signal=controller.signal,identity=this.host.identity(),epoch=this.epoch,stamps=chatStamps(this.host.context().chat??[]),objects=[...(this.host.context().chat??[])];
        const active=()=>{signal.throwIfAborted();const current=this.host.context().chat??[];
            if(identity!==this.host.identity()||epoch!==this.epoch||current.length!==objects.length||current.some((m,i)=>m!==objects[i])||!samePrefix(stamps,chatStamps(current)))throw new DOMException('Chat changed','AbortError');};
        try{
            active();
            const original=[...chat],cleaned=original.map(m=>m.is_user?m:{...m,mes:cleanBody(m.mes)}),costs=[];
            for(const m of cleaned){active();costs.push(await this.host.count(m.mes));}
            active();
            if(original.some(m=>this.sourceIndex(m)<0&&!(options.preview&&m.send_date==='folio-preview')))throw new DOMException('Ambiguous or deleted message','AbortError');
            const budget=budgetFor(contextSize),recent=recentPages(cleaned,costs,budget.recent);
            const sourcePages=this.pages();
            const entries=bookPages(cleaned).map(p=>{
                const sourceIndex=this.sourceIndex(original[p.index]),source=sourcePages.find(x=>x.index===sourceIndex),r=source?.record;
                return {...p,i:p.index,index:sourceIndex,id:`p${sourceIndex}`,number:source?.number??p.number,title:r?.title||excerpt(p.body,32),summary:r?.summary??'',ready:!!r?.done,pinned:!!r?.pinned,record:r};
            });
            const older=entries.filter(p=>!recent.picked.has(p.i));
            const query=options.query||cleanBody(original.findLast(m=>m.is_user)?.mes??original.at(-1).mes);
            const trace={id:uid(),stamps,createdAt:Date.now(),preview:!!options.preview,query,mode:'recent',budget:budget.history,beforeTokens:costs.reduce((a,b)=>a+b,0),candidates:[],items:[],skipped:[]};
            let chosen=new Set(recent.picked),used=recent.used,warning='';
            const reasons=new Map([...chosen].map(i=>[i,cleaned[i].is_user?'近期玩家輸入':'近期正文']));
            if(older.some(p=>!p.ready)){
                trace.mode='building';warning=`${older.filter(p=>!p.ready).length} 頁舊正文尚未完成摘要；這次保留原歷史，不用正文節錄冒充目錄`;
                chosen=new Set(original.map((_,i)=>i));used=trace.beforeTokens;this.schedule();
            }else if(older.length){
                this.setStatus('正在用小摘要查頁；選中後才取回正文');trace.mode='hybrid';
                for(const p of older){
                    p.vectors=this.vectors.get(this.vectorKey(p.record));
                    if(!p.vectors&&this.embedder.cached){p.vectors=await this.embedder.cached(summaryChunks(p.summary));if(p.vectors?.length)this.vectors.set(this.vectorKey(p.record),p.vectors);}
                }
                let queryVector=null;
                try{[queryVector]=await this.embedder.embed([excerpt(query,400)],signal,true);}
                catch(e){active();trace.mode='lexical';warning='向量暫不可用，這次以文字匹配查頁';}
                active();
                const candidates=rankCandidates(older,query,queryVector,18);let ids=[],selectedReasons={};
                if(candidates.length){
                    try{
                        const raw=await this.host.complete(SELECT_SYSTEM,JSON.stringify({query:excerpt(query,1800),recentContext:excerpt(cleanBody(cleaned.findLast(m=>!m.is_user)?.mes??''),700),
                            catalogue:candidates.map(p=>({id:p.id,title:p.title,summary:excerpt(p.summary,900)}))}),{signal,selection:true});
                        active();ids=parseSelection(raw,candidates);selectedReasons=selectionReasons(raw,ids);
                    }catch(e){active();trace.mode='fallback';warning='選頁助手暫不可用，這次使用最相關的目錄匹配';ids=candidates.filter(p=>p.lexical>0||p.semantic>.5).slice(0,3).map(p=>p.id);}
                }
                trace.candidates=candidates.map(p=>({id:p.id,index:p.index,number:p.number,title:p.title,summary:p.summary,semantic:p.semantic,lexical:p.lexical,selected:ids.includes(p.id)||p.pinned,reason:p.pinned?'已釘選':selectedReasons[p.id]??(ids.includes(p.id)?'匹配備援':'助手未選用')}));
                for(const p of [...older.filter(p=>p.pinned),...ids.map(id=>candidates.find(p=>p.id===id)).filter(Boolean)]){
                    if(chosen.has(p.i))continue;
                    const positions=[...p.userIndices,p.i].filter(i=>!chosen.has(i)),cost=positions.reduce((n,i)=>n+costs[i],0);
                    if(used+cost>Math.max(budget.history,recent.used)){trace.skipped.push({index:p.index,number:p.number,tokens:cost,reason:'完整正文與當時玩家輸入超出剩餘容量'});continue;}
                    for(const i of positions){chosen.add(i);reasons.set(i,cleaned[i].is_user?'所選正文的玩家背景':p.pinned?'已釘選':selectedReasons[p.id]??'目錄選中');}used+=cost;
                }
            }
            active();const ordered=[...chosen].sort((a,b)=>a-b);
            // While the catalogue is incomplete, do not change even the source formatting.
            const result=ordered.map(i=>trace.mode==='building'?original[i]:cleaned[i]);
            trace.items=ordered.map((i,j)=>({index:this.sourceIndex(original[i]),sourceStamp:stamps[this.sourceIndex(original[i])],number:entries.find(p=>p.i===i)?.number,title:entries.find(p=>p.i===i)?.title,name:original[i].name,role:original[i].is_user?'user':'assistant',body:result[j].mes,reason:reasons.get(i)??'目錄整理中，保留原歷史',recent:recent.picked.has(i),final:null}));
            Object.assign(trace,{tokens:used,model:trace.candidates.length?(this.host.models?.selection??this.host.model):'',stage:options.preview?'preview':'awaiting-final'});
            if(!options.preview){chat.splice(0,chat.length,...result);this.awaitingFinal=true;this.generationGuard={identity,stamps};}
            this.warning=warning;this.log(options.preview?'選頁試跑完成，未生成正文':`已提交 ${trace.items.length} 則歷史，等待酒館最終組裝`);
            this.rememberTrace(trace);this.setStatus(options.preview?'選頁試跑完成':'歷史已選好；等待酒館最終請求');
        }catch(e){
            if(signal.aborted||e.name==='AbortError'){this.invalidateTrace();if(!options.preview)abort?.(true);return;}
            this.warning='這次查頁未完成；保留酒館原本的歷史';this.emit();
        }finally{if(this.selectController===controller)this.selectController=null;this.emit();}
    }
    captureFinal(body) {
        if(body.type==='quiet')return;
        if(this.generationGuard&&Array.isArray(body.messages)){
            const guard=this.generationGuard,current=chatStamps(this.host.context().chat??[]);this.generationGuard=null;
            if(guard.identity!==this.host.identity()||current.length!==guard.stamps.length||!samePrefix(guard.stamps,current)){
                const reason='查頁後聊天已刪除或變更，本次生成已取消，請重新發送。';
                this.invalidateTrace();this.warning=reason;
                // ST catches listener exceptions. Block serialization of this particular stale
                // request as well as aborting native generation; never patch global fetch.
                body.messages=[];Object.defineProperty(body,'toJSON',{configurable:true,value(){throw new Error(reason);}});
                try{this.host.context().stopGeneration?.();}catch{}
                this.setStatus('已阻止過期歷史送出');return;
            }
        }
        if(!this.awaitingFinal||!this.last||this.last.preview||body.type==='quiet'||!Array.isArray(body.messages))return;
        if(!this.traceValid(this.last)){this.invalidateTrace();this.emit();return;}
        this.awaitingFinal=false;const normalize=s=>String(s??'').replace(/\s+/g,' ').trim();
        const messages=body.messages.map(m=>({role:m.role,text:normalize(Array.isArray(m.content)?m.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'):m.content),used:[]}));
        for(const item of this.last.items){
            let value=item.body;try{value=this.host.context().substituteParams?.(value)??value;}catch{}
            const needle=normalize(value);item.final=false;
            if(!needle)continue;
            for(const m of messages){
                if(m.role!==item.role)continue;
                let at=m.text.indexOf(needle);
                while(at>=0&&m.used.some(([a,b])=>at<b&&at+needle.length>a))at=m.text.indexOf(needle,at+1);
                if(at>=0){m.used.push([at,at+needle.length]);item.final=true;break;}
            }
        }
        this.last.stage='observed';this.last.final={observedAt:Math.max(Date.now(),(this.usages[0]?.final?.observedAt??0)+1),messageCount:messages.length,kept:this.last.items.filter(x=>x.final).length,dropped:this.last.items.filter(x=>!x.final).length};
        this.pendingUsage={identity:this.host.identity(),id:this.last.id,stamps:[...this.last.stamps]};
        this.rememberUsage(this.last);
        this.log(`已核對送往後端前的歷史：${this.last.final.kept} 則找到完整內容`);this.rememberTrace(this.last);this.setStatus('本次歷史已核對；記錄可在「本次取用」查看');
    }
    async preview(query='') {
        if(this.generating)throw new Error('請等這次正文生成完成後再試跑');
        const c=this.host.context(),chat=structuredClone((c.chat??[]).filter(m=>!m.is_system));
        if(query.trim())chat.push({mes:query,name:c.name1??'玩家',is_user:true,send_date:'folio-preview'});
        const settings=c.chatCompletionSettings??{},contextSize=Math.max(1024,(Number(settings.openai_max_context)||8192)-(Number(settings.openai_max_tokens)||0));
        await this.intercept(chat,contextSize,null,'normal',{preview:true,query});return this.last;
    }
    async testHelper(role='summary') {
        if(!['summary','selection'].includes(role))throw new Error('未知模型用途');
        if(this.generating)throw new Error('請等正文生成完成後再測試');
        this.controller?.abort();this.selectController?.abort();const controller=new AbortController();this.selectController=controller;
        const start=performance.now(),selection=role==='selection';this.connectionTests[role]={pending:true};this.emit();
        try{
            const catalogue=[{id:'letter',summary:'船長交付藍色信件，約定冬天前送到山城。'},{id:'dinner',summary:'旅人在街市吃了一碗牛肉麵。'}];
            const input=selection?{query:'連線測試：船長的信應在甚麼時候送到哪裡？',catalogue}:{speaker:'連線測試',playerInput:'請保存信件。',text:'船長將藍色信件交給旅人，約定冬天前送到山城。'};
            const raw=await this.host.complete(selection?SELECT_SYSTEM:SUMMARY_SYSTEM,JSON.stringify(input),{signal:controller.signal,selection});controller.signal.throwIfAborted();
            let parsed;if(selection){const ids=parseSelection(raw,catalogue);if(!ids.includes('letter')||ids.includes('dinner'))throw new Error('模型有回應，但未通過提取測試：應選信件，不應選晚餐');parsed={summary:'成功從兩段小摘要選出信件正文。',ids};}else parsed=parsePageSummary(raw);
            this.connectionTests[role]={ok:true,model:this.host.models?.[role]??this.host.model,ms:Math.round(performance.now()-start),...parsed};
        }catch(e){this.connectionTests[role]={ok:false,error:String(e.message??e)};}
        finally{if(this.selectController===controller)this.selectController=null;this.emit();this.schedule();}
    }
    dispose() { this.disposed=true;clearTimeout(this.timer);this.cancel();this.embedder.stop();this.cache.close(); }
}
