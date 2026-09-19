let nextId=0;
function el(tag,cls='',text=''){const n=document.createElement(tag);n.className=cls;if(text)n.textContent=text;return n;}
function button(text,action,cls=''){const n=el('button',cls,text);n.type='button';n.addEventListener('click',action);return n;}
function info(text){
    const wrap=el('span','folio-help'),tip=el('span','folio-tip',text);tip.id=`folio-help-${++nextId}`;tip.hidden=true;
    const b=button('ⓘ',()=>{tip.hidden=!tip.hidden;b.setAttribute('aria-expanded',String(!tip.hidden));},'folio-info');
    b.setAttribute('aria-label','說明');b.setAttribute('aria-expanded','false');b.setAttribute('aria-controls',tip.id);wrap.append(b,tip);return wrap;
}
function heading(text,help){const n=el('h3','',text);if(help)n.append(info(help));return n;}
function disclosure(label,text,cls=''){const n=el('details',cls);n.append(el('summary','',label),el('div','folio-prose',text));return n;}
const stamp=t=>new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});

export function mountUI(engine){
    const menu=document.querySelector('#extensionsMenu');if(!menu)throw new Error('找不到輸入欄魔法棒選單');
    let state=engine.snapshot(),tab='run',selected=null,editing=false,shown=60;
    const entry=button('',()=>open(),'list-group-item flex-container flexGap5 interactable');entry.id='folio-wand';
    const icon=el('i','fa-fw fa-solid fa-book-open extensionsMenuExtensionButton');icon.setAttribute('aria-hidden','true');
    const badge=el('span','folio-menu-status');entry.append(icon,el('span','','書頁記憶'),badge);menu.append(entry);
    const dialog=el('dialog','folio-dialog');dialog.setAttribute('aria-label','書頁記憶');
    const top=el('header','folio-top'),brand=el('div');brand.append(el('h2','folio-title','書頁記憶'),el('p','folio-subtitle','查目錄，取正文。故事照常聊，記憶在背後整理。'));
    const toggleLabel=el('label','folio-toggle'),toggle=el('input');toggle.type='checkbox';toggle.setAttribute('aria-label','自動記憶');
    toggle.addEventListener('change',()=>engine.toggle(toggle.checked));toggleLabel.append(toggle,document.createTextNode('自動記憶'));
    top.append(brand,toggleLabel,button('關閉',()=>dialog.close(),'folio-close'));
    const status=el('p','folio-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const warning=el('p','folio-warning'),error=el('p','folio-warning');error.hidden=true;
    const tabs=el('nav','folio-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','記憶功能');
    const labels={run:'運行',pages:'書頁目錄',selection:'本次取用',helper:'記憶助手'},panels={},tabButtons={};
    for(const [key,label]of Object.entries(labels)){
        const b=button(label,()=>setTab(key));b.id='folio-tab-'+key;b.setAttribute('role','tab');b.setAttribute('aria-controls','folio-view-'+key);
        b.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const keys=Object.keys(labels),i=keys.indexOf(key);const next=e.key==='Home'?0:e.key==='End'?keys.length-1:(i+(e.key==='ArrowRight'?1:keys.length-1))%keys.length;setTab(keys[next]);tabButtons[keys[next]].focus();});
        tabs.append(b);tabButtons[key]=b;const panel=el('section','folio-view');panel.id='folio-view-'+key;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',b.id);panels[key]=panel;
    }
    const content=el('main','folio-content');content.append(...Object.values(panels));
    dialog.append(top,status,warning,error,tabs,content);document.body.append(dialog);
    const perform=task=>async event=>{
        const b=event?.currentTarget;if(b)b.disabled=true;error.hidden=true;
        try{await task();}catch(e){error.textContent=e.message||'操作未完成，請稍後重試';error.hidden=false;}
        finally{if(b)b.disabled=false;}
    };
    const runBody=el('div');panels.run.append(runBody);
    const pageTools=el('div','folio-toolbar'),search=el('input','folio-search'),filter=el('select');
    search.type='search';search.placeholder='找標題、人物、摘要或正文';search.setAttribute('aria-label','搜尋書頁');
    filter.setAttribute('aria-label','篩選書頁');for(const [value,label]of [['all','全部書頁'],['pending','尚待整理'],['pinned','已釘選']]){const o=el('option','',label);o.value=value;filter.append(o);}
    search.addEventListener('input',()=>{shown=60;renderPages();});filter.addEventListener('change',()=>{shown=60;renderPages();});pageTools.append(search,filter);
    const pageCount=el('p','folio-muted'),book=el('div','folio-book'),pageList=el('div','folio-page-list'),reader=el('article','folio-reader');
    pageList.setAttribute('aria-label','書頁清單');book.append(pageList,reader);panels.pages.append(pageTools,pageCount,book);
    const query=el('textarea','folio-query');query.rows=2;query.placeholder='例如：我還欠船長甚麼約定？留空則使用最後一次玩家輸入。';query.setAttribute('aria-label','試跑查頁內容');
    const previewButton=button('試跑選頁（不生成正文）',perform(async()=>{await engine.preview(query.value);renderSelection();}),'folio-primary');
    const previewBar=el('div','folio-toolbar');previewBar.append(previewButton,info('用這段文字做一次真實查頁，會使用記憶助手並產生短請求費用。不生成角色回覆、不保存為聊天。候選只來自完成的小摘要；所選頁取回的是完整正文。'));
    const selectionBody=el('div');panels.selection.append(heading('這次查了哪些頁？'),query,previewBar,selectionBody);
    panels.helper.append(heading('兩個模型，分開設定','選酒館已保存的連線，再填寫模型名稱。兩個用途可以用相同模型，也可以用不同供應商。不改主聊天模型；設定失敗時不會偷偷換成其他模型。'),el('p','folio-prose','總結模型負責寫小摘要；提取模型負責看小摘要，選出這次需要的正文。兩欄各自保存、各自測試。舊助手設定已帶入兩欄，可直接修改。'));
    const helperFields={},helperGrid=el('div','folio-helper-grid');panels.helper.append(helperGrid);
    for(const [role,label,description]of [['summary','總結模型','輸入：清理後正文與玩家背景。輸出：標題、小摘要。'],['selection','提取模型','輸入：本次問題與候選小摘要。輸出：需要取回的正文頁及原因。']]){
        const section=el('section','folio-helper-section'),connection=el('select'),model=el('input'),list=el('datalist');
        connection.id=`folio-${role}-connection`;model.id=`folio-${role}-model`;list.id=`folio-${role}-models`;model.setAttribute('list',list.id);model.required=true;model.autocomplete='off';model.placeholder=`填寫${label} ID`;
        const connectionLabel=el('label','folio-field',`${label}連線`);connectionLabel.htmlFor=connection.id;connectionLabel.append(connection);
        const modelLabel=el('label','folio-field',`${label}名稱`);modelLabel.htmlFor=model.id;modelLabel.append(model,list);
        const configured=el('p','folio-muted'),result=el('div','folio-connection-result');
        const field={connection,model,list,configured,result,dirty:false,optionsKey:'',version:0};helperFields[role]=field;
        const loadChoices=async()=>{const version=++field.version;try{const ids=await engine.host.modelChoices?.(role,connection.value)??[];if(version===field.version)list.replaceChildren(...ids.map(id=>{const o=el('option');o.value=id;return o;}));}catch{}};
        const save=()=>{engine.host.configureHelper(role,connection.value,model.value);engine.cancel();engine.connectionTests[role]=null;field.dirty=false;engine.retry();};
        connection.addEventListener('change',()=>{field.dirty=true;model.value=state.profiles.find(p=>p.id===connection.value)?.model??'';configured.textContent='尚未保存；填好模型後按保存。';loadChoices();});
        model.addEventListener('input',()=>{field.dirty=true;configured.textContent='尚未保存；不影響目前正在使用的設定。';});
        const actions=el('div','folio-toolbar');field.test=button(`測試${label}`,perform(async()=>{if(field.dirty)save();await engine.testHelper(role);}));
        actions.append(button(`保存${label}`,perform(save),'folio-primary'),field.test);section.append(heading(label),el('p','folio-muted',description),connectionLabel,modelLabel,configured,actions,result);helperGrid.append(section);field.loadChoices=loadChoices;
    }
    panels.helper.append(heading('向量已內建'),el('p','folio-prose','BGE-small-zh-v1.5 在本機瀏覽器運行。這不是第三個需要填寫的模型，不用向量 API、Ollama 或額外程式。'));
    function open(){state=engine.snapshot();update(state);if(!dialog.open)dialog.showModal();setTab(tab);tabButtons[tab].focus();}
    function setTab(key){tab=key;for(const k of Object.keys(labels)){panels[k].hidden=k!==key;tabButtons[k].setAttribute('aria-selected',String(k===key));tabButtons[k].tabIndex=k===key?0:-1;}render();}
    function renderRun(){
        const intro=el('div','folio-run-intro');intro.append(heading(state.enabled?'你繼續故事，這裡自動接著整理':'記憶已暫停','一頁是一則角色正文，不是固定字數，也不是玩家與角色各算一樓。长正文會拆段寫摘要，再合成一頁。修改、換回覆或刪除後，只重做內容真正改變的頁。'),el('p','folio-prose',`這段聊天有 ${state.total} 頁正文，${state.ready} 頁已有摘要，${state.indexed} 頁已載入本機索引。`));
        const progress=el('progress');progress.max=Math.max(1,state.total);progress.value=state.ready;progress.setAttribute('aria-label','摘要整理進度');intro.append(progress);
        const flow=el('ol','folio-flow');
        const steps=[['清理正文','去掉已知思考、狀態欄等內容；原聊天保留。',`${state.total} 頁`],['寫小摘要','每頁整理人物、事件、約定和伏筆。',`${state.ready}/${state.total}`],['建立本機向量','讓同義情節也能找到；不呼叫向量 API。',`${state.indexed}/${state.total}`],['讀目錄選頁','回覆前以向量與文字找候選，再讓助手看小摘要。',state.last?'已有取用紀錄':'下次回覆時執行'],['放回歷史','選中的完整正文與玩家背景，按時間放回預設歷史。',state.last?.final?'已觀測最終請求':'等待查頁']];
        for(const [title,text,value]of steps){const li=el('li');li.append(el('strong','',title),el('span','folio-flow-value',value),el('p','',text));flow.append(li);}
        const actions=el('div','folio-toolbar');actions.append(button('繼續整理',()=>engine.retry()),button('查看書頁',()=>setTab('pages')),button('查看取用',()=>setTab('selection')));
        if(state.conflict)actions.append(button('改用書頁（停用 Anima 並刷新）',perform(()=>engine.host.useFolioInstead(state.conflict))));
        const activity=el('ul','folio-activity');for(const item of state.activity.slice(0,12)){const li=el('li');li.append(el('time','',stamp(item.time)),el('span','',item.message));activity.append(li);}
        runBody.replaceChildren(intro,flow,actions,heading('最近動作'),state.activity.length?activity:el('p','folio-muted','開啟聊天後，新的整理與查頁動作會自動出現在這裡。'));
    }
    function renderPages(){
        const q=search.value.trim().toLocaleLowerCase();const entries=state.entries.filter(e=>(filter.value!=='pending'||!e.ready)&&(filter.value!=='pinned'||e.pinned)&&[e.title,e.name,e.summary,e.body,e.playerInput].some(s=>String(s??'').toLocaleLowerCase().includes(q)));
        pageCount.textContent=`${entries.length} 頁符合條件。頁碼只計角色正文；「聊天第 N 則」包含玩家輸入。`;
        if(!entries.some(e=>e.ref.handle===selected?.handle&&e.ref.hash===selected?.hash&&e.ref.chat===selected?.chat)){selected=entries[0]?.ref??null;editing=false;}
        const scroll=pageList.scrollTop,fragment=document.createDocumentFragment();
        for(const e of entries.slice(0,shown)){
            const b=button('',()=>{selected=e.ref;editing=false;renderPages();if(matchMedia('(max-width: 640px)').matches)reader.scrollIntoView({block:'start',behavior:'instant'});},'folio-page-link');
            b.setAttribute('aria-current',String(e.ref.handle===selected?.handle));b.dataset.index=String(e.index);
            b.append(el('span','folio-page-meta',`第 ${e.number} 頁 · 聊天第 ${e.index+1} 則${e.pinned?' · 已釘選':''}`),el('strong','',e.title),el('span','folio-page-excerpt',e.summary||'等候整理；正文已保留'),el('span','folio-page-state',e.ready?e.indexed?'摘要與向量已就緒':'摘要完成，索引待載入':`摘要 ${e.parts}/${e.totalParts} 段`));fragment.append(b);
        }
        if(entries.length>shown)fragment.append(button('載入更多書頁',()=>{shown+=60;renderPages();}));
        if(!entries.length)fragment.append(el('p','folio-empty','沒有符合的書頁。開啟一段聊天，或換個詞搜尋。'));
        pageList.replaceChildren(fragment);pageList.scrollTop=scroll;
        if(editing)return;
        const e=entries.find(x=>x.ref.handle===selected?.handle);if(!e){reader.replaceChildren(el('p','folio-empty','選一頁，在這裡對照小摘要和正文。'));return;}
        const openDetails=new Set([...reader.querySelectorAll('details[open]')].map(n=>n.firstElementChild?.textContent));
        const nodes=[el('p','folio-page-meta',`第 ${e.number} 頁 · ${e.name} · 聊天第 ${e.index+1} 則`),el('h3','folio-reader-title',e.title)];
        if(e.playerInput)nodes.push(disclosure('當時的玩家輸入',e.playerInput));
        nodes.push(heading('小摘要','助手與向量檢索讀的是這段目錄。它用來選頁，不會取代選中的正文。'),el('p','folio-summary-text',e.summary||'尚未完成，整理好會自動更新。'),heading('清理後正文','選中這一頁時，送入歷史的是這段完整正文，加上當時的玩家輸入。原聊天訊息不會被修改。'),el('div','folio-prose',e.body),disclosure('對照原始訊息',e.raw));
        const actions=el('div','folio-toolbar');
        actions.append(button(e.pinned?'取消釘選':'釘選這頁',perform(()=>engine.pin(e.ref))),button('重新整理此頁',perform(()=>engine.refresh(e.ref))),button('修改小摘要',()=>{
            editing=true;const input=el('textarea','folio-summary-edit');input.rows=6;input.value=e.summary;input.setAttribute('aria-label','修改小摘要');const bar=el('div','folio-toolbar');
            bar.append(button('保存摘要',perform(async()=>{await engine.editSummary(e.ref,input.value);editing=false;renderPages();}),'folio-primary'),button('取消',()=>{editing=false;renderPages();}));reader.append(input,bar);input.focus();
        }),button('回到聊天',perform(()=>{const p=engine.resolvePage(e.ref),m=document.querySelector(`#chat .mes[mesid="${p.index}"]`);if(m){dialog.close();m.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}else throw new Error('這則訊息尚未載入聊天畫面，請先載入更早的訊息。');})));
        nodes.push(actions);reader.replaceChildren(...nodes);for(const d of reader.querySelectorAll('details'))d.open=openDetails.has(d.firstElementChild?.textContent);
    }
    function renderSelection(){
        const last=state.last;previewButton.disabled=state.busy||!state.enabled;const nodes=[];
        if(!last){selectionBody.replaceChildren(el('p','folio-empty',state.notice||'還沒有查頁紀錄。下一次正常回覆時會自動查頁，也可以先在上方試跑。'));return;}
        nodes.push(el('p','folio-muted',`${stamp(last.createdAt)} ${last.preview?'試跑結果，沒有發送主回覆':'正常回覆查頁'} · ${last.model||'尚未呼叫助手'}`),disclosure('本次查頁內容',last.query),el('p','folio-prose',`歷史約 ${last.beforeTokens.toLocaleString()} → ${last.tokens.toLocaleString()} tokens；書頁目標 ${last.budget.toLocaleString()}。必須保留的最近完整回合可能超過目標，酒館仍按預設可用空間裁剪。`));
        nodes.push(heading('候選目錄與助手決定','語意分數是向量相似度，不是可信度；文字分數幫助匹配姓名與專有詞。助手只讀這些小摘要，不會提前讀完整舊正文。'));
        if(!last.candidates.length)nodes.push(el('p','folio-muted',last.mode==='building'?'舊頁摘要尚未齊全，這次保留原歷史。':'近期正文已足夠，或沒有匹配的舊目錄。'));
        for(const c of last.candidates){
            const skipped=last.skipped.some(s=>s.index===c.index),d=disclosure(`第 ${c.number} 頁 · ${c.title} · ${skipped?'選中但放不下':c.selected?'選中':'未選中'}`,c.summary,'folio-candidate');
            d.append(el('p','folio-muted',`語意 ${c.semantic.toFixed(3)} / 文字 ${c.lexical.toFixed(2)}　${skipped?'完整正文超出剩餘容量':c.reason}`));nodes.push(d);
        }
        nodes.push(heading('實際帶入的歷史','此清單按時間排列。確認標記是在酒館組裝好請求、交给後端前比對全文，不表示服務商已收到或模型已讀懂。若其他插件改寫、角色轉換或預設裁剪，可能找不到相同全文。'));
        nodes.push(el('p',last.final?'folio-observed':'folio-muted',last.final?`已觀測酒館最終請求：${last.final.kept} 則找到完整內容，${last.final.dropped} 則未找到完整內容（可能裁剪或改寫）。`:last.preview?'試跑沒有主模型請求；以下是預計交給酒館的歷史。':'已交給酒館；尚未觀測最終請求。'));
        for(const item of last.items){
            const badge=item.final===true?'已核對':item.final===false?'未找到全文':'待核對';
            nodes.push(disclosure(`${item.role==='user'?'玩家背景':`第 ${item.number??'?'} 頁正文`} · ${item.reason} · ${badge}`,item.body,'folio-history-item'));
        }
        const expanded=new Set([...selectionBody.querySelectorAll('details[open]')].map(d=>d.firstElementChild.textContent));selectionBody.replaceChildren(...nodes);for(const d of selectionBody.querySelectorAll('details'))d.open=expanded.has(d.firstElementChild.textContent);
    }
    function renderHelper(){
        for(const [role,field]of Object.entries(helperFields)){
            const config=state.helpers[role],{connection,model,configured,result}=field;
            const options=[{id:'current',name:'目前聊天的連線（模型分開指定）'},...state.profiles];
            for(const id of [config.connection,field.dirty?connection.value:null].filter(Boolean))if(!options.some(p=>p.id===id))options.push({id,name:'原連線已不存在，請重新選擇'});
            const key=JSON.stringify(options);if(connection.dataset.options!==key){const draft=connection.value;connection.replaceChildren(...options.map(p=>{const o=el('option','',p.name);o.value=p.id;return o;}));connection.dataset.options=key;connection.value=field.dirty?draft:config.connection;}
            if(!field.dirty){connection.value=config.connection;model.value=config.model;configured.textContent=`已保存：${config.label||'目前聊天連線'} / ${config.model||'尚未填寫模型'}${config.lastModel?`；最近呼叫：${config.lastModel}`:''}`;}
            const optionsKey=connection.value+JSON.stringify(state.profiles);if(field.optionsKey!==optionsKey){field.optionsKey=optionsKey;field.loadChoices();}
            field.test.disabled=state.busy;const outcome=state.connectionTests[role];result.replaceChildren();
            if(outcome)result.append(el('p',outcome.ok?'folio-observed':'folio-muted',outcome.pending?'正在測試這個用途…':outcome.ok?`${outcome.model} 測試通過，用時 ${(outcome.ms/1000).toFixed(1)} 秒。`:`測試未通過：${outcome.error}`));
            if(outcome?.ok)result.append(el('p','folio-summary-text',outcome.summary));
        }
    }
    function render(){if(tab==='run')renderRun();else if(tab==='pages')renderPages();else if(tab==='selection')renderSelection();else renderHelper();}
    function update(next){
        state=next;toggle.checked=next.enabled;status.textContent=next.status;warning.textContent=next.warning;warning.hidden=!next.warning;
        badge.textContent=next.conflict?'衝突暫停':!next.enabled?'暫停':`${next.ready}/${next.total}`;
        entry.title=next.status;if(dialog.open)render();
    }
    setTab('run');update(state);
    return {update,open,dispose(){entry.remove();dialog.remove();}};
}
