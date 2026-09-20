import { mountApiForms } from './api-ui.js';
import { USAGE_LIMIT, usageOverview, playerOwner } from './usage.js';
import { fold, mountMemoryOptions } from './settings-ui.js';
import { summarySections } from './core.js';
let nextId=0;
function el(tag,cls='',text=''){const n=document.createElement(tag);n.className=cls;if(text)n.textContent=text;return n;}
function button(text,action,cls=''){const n=el('button',cls,text);n.type='button';n.addEventListener('click',action);return n;}
function info(text){
    const wrap=el('span','folio-help'),tip=el('span','folio-tip',text);tip.id=`folio-help-${++nextId}`;tip.hidden=true;
    const b=button('ⓘ',()=>{tip.hidden=!tip.hidden;b.setAttribute('aria-expanded',String(!tip.hidden));},'folio-info');
    b.setAttribute('aria-label','說明');b.setAttribute('aria-expanded','false');b.setAttribute('aria-controls',tip.id);wrap.append(b,tip);return wrap;
}
function heading(text,help){const n=el('h3','',text);if(help)n.append(info(help));return n;}
function disclosure(label,content,cls=''){const n=el('details',cls);n.append(el('summary','',label),typeof content==='string'?el('div','folio-prose',content):content);return n;}
function summaryView(text,empty){
    const value=text||empty,sections=summarySections(value);
    if(!sections.length)return el('p','folio-summary-text',value);
    const sheet=el('dl','folio-summary-text folio-summary-sheet');
    for(const section of sections){const row=el('div','folio-summary-row');row.append(el('dt','',section.label),el('dd','',section.text));sheet.append(row);}
    return sheet;
}
const stamp=t=>new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const dateStamp=t=>new Date(t).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
function ring(label,value,total,help,cls=''){
    const percent=total?Math.min(100,Math.round(value/total*100)):0,wrap=el('div','folio-meter '+cls),dial=el('div','folio-dial');
    dial.setAttribute('role','progressbar');dial.setAttribute('aria-label',label);dial.setAttribute('aria-valuemin','0');dial.setAttribute('aria-valuemax',String(total||1));dial.setAttribute('aria-valuenow',String(value));dial.setAttribute('aria-valuetext',total?`${value} / ${total} 頁，${percent}%`:'尚無正文');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 120 120');svg.setAttribute('aria-hidden','true');
    for(const name of ['folio-ring-track','folio-ring-value']){
        const c=document.createElementNS(svg.namespaceURI,'circle');for(const [k,v]of Object.entries({cx:60,cy:60,r:51,pathLength:100,class:name}))c.setAttribute(k,String(v));
        if(name==='folio-ring-value')c.style.strokeDashoffset=String(100-percent);svg.append(c);
    }
    const number=el('div','folio-dial-number');number.setAttribute('aria-hidden','true');number.append(el('strong','',total?String(value):'—'),el('span','',total?`/ ${total} 頁`:'尚無正文'));dial.append(svg,number);
    wrap.append(dial,heading(label,help),el('p','folio-meter-caption',total?`${percent}% 已就緒`:'目前沒有角色正文'));return wrap;
}

