import { PROVIDERS, normalizeEndpoint } from './providers.js';
import { fold, mountAdvancedOptions } from './settings-ui.js';

export function mountApiForms(engine,container,{el,button,info,heading}) {
    const fields={},activeRows={};let state=engine.snapshot();
    const mode=el('section','folio-api-mode'),modeHead=el('div','folio-api-mode-head'),current=el('strong','folio-api-current'),modeDescription=el('p','folio-muted'),modeFeedback=el('p','folio-api-feedback');
    current.setAttribute('role','status');modeFeedback.setAttribute('role','status');
    const toggleLabel=el('label','folio-toggle folio-api-toggle'),toggle=el('input'),track=el('span','folio-switch-track'),copy=el('span','folio-toggle-copy'),toggleState=el('span','folio-toggle-state');
    toggle.type='checkbox';toggle.id='folio-api-mode';toggle.setAttribute('role','switch');toggle.setAttribute('aria-label','使用獨立 API');
    track.setAttribute('aria-hidden','true');track.append(el('span','folio-switch-knob'));copy.append(el('span','','使用獨立 API'),toggleState);toggleLabel.append(toggle,track,copy);
    modeHead.append(current,toggleLabel);mode.append(modeHead,modeDescription,modeFeedback);
    container.append(heading('記憶助手','總結助手寫摘要；提取助手看摘要，選回正文。下面顯示下一次請求實際使用的來源，不是上一次測試結果。'),mode);
    const customization=fold(el,'不同 API 與模型'),grid=el('div','folio-helper-grid');customization.append(el('p','folio-muted','這裡保存兩個用途的獨立設定。是否啟用只由上方開關決定；保存或取得模型列表不會切換模式。'),grid);container.append(customization);
    toggle.addEventListener('change',()=>{
        modeFeedback.textContent='';
        try{
            const separate=toggle.checked;engine.host.configureApiMode(separate?'separate':'main');engine.cancel();engine.connectionTests={summary:null,selection:null};
            for(const f of Object.values(fields))f.feedback.textContent='';
            engine.emit();engine.schedule();if(separate)customization.open=true;
        }catch(e){toggle.checked=engine.host.settings().apiMode==='separate';modeFeedback.textContent=e.message||'切換未完成';}
    });
    const active=el('div','folio-active-helpers');mode.append(active);
    for(const [role,label] of [['summary','總結'],['selection','提取']]){
        const row=el('div','folio-active-helper'),detail=el('div','folio-active-detail'),source=el('span','folio-active-source'),model=el('strong','folio-active-model'),endpoint=el('span','folio-active-endpoint'),issue=el('span','folio-active-issue'),result=el('p','folio-active-test-result');
        row.dataset.role=role;result.setAttribute('role','status');
        const test=button(`測試目前${label}連線`,async()=>{modeFeedback.textContent='';try{await engine.testHelper(role);}catch(e){modeFeedback.textContent=e.message||'測試未完成';}});
        detail.append(source,model,endpoint,issue);row.append(el('span','folio-active-role',label),detail,test,result);active.append(row);activeRows[role]={row,source,model,endpoint,issue,test,result};
    }
    const advanced=mountAdvancedOptions(engine,customization,{el,button,info,heading});
    for(const [role,label,description]of [['summary','總結模型','寫目錄：清理後正文與玩家背景 → 標題、小摘要。'],['selection','提取模型','選正文：本次問題與候選小摘要 → 所需書頁及原因。']]){
        const section=el('section','folio-helper-section'),source=el('select'),connection=el('select'),url=el('input'),key=el('input'),model=el('input'),list=el('datalist'),picker=el('select');
        const configured=el('p','folio-muted'),result=el('div','folio-connection-result'),feedback=el('p','folio-api-feedback'),listStatus=el('p','folio-muted');
        feedback.setAttribute('role','status');listStatus.setAttribute('role','status');result.setAttribute('aria-live','polite');
        const f={source,connection,url,key,model,list,picker,configured,result,feedback,listStatus,dirty:false,version:0,controller:null,optionsKey:''};fields[role]=f;
        function labeled(input,suffix,text,help){input.id=`folio-${role}-${suffix}`;input.setAttribute('aria-label',text);const n=el('label','folio-field');n.htmlFor=input.id;
            const title=el('span','',text);if(help)title.append(info(help));n.append(title,input);return n;}
        for(const [id,name]of [['saved','酒館現有連線'],...Object.entries(PROVIDERS).map(([id,p])=>[id,p.label])]){const o=el('option','',name);o.value=id;source.append(o);}
        const sourceField=labeled(source,'source',`${label}來源`),connectionField=labeled(connection,'connection',`${label}連線`);
        url.type='url';url.autocomplete='off';url.spellcheck=false;
        const urlField=labeled(url,'url',`${label} API 網址`,'填 API 基址，不是聊天網頁。貼上 /chat/completions 或 /models 時會移除尾端路徑。請求由酒館伺服器發出；localhost 指酒館電腦，不是手機。更改網址需要重新輸入金鑰。');
        key.type='password';key.autocomplete='new-password';key.spellcheck=false;
        const keyField=labeled(key,'key',`${label} API 金鑰`,'已保存金鑰會遮罩回填；按「顯示」可查看，修改後按下方保存。只用於目前用途與網址，不會帶到其他來源。保存在酒館帳號設定，不是加密金鑰庫；不寫入聊天或取用紀錄。');
        const keyActions=el('div','folio-key-actions'),keyStatus=el('small','folio-key-status');keyStatus.setAttribute('role','status');
        f.show=button('顯示',()=>{key.type=key.type==='password'?'text':'password';f.show.textContent=key.type==='password'?'顯示':'隱藏';f.show.setAttribute('aria-pressed',String(key.type==='text'));});f.show.setAttribute('aria-label',`顯示或隱藏${label}金鑰`);f.show.setAttribute('aria-pressed','false');
        const clear=button('清空',()=>{key.value='';key.type='password';f.show.textContent='顯示';clearList();dirty();visibility();feedback.textContent='金鑰欄已清空，尚未保存。需要驗證的接口請填入新金鑰。';});
        clear.setAttribute('aria-label',`清空${label}金鑰`);keyActions.append(f.show,clear);keyField.append(keyActions,keyStatus);
        model.required=true;model.autocomplete='off';model.placeholder='填模型 ID，或從取得的列表選擇';list.id=`folio-${role}-models`;model.setAttribute('list',list.id);
        const modelField=labeled(model,'model',`${label}名稱`,'可直接手填模型 ID。列表僅代表接口列出的模型；權限、額度及是否能生成摘要，請用下方測試確認。');modelField.append(list);
        picker.setAttribute('aria-label',`${label}可選模型`);picker.hidden=true;
        const invalidate=()=>{f.version++;f.controller?.abort();f.controller=null;f.fetch.disabled=false;};
        const dirty=()=>{f.dirty=true;feedback.textContent='';configured.textContent='未保存的草稿；不影響上方顯示的生效連線。';f.test.disabled=true;result.replaceChildren();};
        const clearList=()=>{invalidate();list.replaceChildren();picker.replaceChildren();picker.hidden=true;listStatus.textContent='';};
        const draft=()=>({provider:source.value,baseUrl:url.value,apiKey:key.value,model:model.value});
        const bindingMatches=()=>{try{const c=state.helpers[role];return c.connection==='direct'&&c.provider===source.value&&c.baseUrl===normalizeEndpoint(url.value,source.value);}catch{return false;}};
        function visibility(){const direct=source.value!=='saved';connectionField.hidden=direct;urlField.hidden=keyField.hidden=!direct;f.fetch.textContent=direct?'取得模型列表':'讀取連線模型';
            url.placeholder=PROVIDERS[source.value]?.url||'https://example.com/v1';
            const saved=bindingMatches()?engine.host.savedApiKey(role,source.value,normalizeEndpoint(url.value,source.value)):'';
            key.placeholder=source.value==='custom'?'本機免驗證接口可留空；其他接口請填金鑰':'貼上這個來源的 API 金鑰';
            keyStatus.textContent=key.value?(key.value===saved?'金鑰已保存；可按「顯示」查看。':'金鑰已填入，尚未保存。'):saved?'金鑰欄已清空，尚未保存。':source.value==='custom'?'未填金鑰；僅適用於免驗證接口。':'尚未填寫金鑰。';
            f.show.disabled=clear.disabled=!key.value;f.show.setAttribute('aria-pressed',String(key.type==='text'));
        }
        const populate=ids=>{list.replaceChildren(...ids.map(id=>{const o=el('option');o.value=id;return o;}));const first=el('option','','選擇一個模型（不會自動保存）');first.value='';picker.replaceChildren(first,...ids.map(id=>{const o=el('option','',id);o.value=id;return o;}));picker.hidden=!ids.length;};
        async function load(){clearList();const version=f.version,controller=new AbortController();f.controller=controller;f.fetch.disabled=true;listStatus.textContent='正在取得模型列表…';
            try{const direct=source.value!=='saved',ids=direct?await engine.host.fetchModels(role,draft(),{signal:controller.signal}):await engine.host.modelChoices(role,connection.value);
                if(version!==f.version)return;populate(ids);listStatus.textContent=direct?`取得 ${ids.length} 個模型；是否能用，請再測試。`:'已讀取酒館連線的模型建議，也可手填。';
            }catch(e){if(version===f.version&&!controller.signal.aborted)listStatus.textContent=e.message;}
            finally{if(version===f.version){f.fetch.disabled=false;f.controller=null;}}
        }
        f.fetch=button('取得模型列表',load,'folio-fetch-models');
        function save(){
            if(source.value==='saved')engine.host.configureHelper(role,connection.value,model.value,{activate:false});
            else engine.host.configureDirect(role,draft(),{activate:false});
            key.type='password';f.show.textContent='顯示';f.dirty=false;f.optionsKey='';
            if(engine.host.settings().apiMode==='separate'){engine.cancel();engine.connectionTests[role]=null;engine.retry();}else engine.emit();
            feedback.textContent=engine.host.settings().apiMode==='main'?'已保存，尚未啟用；目前仍使用酒館主 API。':'已保存，獨立設定已生效。';
        }
        function action(task){return async()=>{feedback.textContent='';try{await task();}catch(e){feedback.textContent=e.message||'操作未完成，請稍後重試';}};}
        f.test=button(`測試${label}`,action(async()=>{if(f.dirty)throw new Error('請先保存草稿；測試只使用已生效的設定');if(state.apiMode==='main')throw new Error('獨立設定尚未啟用；請使用上方測試目前連線');await engine.testHelper(role);}));
        const actions=el('div','folio-toolbar');actions.append(button(`保存${label}`,action(save),'folio-primary'),f.test);
        const modelsBar=el('div','folio-toolbar');modelsBar.append(f.fetch);modelField.append(modelsBar,picker,listStatus);
        section.append(heading(label),el('p','folio-muted',description),sourceField,connectionField,urlField,keyField,modelField,configured,actions,feedback,result);grid.append(section);
        source.addEventListener('change',()=>{clearList();dirty();url.value=PROVIDERS[source.value]?.url??'';key.value='';key.type='password';f.show.textContent='顯示';model.value='';visibility();});
        url.addEventListener('input',()=>{clearList();dirty();key.value='';key.type='password';f.show.textContent='顯示';visibility();});
        key.addEventListener('input',()=>{clearList();dirty();visibility();});
        model.addEventListener('input',dirty);
        picker.addEventListener('change',()=>{if(picker.value){model.value=picker.value;dirty();}});
        connection.addEventListener('change',()=>{clearList();dirty();model.value=state.profiles.find(p=>p.id===connection.value)?.model??'';load();});
        f.render=()=>{
            const config=state.helpers[role],options=[{id:'current',name:'目前聊天連線（模型分開指定）'},...state.profiles];
            for(const id of [config.connection,f.dirty?connection.value:null].filter(id=>id&&id!=='direct'))if(!options.some(p=>p.id===id))options.push({id,name:'原連線已不存在，請重新選擇'});
            const optionsKey=JSON.stringify(options);if(connection.dataset.options!==optionsKey){const prev=connection.value;connection.replaceChildren(...options.map(p=>{const o=el('option','',p.name);o.value=p.id;return o;}));connection.dataset.options=optionsKey;connection.value=f.dirty?prev:config.connection;}
            if(!f.dirty){source.value=config.connection==='direct'?config.provider:'saved';connection.value=config.connection==='direct'?'current':config.connection;url.value=config.baseUrl||'';model.value=config.model;
                key.value=config.connection==='direct'?engine.host.savedApiKey(role,config.provider,config.baseUrl):'';
                configured.textContent=`${state.apiMode==='main'?'已保存，未啟用':'已保存，目前生效'}：${config.label||'目前聊天連線'} / ${config.model||'尚未填寫模型'}`;}
            visibility();f.test.disabled=state.busy||state.generating||f.dirty||state.apiMode==='main';
            const keyOptions=source.value+connection.value+JSON.stringify(state.profiles);
            if(customization.open&&f.optionsKey!==keyOptions){f.optionsKey=keyOptions;if(source.value==='saved')load();}
            if(!f.dirty){const outcome=state.connectionTests[role];result.replaceChildren();
                if(outcome&&state.apiMode!=='main')result.append(el('p',outcome.ok?'folio-observed':'folio-muted',outcome.pending?'正在測試這個用途…':outcome.ok?`${outcome.model} 測試通過，用時 ${(outcome.ms/1000).toFixed(1)} 秒。`:`測試未通過：${outcome.error}`));
                if(outcome?.ok&&state.apiMode!=='main')result.append(el('p','folio-summary-text',outcome.summary));}
        };
    }
    container.append(el('p','folio-muted','向量已內建，會在本機運行。'));
    customization.addEventListener('toggle',()=>{if(customization.open)for(const f of Object.values(fields))f.render();});
    return {render(next){
        state=next;const follows=state.apiMode==='main';toggle.checked=!follows;toggle.disabled=!!state.generating||!!state.resetting||!!state.stopping;toggleLabel.dataset.enabled=String(!follows);mode.dataset.mode=state.apiMode;
        toggleState.textContent=follows?'已關閉 · 跟隨主 API':'已開啟 · 使用獨立設定';current.textContent=follows?'目前生效：酒館主 API':'目前生效：獨立 API 設定';
        modeDescription.textContent=follows?'總結與提取跟隨酒館目前模型。獨立設定只保留、不啟用。':'總結與提取使用下列已保存設定，不再自動跟隨主模型。切回主 API 不會刪除獨立設定。';
        for(const [role,r] of Object.entries(activeRows)){
            const h=state.activeHelpers?.[role]??{},outcome=state.connectionTests[role];r.source.textContent=h.label||'等待酒館連線';r.model.textContent=h.model||'尚未選擇模型';r.endpoint.textContent=h.endpoint||'';r.endpoint.hidden=!h.endpoint;r.issue.textContent=h.issue||'';r.issue.hidden=!h.issue;
            r.test.disabled=state.busy||state.generating||!h.ready;r.test.title='只測試上方顯示的生效連線，不保存或啟用草稿；可能產生 API 費用';
            r.result.textContent=outcome?.pending?'正在測試目前生效的連線…':outcome?.ok?`測試通過：${outcome.model} · ${(outcome.ms/1000).toFixed(1)} 秒`:outcome?`測試未通過：${outcome.error}`:'';r.result.hidden=!outcome;
        }
        for(const f of Object.values(fields))f.render();advanced.render(state);
    },conceal(){for(const f of Object.values(fields)){f.key.type='password';f.show.textContent='顯示';f.show.setAttribute('aria-pressed','false');}},dispose(){for(const f of Object.values(fields))f.controller?.abort();}};
}
