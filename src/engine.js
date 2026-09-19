import { KEY, MODEL, bookPages, newRecord, migrateRecord, splitBody, summaryChunks, fingerprint, cleanBody,
    excerpt, parsePageSummary, parseSelection, selectionReasons, rankCandidates, budgetFor, recentPages, SUMMARY_SYSTEM, SELECT_SYSTEM } from './core.js';
import { uid } from './host.js';

export class Engine {
    constructor(host, cache, embedder, notify = () => {}) {
        Object.assign(this,{host,cache,embedder,notify});
        this.owner=uid(); this.timer=null; this.controller=null; this.selectController=null;
        this.running=false; this.generating=false; this.epoch=0; this.failures=0; this.disposed=false;
        this.vectors=new Map(); this.currentIdentity=''; this.vectorRetryAt=0; this.conflict='';
        this.last=null; this.awaitingFinal=false; this.activity=[]; this.work=null; this.connectionTest=null;
        this.status='等待開啟聊天'; this.warning='';
    }
    pages() { return bookPages(this.host.context().chat ?? []); }
    snapshot() {
        const entries=this.pages().map(p=>({index:p.index,number:p.number,name:p.name,body:p.body,raw:p.message.mes,
            playerInput:p.playerInput,title:p.record?.title||excerpt(p.body,32),summary:p.record?.summary||p.record?.parts?.join('\n')||'',
            ready:!!p.record?.done,indexed:!!p.record?.done&&this.vectors.has(this.vectorKey(p.record)),pinned:!!p.record?.pinned,
            parts:p.record?.parts?.length??0,totalParts:splitBody(p.body).length,edited:!!p.record?.edited}));
        const helper=this.host.helper?.()??{};
        return {entries,total:entries.length,ready:entries.filter(p=>p.ready).length,indexed:entries.filter(p=>p.indexed).length,
            status:this.status,warning:this.warning,last:this.last,model:this.host.model,enabled:this.host.settings().enabled,
            conflict:this.conflict,work:this.work,activity:this.activity,connectionTest:this.connectionTest,busy:this.running||!!this.selectController,
            helper:{label:helper.label,model:helper.model,automatic:helper.automatic},
            profiles:(this.host.profiles?.()??[]).map(p=>({id:p.id,name:p.name,model:p.model})),
            helperConnection:this.host.settings().helperConnection??'auto',helperModel:this.host.settings().helperModel??''};
    }
    emit() { this.notify(this.snapshot()); }
    log(message) { this.activity.unshift({time:Date.now(),message}); this.activity.length=Math.min(50,this.activity.length); }
    setStatus(text) { this.status=this.conflict?'Anima 仍啟用；書頁暫停，避免重複處理歷史':text; this.emit(); }
    schedule(ms=1800) { clearTimeout(this.timer); if(!this.disposed)this.timer=setTimeout(()=>{this.tick().catch(()=>{});},ms); }
    cancel() { this.epoch++;this.controller?.abort();this.selectController?.abort();this.awaitingFinal=false; }
    changed() {
        this.cancel();this.warning='';this.failures=0;
        const identity=this.host.identity();
        if(identity!==this.currentIdentity){
            this.vectors.clear();this.last=null;this.activity=[];this.currentIdentity=identity;
            if(identity)this.cache.get('records','trace:'+identity).then(trace=>{if(identity===this.currentIdentity&&!this.last&&trace){this.last=trace;this.emit();}}).catch(()=>{});
        }
        this.setStatus(identity?'正在檢查書頁目錄':'等待開啟聊天');this.schedule();
    }
    generationStarted() { this.generating=true;this.controller?.abort(); }
    generationEnded() { this.generating=false;this.selectController?.abort();this.schedule(); }
    toggle(enabled) {
        this.host.settings().enabled=enabled;this.host.context().saveSettingsDebounced();this.cancel();
        if(!enabled)this.embedder.stop();this.setStatus(enabled?'正在檢查書頁目錄':'已暫停；使用酒館原本的歷史');this.schedule();
    }
    retry() { this.failures=0;this.vectorRetryAt=0;this.warning='';this.schedule(0);this.emit(); }
    async savePage(page,record) {
        await this.cache.put('records',this.host.identity()+':'+record.hash,structuredClone(record));
        page.message.extra??={};page.message.extra[KEY]=record;await this.host.save();this.emit();
    }
    async pin(index) {
        const p=this.pages().find(p=>p.index===index);if(!p)return;
        const r=structuredClone(p.record??newRecord(p.message,p.playerInput));r.pinned=!r.pinned;await this.savePage(p,r);
    }
    async refresh(index) {
        const p=this.pages().find(p=>p.index===index);if(!p)return;this.cancel();
        const r=newRecord(p.message,p.playerInput);r.pinned=!!p.record?.pinned;await this.savePage(p,r);
        this.log(`第 ${p.number} 頁已排入重新整理`);this.retry();
    }
    async editSummary(index,summary) {
        const p=this.pages().find(p=>p.index===index),text=cleanBody(summary).slice(0,3000);if(!p||!text)return;
        this.cancel();const r=structuredClone(p.record??newRecord(p.message,p.playerInput));
        Object.assign(r,{summary:text,parts:[text],done:true,edited:true,title:r.title||excerpt(text,32)});
        await this.savePage(p,r);this.log(`已保存第 ${p.number} 頁的人工摘要`);this.retry();
    }
    vectorKey(record) { return MODEL+':'+fingerprint(record.summary); }
    async tick() {
        if(this.conflict)return;
        if(this.disposed||this.running||this.generating||this.selectController||!this.host.settings().enabled){this.schedule();return;}
        const c=this.host.context(),identity=this.host.identity();
        if(!identity||!c.chat?.length){this.setStatus('等待開啟聊天');return;}
        if(c.mainApi!=='openai'){this.setStatus('等待「聊天補全」連線');return;}
        this.running=true;const controller=new AbortController();this.controller=controller;
        const epoch=this.epoch,signal=controller.signal;let locked=false,renew=null,nextDelay=700;
        const active=p=>{
            signal.throwIfAborted();
            if(this.disposed||epoch!==this.epoch||identity!==this.host.identity()||!this.host.settings().enabled||
                this.pages().find(x=>x.message===p.message)?.source!==p.source)throw new DOMException('Changed','AbortError');
        };
        try{
            locked=await this.cache.lease(identity,this.owner);
            if(!locked){this.setStatus('另一個視窗正在整理；這裡會自動更新');nextDelay=5000;return;}
            renew=setInterval(()=>this.cache.lease(identity,this.owner).then(ok=>{if(!ok)controller.abort();}).catch(()=>controller.abort()),25000);
            let target=null;
            for(const p of this.pages()){
                let r=p.record;
                if(!r){r=migrateRecord(p);if(r){active(p);await this.savePage(p,r);this.log(`沿用第 ${p.number} 頁已有的摘要`);}}
                const cached=!r?.done?await this.cache.get('records',identity+':'+p.hash):null;active(p);
                if(cached?.source===p.source&&!r?.done&&(cached.done||(cached.parts?.length??0)>(r?.parts?.length??0))){
                    r={...structuredClone(cached),pinned:r?.pinned??cached.pinned};await this.savePage(p,r);active(p);
                }
                if(!r?.done){target={...p,record:structuredClone(r??newRecord(p.message,p.playerInput))};break;}
                if(!this.vectors.has(this.vectorKey(r))&&Date.now()>=this.vectorRetryAt){
                    this.work={stage:'vector',page:p.number};this.setStatus(`正在建立第 ${p.number} 頁的本機向量`);
                    try{const vectors=await this.embedder.embed(summaryChunks(r.summary),signal);active(p);this.vectors.set(this.vectorKey(r),vectors);this.warning='';}
                    catch(e){active(p);this.vectorRetryAt=Date.now()+60000;this.warning='向量暫不可用；摘要繼續整理，暫時使用文字檢索';}
                }
            }
            if(!target){this.work=null;this.setStatus('已就緒；新正文會自動整理');nextDelay=15000;return;}
            const p=target,r=p.record,parts=splitBody(p.body);
            this.work={stage:'summary',page:p.number,part:r.parts.length+1,total:parts.length};
            this.setStatus(`正在整理第 ${p.number} 頁（${r.parts.length+1}/${parts.length} 段）`);active(p);
            if(parts[r.parts.length]!==undefined){
                const raw=await this.host.complete(SUMMARY_SYSTEM,JSON.stringify({speaker:p.name,playerInput:excerpt(p.playerInput,1200),text:parts[r.parts.length]}),{signal});active(p);
                const parsed=parsePageSummary(raw);r.parts.push(parsed.summary);r.title||=parsed.title;
            }
            Object.assign(r,{summary:r.parts.join('\n'),done:r.parts.length===parts.length,model:this.host.model,updatedAt:Date.now()});
            await this.cache.put('records',identity+':'+r.hash,structuredClone(r));active(p);
            p.message.extra??={};p.message.extra[KEY]=r;await this.host.save();active(p);
            this.failures=0;this.warning='';if(r.done)this.log(`第 ${p.number} 頁摘要完成：${r.title}`);this.emit();
        }catch(e){
            if(!signal.aborted&&e.name!=='AbortError'){this.failures++;nextDelay=Math.min(300000,10000*2**Math.min(this.failures,5));this.warning=String(e.message??e);this.setStatus('暫時無法整理；會自動重試，聊天仍可使用');}
        }finally{
            clearInterval(renew);if(locked)await this.cache.lease(identity,this.owner,true).catch(()=>{});
            if(this.controller===controller)this.controller=null;this.running=false;this.work=null;this.emit();this.schedule(nextDelay);
        }
    }
    sourceIndex(message) {
        const chat=this.host.context().chat,direct=chat.indexOf(message);if(direct>=0)return direct;
        const matches=chat.map((m,i)=>({m,i})).filter(({m})=>m.send_date===message.send_date&&m.name===message.name&&!!m.is_user===!!message.is_user);
        return matches.length===1?matches[0].i:matches.find(({m})=>m.mes===message.mes)?.i??-1;
    }
    rememberTrace(trace) {
        this.last=trace;this.emit();const identity=this.host.identity();
        if(identity)this.cache.put('records','trace:'+identity,structuredClone(trace)).catch(()=>{});
    }
    async intercept(chat,contextSize,abort,type,options={}) {
        if(this.conflict||this.host.context().mainApi!=='openai'||!this.host.settings().enabled||['quiet','impersonate'].includes(type)||!chat.length)return;
        if(chat.some(m=>m.extra?.tool_invocations?.length||m.extra?.media?.length)){
            this.warning='這次含工具或多媒體訊息，保留酒館原本的歷史處理';this.emit();return;
        }
        this.controller?.abort();this.selectController?.abort();this.awaitingFinal=false;
        const controller=new AbortController();this.selectController=controller;
        const signal=controller.signal,identity=this.host.identity(),epoch=this.epoch;
        const active=()=>{signal.throwIfAborted();if(identity!==this.host.identity()||epoch!==this.epoch)throw new DOMException('Chat changed','AbortError');};
        try{
            const original=[...chat],cleaned=original.map(m=>m.is_user?m:{...m,mes:cleanBody(m.mes)}),costs=[];
            for(const m of cleaned){active();costs.push(await this.host.count(m.mes));}
            const budget=budgetFor(contextSize),recent=recentPages(cleaned,costs,budget.recent);
            const sourcePages=this.pages();
            const entries=bookPages(cleaned).map(p=>{
                const sourceIndex=this.sourceIndex(original[p.index]),source=sourcePages.find(x=>x.index===sourceIndex),r=source?.record;
                return {...p,i:p.index,index:sourceIndex,id:`p${sourceIndex}`,number:source?.number??p.number,title:r?.title||excerpt(p.body,32),summary:r?.summary??'',ready:!!r?.done,pinned:!!r?.pinned,record:r};
            });
            const older=entries.filter(p=>!recent.picked.has(p.i));
            const query=options.query||cleanBody(original.findLast(m=>m.is_user)?.mes??original.at(-1).mes);
            const trace={id:uid(),createdAt:Date.now(),preview:!!options.preview,query,mode:'recent',budget:budget.history,beforeTokens:costs.reduce((a,b)=>a+b,0),candidates:[],items:[],skipped:[]};
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
            trace.items=ordered.map((i,j)=>({index:this.sourceIndex(original[i]),number:entries.find(p=>p.i===i)?.number,name:original[i].name,role:original[i].is_user?'user':'assistant',body:result[j].mes,reason:reasons.get(i)??'目錄整理中，保留原歷史',recent:recent.picked.has(i),final:null}));
            Object.assign(trace,{tokens:used,model:this.host.model,stage:options.preview?'preview':'awaiting-final'});
            if(!options.preview){chat.splice(0,chat.length,...result);this.awaitingFinal=true;}
            this.warning=warning;this.log(options.preview?'選頁試跑完成，未生成正文':`已提交 ${trace.items.length} 則歷史，等待酒館最終組裝`);
            this.rememberTrace(trace);this.setStatus(options.preview?'選頁試跑完成':'歷史已選好；等待酒館最終請求');
        }catch(e){
            if(signal.aborted||e.name==='AbortError'){if(!options.preview)abort?.(true);return;}
            this.warning='這次查頁未完成；保留酒館原本的歷史';this.emit();
        }finally{if(this.selectController===controller)this.selectController=null;this.emit();}
    }
    captureFinal(body) {
        if(!this.awaitingFinal||!this.last||body.type==='quiet'||!Array.isArray(body.messages))return;
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
        this.last.stage='observed';this.last.final={observedAt:Date.now(),messageCount:messages.length,kept:this.last.items.filter(x=>x.final).length,dropped:this.last.items.filter(x=>!x.final).length};
        this.log(`已核對送往後端前的歷史：${this.last.final.kept} 則找到完整內容`);this.rememberTrace(this.last);
    }
    async preview(query='') {
        if(this.generating)throw new Error('請等這次正文生成完成後再試跑');
        const c=this.host.context(),chat=structuredClone((c.chat??[]).filter(m=>!m.is_system));
        if(query.trim())chat.push({mes:query,name:c.name1??'玩家',is_user:true,send_date:'folio-preview'});
        const settings=c.chatCompletionSettings??{},contextSize=Math.max(1024,(Number(settings.openai_max_context)||8192)-(Number(settings.openai_max_tokens)||0));
        await this.intercept(chat,contextSize,null,'normal',{preview:true,query});return this.last;
    }
    async testHelper() {
        if(this.generating)throw new Error('請等正文生成完成後再測試');
        this.controller?.abort();this.selectController?.abort();const controller=new AbortController();this.selectController=controller;
        const start=performance.now();this.connectionTest={pending:true};this.emit();
        try{
            const raw=await this.host.complete(SUMMARY_SYSTEM,JSON.stringify({speaker:'連線測試',playerInput:'請保存信件。',text:'船長將藍色信件交給旅人，約定冬天前送到山城。'}),{signal:controller.signal});
            this.connectionTest={ok:true,model:this.host.model,ms:Math.round(performance.now()-start),...parsePageSummary(raw)};
        }catch(e){this.connectionTest={ok:false,error:String(e.message??e)};}
        finally{if(this.selectController===controller)this.selectController=null;this.emit();this.schedule();}
    }
    dispose() { this.disposed=true;clearTimeout(this.timer);this.cancel();this.embedder.stop();this.cache.close(); }
}