export function mountUI(engine){
    const menu=document.querySelector('#extensionsMenu');if(!menu)throw new Error('找不到輸入欄魔法棒選單');
    let state=engine.snapshot(),tab='run',selected=null,editing=false,shown=60,usageChoice='',usageChat='',autoWasActive=false,manualWasActive=false,manualJobId=null,autoCompletion=false,autoTimer=null;
    const entry=button('',()=>open(),'list-group-item flex-container flexGap5 interactable');entry.id='folio-wand';
    const icon=el('i','fa-fw fa-solid fa-book-open extensionsMenuExtensionButton');icon.setAttribute('aria-hidden','true');
    const badge=el('span','folio-menu-status');entry.append(icon,el('span','','書頁記憶'),badge);menu.append(entry);
    const dialog=el('dialog','folio-dialog');dialog.setAttribute('aria-label','書頁記憶');
    const top=el('header','folio-top'),brand=el('div');brand.append(el('h2','folio-title','書頁記憶'),el('p','folio-subtitle','查目錄，取正文。故事照常聊，記憶在背後整理。'));
    const toggleLabel=el('label','folio-toggle'),toggle=el('input'),toggleTrack=el('span','folio-switch-track'),toggleCopy=el('span','folio-toggle-copy'),toggleState=el('strong','folio-toggle-state');
    toggle.type='checkbox';toggle.setAttribute('role','switch');toggle.setAttribute('aria-label','新回覆自動記憶');toggleTrack.setAttribute('aria-hidden','true');toggleTrack.append(el('span','folio-switch-knob'));
    toggleCopy.append(el('span','','新回覆自動記憶'),toggleState);toggle.addEventListener('change',()=>engine.toggle(toggle.checked));toggleLabel.append(toggle,toggleTrack,toggleCopy);
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
    dialog.append(top,status,warning,error,tabs,content);
    const autoPopup=el('aside','folio-auto-popup'),autoPopupHead=el('div','folio-auto-popup-head'),autoPopupTitle=el('strong','folio-auto-popup-title'),autoPopupDetail=el('p','folio-auto-popup-detail'),autoPopupProgress=el('progress'),autoPopupActions=el('div','folio-auto-popup-actions');
    autoPopup.hidden=true;autoPopup.setAttribute('role','region');autoPopup.setAttribute('aria-label','記憶整理狀態');autoPopupDetail.setAttribute('aria-live','polite');autoPopupProgress.setAttribute('aria-label','記憶整理進度');
    const autoView=button('查看進度',()=>{open();setTab('run');}),autoRetry=button('立即重試',()=>engine.retry()),autoStop=button('停止本次重整',event=>perform(()=>engine.stopRebuild())(event));autoStop.hidden=true;
    const autoMark=el('span','folio-auto-mark','書');autoMark.setAttribute('aria-hidden','true');autoPopupHead.append(autoMark,autoPopupTitle);autoPopupActions.append(autoView,autoRetry,autoStop);autoPopup.append(autoPopupHead,autoPopupDetail,autoPopupProgress,autoPopupActions);
    document.body.append(dialog,autoPopup);
    const perform=task=>async event=>{
        const b=event?.currentTarget;if(b)b.disabled=true;error.hidden=true;
        try{await task();}catch(e){error.textContent=e.message||'操作未完成，請稍後重試';error.hidden=false;}
        finally{if(b)b.disabled=false;update(engine.snapshot());}
    };
    const rebuildPanels=[];
    for(const target of [panels.run,panels.pages]){
        const section=el('div','folio-rebuild'),bar=el('div','folio-toolbar'),detail=el('p','folio-muted'),progress=el('progress'),outcome=el('p','folio-rebuild-status');
        outcome.setAttribute('role','status');progress.setAttribute('aria-label','本次重整進度');
        const all=button('一鍵重新整理全部',perform(()=>engine.refreshAll(state.chatIdentity)),'folio-primary');
        const missing=button('一鍵整理未整理的',perform(()=>engine.refreshMissing(state.chatIdentity)));
        const vectors=button('補齊本機向量',perform(()=>engine.repairVectors(state.chatIdentity)),'folio-vector-repair');
        const scope=el('p','folio-rebuild-scope');
        all.title='重做全部正文的摘要與索引，包含已完成及人工修改的摘要';
        missing.title='缺摘要就補摘要，已有摘要只補向量；保留已有有效摘要';
        vectors.title='只為已有有效摘要補齊本機向量，不呼叫總結／提取 API';
        const stop=button('停止本次重整',perform(()=>engine.stopRebuild())),retry=button('立即重試',()=>engine.retry());
        bar.append(all,missing,vectors,info('全部：重做所有劇情頁，包含人工修改的摘要。未整理：缺摘要就接續整理，摘要完成但缺向量也算未完成，只補向量。「補齊本機向量」完全不重做摘要、不呼叫模型 API，沒有摘要的頁不會處理。包含隱藏正文，不含系統通知，不受搜尋／篩選限制。關閉自動記憶時也能手動執行。'),stop,retry);section.append(bar,scope,detail,progress,outcome);target.append(section);rebuildPanels.push({all,missing,vectors,scope,stop,retry,detail,progress,outcome});
    }
    const runBody=el('div'),runActivity=fold(el,'最近動作'),activityBody=el('div');runActivity.append(activityBody);panels.run.prepend(runBody);panels.run.append(runActivity);
    const memoryOptions=mountMemoryOptions(engine,panels.pages,{el,button,info});
    const pageTools=el('div','folio-toolbar'),search=el('input','folio-search'),filter=el('select');
    search.type='search';search.placeholder='找標題、人物、摘要或正文';search.setAttribute('aria-label','搜尋書頁');
    filter.setAttribute('aria-label','篩選書頁');for(const [value,label]of [['all','全部書頁'],['pending','尚待整理'],['pinned','已釘選']]){const o=el('option','',label);o.value=value;filter.append(o);}
    search.addEventListener('input',()=>{shown=60;renderPages();});filter.addEventListener('change',()=>{shown=60;renderPages();});pageTools.append(search,filter);
    const pageCount=el('p','folio-muted'),book=el('div','folio-book'),pageList=el('div','folio-page-list'),reader=el('article','folio-reader');
    pageList.setAttribute('aria-label','書頁清單');book.append(pageList,reader);panels.pages.append(pageTools,pageCount,book);
    const usagePicker=el('select');usagePicker.setAttribute('aria-label','發送紀錄');usagePicker.addEventListener('change',()=>{usageChoice=usagePicker.value;renderSelection();});
    const usageBar=el('div','folio-toolbar folio-usage-bar');usageBar.append(usagePicker,info(`每段聊天保留最近 ${USAGE_LIMIT} 次有角色回覆的取用快照，跟隨酒館聊天保存，並保留本機副本。刪除最新回覆會回退到上一筆現存回覆；編輯、隱藏或續寫不等於刪除，切換候選回覆顯示對應版本。僅供查看，已刪除正文不會因此進入之後的請求。舊版只有本機的紀錄會在能安全確認回覆時遷移；已清除的舊快取無法憑空恢復。`));
    const selectionBody=el('div'),usageHistory=fold(el,'較早的取用紀錄');usageHistory.append(usageBar);panels.selection.append(heading('發送取用紀錄','在酒館組裝好請求、交給後端前核對全文；不是服務商接收或生成成功的回執。未發送的選頁不會取代最近紀錄。'),usageHistory,selectionBody);
    const apiForms=mountApiForms(engine,panels.helper,{el,button,info,heading});
    dialog.addEventListener('close',()=>{apiForms.conceal();for(const d of dialog.querySelectorAll('.folio-settings-fold'))d.open=false;document.body.append(autoPopup);renderAutoPopup();});
    function open(){state=engine.snapshot();update(state);if(!dialog.open)dialog.showModal();dialog.append(autoPopup);setTab(tab);tabButtons[tab].focus();}
    function setTab(key){tab=key;for(const k of Object.keys(labels)){panels[k].hidden=k!==key;tabButtons[k].setAttribute('aria-selected',String(k===key));tabButtons[k].tabIndex=k===key?0:-1;}render();}
    function autoText(a=state.auto){
        if(state.rebuild?.pending)return `玩家已啟動一鍵重新整理；正在處理目前聊天。`;
        if(a?.total){
            const counts=`摘要 ${a.ready}/${a.total} 頁 · 向量 ${a.indexed}/${a.total} 頁`;
            if(!state.enabled)return `新回覆自動整理已暫停 · ${counts}`;
            if(a.waitingForGeneration)return `等待這次角色回覆完成 · ${counts}`;
            if(state.warning&&a.active)return `等待重試：${state.warning} · ${counts}`;
            if(a.current?.stage==='summary')return `第 ${a.current.page} 頁 · 第 ${a.current.part}/${a.current.total} 段 · ${counts}`;
            if(a.current?.stage==='vector')return `正在建立第 ${a.current.page} 頁向量 · ${counts}`;
            if(a.pendingSummaries)return `${a.pendingSummaries} 頁新回覆等待寫入小摘要 · ${counts}`;
            if(a.pendingVectors)return `${a.pendingVectors} 頁新回覆等待建立本機向量 · ${counts}`;
            return `這批新回覆已完成 · ${counts}${a.manualPending?` · 舊聊天另有 ${a.manualPending} 頁只會在手動重整時處理`:''}`;
        }
        if(!state.enabled)return '新回覆自動記憶已暫停；手動一鍵重整仍可使用。';
        if(a?.manualPending)return `舊聊天有 ${a.manualPending} 頁尚未整理；不會自動處理。需要時請按下方「一鍵整理未整理的」。`;
        if(!a?.catalogueTotal)return '目前沒有角色正文；新回覆出現後才會自動整理。';
        return '舊聊天保持原狀；只會自動整理接下來新生成的角色回覆。';
    }
    function setAutoProgress(progress,a=state.auto,complete=false){
        const pages=a?.total??0,total=Math.max(1,pages*2),value=complete?total:Math.min(total,(a?.ready??0)+(a?.indexed??0));progress.max=total;progress.value=value;
        progress.setAttribute('aria-valuetext',complete?'新回覆整理完成':autoText(a));
    }
    function rebuildText(job=state.rebuild){
        if(state.stopping)return '正在中止本次助手工作；保留完成頁，未完成頁恢復原摘要。';
        if(state.stopFailed)return '停止狀態未能保存；本視窗不再發出重整請求。請按「重試停止」，保存成功前刷新可能恢復未完成任務。';
        if(state.rebuildQueued)return `已接受操作；本次角色回覆完成後，會${state.rebuildMode==='vectors'?'只補齊本機向量，不呼叫 API':state.rebuildMode==='missing'?'只整理未整理的摘要／向量，保留已有有效摘要':'重新整理全部正文'}。`;
        if(state.resetting&&!job)return '正在保存重新整理任務；正文不會被刪除。';
        if(!job)return '準備重新整理目前聊天。';
        const counts=job.mode==='vectors'?`向量 ${job.vectors}/${job.total} 頁 · 不呼叫 API`:`摘要 ${job.done}/${job.total} 頁 · 向量 ${job.vectors}/${job.total} 頁`;
        if(state.warning&&job.pending)return `等待重試：${state.warning} · ${counts}`;
        if(job.pending)return `${state.work?.page?`正在處理第 ${state.work.page} 頁 · `:''}${counts}`;
        return `${job.cancelled?'本次重新整理已停止':job.vectorFallback?'摘要已保留，向量尚待補齊':job.mode==='vectors'?'本機向量已補齊':'舊聊天重新整理完成'} · ${counts}`;
    }
    function setRebuildProgress(progress,job=state.rebuild,complete=false){
        if(state.rebuildQueued||(state.resetting&&!job?.pending)){job=null;complete=false;}
        const steps=job?.mode==='vectors'?1:2,total=Math.max(1,(job?.total??0)*steps),settled=((job?.cancelled??0)+(job?.removed??0))*steps;
        progress.max=total;progress.value=complete&&!job?.vectorFallback?total:Math.min(total,(steps===2?(job?.done??0):0)+(job?.vectors??0)+settled);
        progress.setAttribute('aria-valuetext',rebuildText(job));
    }
    function autoPanel(){
        const a=state.auto,titleText=!state.enabled?'新回覆自動記憶已暫停':state.rebuild?.pending?'手動重新整理中':a?.active?'新回覆整理進度':a?.complete?'最近新回覆已整理':a?.manualPending?'舊聊天等待手動整理':'等待新回覆';
        const section=el('section','folio-auto-run'),head=el('div','folio-auto-run-head'),title=el('strong','',titleText),detail=el('p','folio-muted',autoText(a)),progress=el('progress');
        section.dataset.phase=a?.phase??'';
        progress.hidden=!a?.total;progress.setAttribute('aria-label','面板內自動整理進度');setAutoProgress(progress,a,!!a?.complete&&!a?.active);head.append(title);
        if(state.warning&&a?.active)head.append(button('立即重試',()=>engine.retry()));section.append(head,detail,progress);return section;
    }
    function renderAutoPopup(){
        const a=state.auto,job=state.rebuild,manualActive=state.stopping||state.resetting||state.rebuildQueued||!!job?.pending;
        autoPopupProgress.hidden=false;
        autoStop.hidden=!manualActive;autoStop.disabled=!!state.stopping;autoStop.textContent=state.stopping?'正在停止…':state.stopFailed?'重試停止':state.rebuildQueued?'取消排隊':'停止本次重整';
        if(manualActive){
            if(!manualWasActive||state.rebuildQueued)manualJobId=null;if(job?.pending)manualJobId=job.id;
            clearTimeout(autoTimer);autoCompletion=false;manualWasActive=true;autoPopup.hidden=false;autoPopup.classList.toggle('folio-auto-error',!!state.warning);
            autoPopup.dataset.phase=state.rebuildQueued||state.resetting?'waiting':state.work?.stage??'summary';
            autoPopupTitle.textContent=state.stopping?'正在停止本次重整':state.warning?'重新整理等待重試':state.rebuildQueued?'已排隊，等待回覆完成':state.resetting?'正在建立重新整理任務':state.rebuildMode==='vectors'?'正在補齊本機向量':'正在重新整理舊聊天';
            autoPopupDetail.textContent=rebuildText(job);autoPopupProgress.hidden=state.rebuildQueued||(state.resetting&&!job?.pending);setRebuildProgress(autoPopupProgress,job);autoRetry.hidden=state.stopFailed||state.stopping||!state.warning||state.resetting||state.rebuildQueued;return;
        }
        if(manualWasActive){
            manualWasActive=false;
            if(job?.complete&&job.id===manualJobId){
                autoCompletion=true;autoPopup.hidden=false;autoPopup.classList.toggle('folio-auto-error',job.vectorFallback);autoPopup.dataset.phase='complete';autoPopupTitle.textContent=job.cancelled?'本次重新整理已停止':job.vectorFallback?'向量尚待補齊':job.mode==='vectors'?'本機向量已補齊':'舊聊天重新整理完成';autoPopupDetail.textContent=rebuildText(job);setRebuildProgress(autoPopupProgress,job,!job.cancelled);autoRetry.hidden=true;
                clearTimeout(autoTimer);autoTimer=setTimeout(()=>{autoCompletion=false;autoPopup.hidden=true;},3200);return;
            }
        }
        if(a?.active){
            clearTimeout(autoTimer);autoCompletion=false;autoWasActive=true;autoPopup.hidden=false;autoPopup.classList.toggle('folio-auto-error',!!state.warning);
            autoPopup.dataset.phase=a.phase??'';
            autoPopupTitle.textContent=state.warning?'新回覆等待重試':a.waitingForGeneration?'等待新回覆':a.current?'正在整理新回覆':'新回覆已加入整理';
            autoPopupDetail.textContent=autoText(a);setAutoProgress(autoPopupProgress,a);autoRetry.hidden=!state.warning;return;
        }
        if(autoWasActive){
            autoWasActive=false;
            if(a?.complete&&state.enabled&&!state.rebuild?.pending){
                autoCompletion=true;autoPopup.hidden=false;autoPopup.classList.remove('folio-auto-error');autoPopupTitle.textContent='新回覆已整理';autoPopupDetail.textContent=autoText(a);setAutoProgress(autoPopupProgress,a,true);autoRetry.hidden=true;
                clearTimeout(autoTimer);autoTimer=setTimeout(()=>{autoCompletion=false;autoPopup.hidden=true;},2800);return;
            }
        }
        if(!autoCompletion)autoPopup.hidden=true;
    }
    function renderRun(){
        const intro=heading(state.rebuild?.pending?state.rebuildMode==='vectors'?'正在補齊本機向量':'正在重新整理書頁':state.enabled?'新回覆自動記，舊聊天由你決定':'新回覆自動記憶已暫停','自動開關只處理開啟後的新回覆。舊聊天摘要仍由你決定是否整理；已有摘要若缺本機向量，會用內建模型自動補齊，不重做摘要、不呼叫 API。');
        const dashboard=el('div','folio-dashboard'),meters=el('div','folio-meters');
        meters.append(ring('摘要目錄',state.ready,state.total,'完成小摘要的正文頁數。提取模型讀目錄來選頁，選中後取回完整正文。'),ring('本機向量',state.indexed,state.total,'目前可用的正文頁向量。刷新、換瀏覽器或清除網站資料後，已有摘要會用內建模型自動恢復或重建向量；不重做摘要、不呼叫 API。','folio-meter-vector'));
        meters.querySelector('.folio-meter-vector').append(el('p','folio-vector-state',state.vectorLoading?'正在恢復／建立本機向量…':state.vectorMissing?`${state.vectorMissing} 頁待補向量 · 將自動重試`:state.summaryMissing?`${state.summaryMissing} 頁需先整理摘要`:'與摘要目錄同步'));
        const latest=state.usages?.[0],receipt=el('section','folio-recent');receipt.append(heading('最近取用（現存回覆）','只看仍在目前聊天裡的角色回覆。刪除最新回覆後，這裡會自動回到上一筆仍存在的舊取用。'),el('p','folio-recent-time',latest?dateStamp(latest.final.observedAt):state.usageLoading?'正在讀回取用紀錄…':'尚無對應現存回覆的紀錄'));
        if(latest){const counts=usageOverview(latest);receipt.append(el('p','folio-recent-count',`${counts.bodies} 頁正文 · ${counts.players} 則玩家背景`),el('p','folio-recall-count',`召回舊正文 ${counts.recalled} 頁 · 保留近期正文 ${counts.recent} 頁${counts.retained?` · 原歷史 ${counts.retained} 頁`:''}`),el('p','folio-recent-query',latest.query||'這次沒有新的玩家輸入'),el('p',!counts.bodies?'folio-usage-warning':'folio-muted',!counts.bodies?'這次未核對到任何正文；玩家背景不算正文取用。':latest.sourceChanged?'聊天已有變更；仍保留當時快照。':'已在酒館送出前核對完整內容。'));}
        else receipt.append(el('p','folio-muted','正常生成並保留角色回覆後，這裡會顯示它取用了哪些正文。'));
        receipt.append(button('查看發送紀錄',()=>{usageChoice='';setTab('selection');}));dashboard.append(meters,receipt);
        const actions=el('div','folio-toolbar');if(!state.enabled)actions.append(button('繼續新回覆自動記憶',()=>{engine.toggle(true);engine.retry();}));actions.append(button('查看書頁',()=>setTab('pages')),button('記憶助手',()=>setTab('helper')));
        if(state.conflict)actions.append(button('改用書頁（停用 Anima 並刷新）',perform(()=>engine.host.useFolioInstead(state.conflict))));
        const activity=el('ul','folio-activity');for(const item of state.activity.slice(0,12)){const li=el('li');li.append(el('time','',stamp(item.time)),el('span','',item.message));activity.append(li);}
        runBody.replaceChildren(intro,autoPanel(),dashboard,actions);if(state.usageError)runBody.append(el('p','folio-usage-warning',state.usageError));activityBody.replaceChildren(state.activity.length?activity:el('p','folio-muted','新的整理與查頁動作會自動出現在這裡。'));
    }
    function renderPages(){
        const q=search.value.trim().toLocaleLowerCase();const entries=state.entries.filter(e=>(filter.value!=='pending'||!e.ready||!e.indexed)&&(filter.value!=='pinned'||e.pinned)&&[e.title,e.name,e.summary,e.body,e.playerInput].some(s=>String(s??'').toLocaleLowerCase().includes(q)));
        pageCount.textContent=`${entries.length} 頁符合條件。頁碼只計角色正文；「聊天第 N 則」包含玩家輸入。`;
        if(!entries.some(e=>e.ref.handle===selected?.handle&&e.ref.hash===selected?.hash&&e.ref.chat===selected?.chat)){selected=entries[0]?.ref??null;editing=false;}
        const scroll=pageList.scrollTop,fragment=document.createDocumentFragment();
        for(const e of entries.slice(0,shown)){
            const b=button('',()=>{selected=e.ref;editing=false;renderPages();if(matchMedia('(max-width: 640px)').matches)reader.scrollIntoView({block:'start',behavior:'instant'});},'folio-page-link');
            b.setAttribute('aria-current',String(e.ref.handle===selected?.handle));b.dataset.index=String(e.index);
            const pendingLabel=e.automatic?`新回覆整理中：摘要 ${e.parts}/${e.totalParts} 段`:'舊聊天未整理；只會在手動重整時處理';
            b.append(el('span','folio-page-meta',`第 ${e.number} 頁 · 聊天第 ${e.index+1} 則${e.hidden?' · 隱藏正文':''}${e.pinned?' · 已釘選':''}`),el('strong','',e.title),el('span','folio-page-excerpt',e.summary||'尚無小摘要；正文已保留'),el('span','folio-page-state',e.rebuilding?e.ready?'正在補齊向量，保留已有摘要':e.previousSummary?'重整中，暫顯示舊摘要':`重整中：摘要 ${e.parts}/${e.totalParts} 段`:e.ready?e.indexed?'摘要與向量已就緒':state.vectorLoading?'摘要完成，正在自動補向量':'摘要完成，向量等待重試':pendingLabel));fragment.append(b);
        }
        if(entries.length>shown)fragment.append(button('載入更多書頁',()=>{shown+=60;renderPages();}));
        if(!entries.length)fragment.append(el('p','folio-empty','沒有符合的書頁。開啟一段聊天，或換個詞搜尋。'));
        pageList.replaceChildren(fragment);pageList.scrollTop=scroll;
        if(editing)return;
        const e=entries.find(x=>x.ref.handle===selected?.handle);if(!e){reader.replaceChildren(el('p','folio-empty','選一頁，在這裡對照小摘要和正文。'));return;}
        const openDetails=new Set([...reader.querySelectorAll('details[open]')].map(n=>n.firstElementChild?.textContent));
        const nodes=[el('p','folio-page-meta',`第 ${e.number} 頁 · ${e.name} · 聊天第 ${e.index+1} 則`),el('h3','folio-reader-title',e.title)];
        if(e.playerInput)nodes.push(disclosure('當時的玩家輸入',e.playerInput));
        nodes.push(heading('小摘要','助手與向量檢索讀的是這張目錄表。每列分開人物、事件、關係與未決線索；它只用來選頁，不會取代選中的正文。'),summaryView(e.summary,e.automatic?'新回覆正在整理，完成後會自動更新。':'這是舊聊天，不會自動整理。可按「重新整理此頁」或「一鍵整理未整理的」。'),heading('清理後正文','選中這一頁時，送入歷史的是這段完整正文，加上當時的玩家輸入。原聊天訊息不會被修改。'),el('div','folio-prose',e.body));
        const actions=el('div','folio-toolbar'),manage=fold(el,'管理這一頁'),manageActions=el('div','folio-toolbar');
        const refresh=button(e.rebuilding?'正在重整此頁…':'重新整理此頁',perform(()=>engine.refresh(e.ref)),'folio-primary');refresh.disabled=!!state.resetting||!!state.rebuild?.pending||!!state.generating;
        actions.append(refresh);manageActions.append(button(e.pinned?'取消釘選':'釘選這頁',perform(()=>engine.pin(e.ref))),button('修改小摘要',()=>{
            editing=true;const input=el('textarea','folio-summary-edit');input.rows=6;input.value=e.summary;input.setAttribute('aria-label','修改小摘要');const bar=el('div','folio-toolbar');
            bar.append(button('保存摘要',perform(async()=>{await engine.editSummary(e.ref,input.value);editing=false;renderPages();}),'folio-primary'),button('取消',()=>{editing=false;renderPages();}));reader.append(input,bar);input.focus();
        }),button('回到聊天',perform(()=>{const p=engine.resolvePage(e.ref),m=document.querySelector(`#chat .mes[mesid="${p.index}"]`);if(m){dialog.close();m.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}else throw new Error('這則訊息尚未載入聊天畫面，請先載入更早的訊息。');})));
        const pageStatus=el('p','folio-page-work');pageStatus.setAttribute('role','status');
        pageStatus.textContent=state.resetting?'正在保存重新整理任務…':e.rebuilding?state.warning?`等待重試：${state.warning}`:state.work?.page===e.number?state.status:'已排入優先重整；稍後自動更新小摘要與向量。':e.rebuilt?'此頁已重新整理完成。':'';
        manage.append(manageActions,disclosure('對照原始訊息',e.raw));nodes.splice(2,0,actions,pageStatus,manage);reader.replaceChildren(...nodes);for(const d of reader.querySelectorAll('details'))d.open=openDetails.has(d.firstElementChild?.textContent);
    }
    function renderSelection(){
        const expanded=new Set([...selectionBody.querySelectorAll('details[open]')].map(d=>d.dataset.key??d.firstElementChild.textContent));
        const replace=nodes=>{selectionBody.replaceChildren(...nodes);for(const d of selectionBody.querySelectorAll('details'))d.open=expanded.has(d.dataset.key??d.firstElementChild.textContent);};
        const archived=state.usageArchive??[],archive=el('details','folio-usage-archive');archive.dataset.key='usage-archive';
        if(archived.length){archive.append(el('summary','',`未關聯目前回覆的紀錄（${archived.length}）`),el('p','folio-muted','這些快照仍然保留，但回覆已刪除、切換候選版本，或舊版缺少可靠標記。只能查看當時內容，不會當作最近取用，也不會重新送出。'));
            for(const r of archived){const d=disclosure(dateStamp(r.final.observedAt),r.items.map(x=>`${x.role==='user'?'玩家背景':'正文'} · ${x.final?'當時已核對':'當時未核對到全文'}\n${x.body}`).join('\n\n'),'folio-archived-entry');d.dataset.key='archived:'+r.id;archive.append(d);}}
        if(usageChat!==state.chatIdentity){usageChoice='';usageChat=state.chatIdentity;}
        const records=state.usages??[];if(usageChoice&&!records.some(x=>x.id===usageChoice))usageChoice='';
        usagePicker.replaceChildren(...records.map((r,i)=>{const o=el('option','',`${i===0?'最近一次':'較早紀錄'}：${dateStamp(r.final.observedAt)}`);o.value=i===0?'':r.id;return o;}));usagePicker.value=usageChoice;usageBar.hidden=!records.length;
        const last=records.find(x=>x.id===usageChoice)??records[0],nodes=[];
        if(state.usageError)nodes.push(el('p','folio-usage-warning',state.usageError));
        if(!last){nodes.push(el('p','folio-empty',state.usageLoading?'正在讀回取用紀錄…':'尚無對應現存角色回覆的取用紀錄。正常生成並保留一則回覆後會自動出現。'));
            if(archived.length)nodes.push(archive);replace(nodes);return;}
        const kept=last.items.filter(x=>x.final===true),uncertain=last.items.filter(x=>x.final!==true),counts=usageOverview(last);
        nodes.push(el('p','folio-muted',`${dateStamp(last.final.observedAt)}　現存回覆可查看 ${records.length} 次；共保留 ${state.usageStoredCount??records.length} / ${USAGE_LIMIT} 次`));
        if(last.sourceChanged)nodes.push(el('p','folio-usage-warning','聊天已有刪除或變更；以下保留當時發送快照，不代表下一次取用。'));
        nodes.push(disclosure('當時的玩家輸入',last.query||'沒有新的玩家輸入'),heading(`已核對取用：${counts.bodies} 頁正文、${counts.players} 則玩家背景`,'正文為主，玩家背景折疊附在對應正文下。這只是顯示順序；實際請求仍按聊天時間排列。'),el('p','folio-recall-count',`召回舊正文 ${counts.recalled} 頁 · 保留近期正文 ${counts.recent} 頁${counts.retained?` · 原歷史 ${counts.retained} 頁`:''}`));
        if(!counts.bodies)nodes.push(el('p','folio-usage-warning','這次未核對到任何完整正文。玩家背景不能算作正文取用；請查看下方未核對紀錄。'));
        else if(!counts.recalled&&(last.mode==='building'||last.candidates?.length))nodes.push(el('p','folio-muted',last.mode==='building'?'舊頁摘要尚未齊全，這次保留原歷史，未作目錄召回。':!counts.selected?'提取助手這次沒有選中舊正文。':'已選舊正文，但未確認完整送出；下方列出容量或最終核對結果。'));
        if(counts.skipped)nodes.push(el('p','folio-usage-warning',`${counts.skipped} 頁已選正文超出歷史容量，未放入請求。`));
        if(counts.unverified)nodes.push(el('p','folio-usage-warning',`${counts.unverified} 頁正文已交給酒館，但最終請求未核對到全文（可能裁剪、改寫或角色變更）。`));
        function itemView(item){
            const section=el('article',item.role==='user'?'folio-usage-item folio-player-item':'folio-usage-item folio-body-item'),label=item.role==='user'?'玩家背景':`當時第 ${item.number??'?'} 頁正文`;
            if(item.role!=='user')section.append(el('span','folio-usage-kind',item.final!==true?'未核對到正文':item.recent?'近期正文':last.candidates?.some(c=>c.index===item.index&&c.selected)?'召回的舊正文':'原歷史正文'));
            section.append(el('p','folio-page-meta',`${label} · ${item.reason}`));
            if(item.role!=='user'&&item.title)section.append(el('h4','',item.title));
            const source=item.sourceState==='missing'?'來源已刪除或變更':item.sourceState==='ambiguous'?'來源有相同內容，無法唯一定位':item.sourceState==='unknown'?'舊紀錄未保存來源識別':item.currentIndex!==item.index?`來源現為聊天第 ${item.currentIndex+1} 則`:`來源：聊天第 ${item.index+1} 則`;
            section.append(el('p',item.sourceState==='present'?'folio-muted':'folio-source-missing',source),el('p','folio-usage-excerpt',item.body),disclosure('查看當時全文',item.body,'folio-usage-full'));
            section.querySelector('details').dataset.key=`${last.id}:${item.index}`;return section;
        }
        const attached=new Set();
        for(const item of kept.filter(x=>x.role!=='user')){
            const section=itemView(item),players=kept.filter(x=>x.role==='user'&&playerOwner(last,x)===item.index);
            if(players.length){const d=el('details','folio-player-context');d.dataset.key=`${last.id}:${item.index}:players`;d.append(el('summary','',`當時玩家背景（${players.length} 則，點開查看）`),...players.map(itemView));section.append(d);for(const p of players)attached.add(p);}
            nodes.push(section);
        }
        const otherPlayers=kept.filter(x=>x.role==='user'&&!attached.has(x));
        if(otherPlayers.length){const d=el('details','folio-other-players');d.dataset.key=last.id+':players';d.append(el('summary','',`其他已發送玩家輸入（${otherPlayers.length} 則）`),el('p','folio-muted','含本次提問或對應正文未核對到的輸入；不計作正文取用。'),...otherPlayers.map(itemView));nodes.push(d);}
        if(uncertain.length){const d=el('details','folio-uncertain');d.dataset.key=last.id+':uncertain';d.append(el('summary','',`${uncertain.length} 則未核對到全文（可能裁剪或改寫）`),el('p','folio-muted','這些是曾交給酒館的內容；最終請求未找到相同全文，不能確認已完整取用。'),...uncertain.map(itemView));nodes.push(d);}
        const audit=el('details','folio-catalogue-audit');audit.dataset.key=last.id+':audit';audit.append(el('summary','',`選頁依據與容量 · ${last.candidates.length} 頁候選`),el('p','folio-muted',`歷史估算 ${last.beforeTokens.toLocaleString()} → ${last.tokens.toLocaleString()} tokens；書頁目標 ${last.budget.toLocaleString()}。不是最終請求的總 token 數。`));
        for(const c of last.candidates){const skipped=last.skipped.some(s=>s.index===c.index),content=el('div','folio-candidate-content');content.append(summaryView(c.summary,'這頁沒有摘要'),el('p','folio-candidate-reason',`選頁判斷：${c.reason}`));audit.append(disclosure(`當時第 ${c.number} 頁 · ${c.title} · ${skipped?'選中但放不下':c.selected?'選中':'未選中'}`,content,'folio-candidate'));}
        if(!last.candidates.length)audit.append(el('p','folio-muted',last.mode==='building'?'舊頁目錄尚未齊全，當時保留原歷史。':'當時沒有需要額外查找的舊頁。'));nodes.push(audit);
        if(archived.length)nodes.push(archive);replace(nodes);
    }
    function renderHelper(){
        apiForms.render(state);
    }
    function renderRebuild(){
        const job=state.rebuild;
        for(const f of rebuildPanels){
            const locked=state.stopping||state.resetting||!!job?.pending||state.rebuildQueued;
            const working=state.stopping?'正在停止…':state.resetting?'正在保存重整任務…':job?.pending?'重新整理進行中':state.rebuildQueued?'已排隊，等待回覆完成':'';
            f.all.disabled=locked||!state.total;f.missing.disabled=locked||state.vectorLoading||!state.missing;f.vectors.disabled=locked||state.vectorLoading||!state.vectorMissing;
            f.all.textContent=state.rebuildMode==='all'&&working?working:'一鍵重新整理全部';
            f.missing.textContent=state.rebuildMode==='missing'&&working?working:'一鍵整理未整理的';
            f.vectors.textContent=state.rebuildMode==='vectors'&&working?working:'補齊本機向量';
            f.scope.textContent=`全部重做：${state.total} 頁　僅補未整理：${state.missing} 頁（缺摘要 ${state.summaryMissing} 頁、只缺向量 ${state.vectorMissing} 頁）`;
            f.detail.textContent=(state.rebuildQueued?rebuildText():`包含 ${state.hidden} 頁隱藏正文，不含系統通知。全部重做會覆蓋摘要並呼叫 API；補未整理保留已有摘要，只為缺摘要的頁呼叫 API。向量會自動在本機補齊，按鈕保留作手動重試。`)+(state.vectorLoading?'正在恢復／建立本機向量，待補數量核對中。':'')+(state.generating&&!state.rebuildQueued?'目前正在生成回覆；現在按下會排隊，回覆完成後開始。':'');
            f.stop.hidden=!(state.stopping||state.resetting||state.rebuildQueued||job?.pending);f.stop.disabled=!!state.stopping;f.stop.textContent=state.stopping?'正在停止…':state.stopFailed?'重試停止':state.rebuildQueued?'取消排隊':'停止本次重整';f.retry.hidden=state.stopFailed||state.stopping||!job?.pending||!state.warning;f.retry.disabled=state.busy;
            f.progress.hidden=state.rebuildQueued||(state.resetting&&!job?.pending)||!job;setRebuildProgress(f.progress,job);
            f.outcome.textContent=state.stopping||state.stopFailed?rebuildText(job):state.rebuildQueued?'已排隊；等待本次角色回覆完成後開始。':state.resetting&&!job?.pending?'正在建立手動重新整理任務。':job?`本次${job.mode==='vectors'?'向量補齊':'重整'}：${job.mode==='vectors'?'':`摘要 ${job.done}/${job.total} 頁，`}向量 ${job.vectors}/${job.total} 頁${job.removed?`；${job.removed} 頁已刪除或變更，已略過`:''}${job.cancelled?`；${job.cancelled} 頁已停止並保留原記錄`:''}。${job.pending?state.generating?'等待正文生成結束後繼續。':state.warning?'等待重試，可立即重試或停止恢復未完成頁。':'正在處理，完成後會自動更新。':job.vectorFallback?'摘要已保留，向量尚待補齊，可按「補齊本機向量」。':job.cancelled?'已停止。':'已完成。'}`:'';
        }
    }
    function render(){renderRebuild();memoryOptions.render(state);if(tab==='run')renderRun();else if(tab==='pages')renderPages();else if(tab==='selection')renderSelection();else renderHelper();}
    function update(next){
        state=next;toggle.checked=next.enabled;toggleState.textContent=next.enabled?'已開啟':'已關閉';toggleLabel.dataset.enabled=String(next.enabled);status.textContent=next.status;warning.textContent=next.warning;warning.hidden=!next.warning;
        badge.textContent=next.conflict?'衝突暫停':!next.enabled?'暫停':`${next.ready}/${next.total}`;
        entry.title=next.status;renderAutoPopup();if(dialog.open)render();
    }
    setTab('run');update(state);
    return {update,open,dispose(){clearTimeout(autoTimer);apiForms.dispose();entry.remove();dialog.remove();autoPopup.remove();}};
}
