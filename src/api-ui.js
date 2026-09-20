import { PROVIDERS, normalizeEndpoint } from './providers.js';
import { fold, mountAdvancedOptions } from './settings-ui.js';

export function mountApiForms(engine,container,{el,button,info,heading}) {
    const fields={};let state=engine.snapshot();
    const current=el('p','folio-api-current'),main=button('全部使用酒館主 API',()=>{engine.host.configureApiMode('main');engine.cancel();engine.connectionTests={summary:null,selection:null};engine.emit();engine.schedule();},'folio-primary');main.setAttribute('aria-pressed','false');
    container.append(heading('記憶助手','總結助手寫摘要；提取助手看摘要，選回需要的正文。預設兩者都跟隨酒館主 API 與目前模型。'),current,main);
    const customization=fold(el,'不同 API 與模型'),grid=el('div','folio-helper-grid');customization.append(el('p','folio-muted','需要分開時才設定。已保存的獨立連線會保留；保存任一用途或按下「啟用已保存的獨立設定」後使用方案二。'),button('啟用已保存的獨立設定',()=>{engine.host.configureApiMode('separate');engine.cancel();engine.connectionTests={summary:null,selection:null};engine.emit();engine.schedule();}),grid);container.append(customization);
    const advanced=mountAdvancedOptions(engine,customization,{el,button,info,heading});
    for(const [role,label,description]of [['summary','總結模型','寫目錄：清理後正文與玩家背景 → 標題、小摘要。'],['selection','提取模型','選正文：本次問題與候選小摘要 → 所需書頁及原因。']]){
        const section=el('section','folio-helper-section'),source=el('select'),connection=el('select'),url=el('input'),key=el('input'),model=el('input'),list=el('datalist'),picker=el('select');
        const configured=el('p','folio-muted'),result=el('div','folio-connection-result'),feedback=el('p','folio-api-feedback'),listStatus=el('p','folio-muted');
        feedback.setAttribute('role','status');listStatus.setAttribute('role','status');result.setAttribute('aria-live','polite');
        const f={source,connection,url,key,model,list,picker,configured,result,feedback,listStatus,dirty:false,version:0,controller:null,optionsKey:'',keyCleared:false};fields[role]=f;
        function labeled(input,suffix,text,help){input.id=`folio-${role}-${suffix}`;input.setAttribute('aria-label',text);const n=el('label','folio-field');n.htmlFor=input.id;
            const title=el('span','',text);if(help)title.append(info(help));n.append(title,input);return n;}
        for(const [id,name]of [['saved','酒館現有連線'],...Object.entries(PROVIDERS).map(([id,p])=>[id,p.label])]){const o=el('option','',name);o.value=id;source.append(o);}
        const sourceField=labeled(source,'source',`${label}來源`),connectionField=labeled(connection,'connection',`${label}連線`);
        url.type='url';url.autocomplete='off';url.spellcheck=false;
        const urlField=labeled(url,'url',`${label} API 網址`,'填 API 基址，不是聊天網頁。貼上 /chat/completions 或 /models 時會移除尾端路徑。請求由酒館伺服器發出；localhost 指酒館電腦，不是手機。更改網址需要重新輸入金鑰。');
        key.type='password';key.autocomplete='new-password';key.spellcheck=false;
        const keyField=labeled(key,'key',`${label} API 金鑰`,'只用於這個用途與網址。獨立 API 金鑰保存在酒館帳號設定（不是加密金鑰庫），不寫入聊天、摘要或取用紀錄；請勿分享含金鑰的設定備份。已保存金鑰不會回填到輸入框。');
        const keyActions=el('div','folio-key-actions');f.show=button('顯示',()=>{key.type=key.type==='password'?'text':'password';f.show.textContent=key.type==='password'?'顯示':'隱藏';});f.show.setAttribute('aria-label',`顯示或隱藏${label}金鑰`);
        const clear=el('input');clear.type='checkbox';clear.setAttribute('aria-label',`${label}不使用已存金鑰`);f.clear=clear;
        const clearLabel=el('label','folio-key-clear');clearLabel.append(clear,document.createTextNode('不使用已存金鑰'));keyActions.append(f.show,clearLabel);keyField.append(keyActions,el('small','folio-muted','保存在酒館帳號設定；不要分享含金鑰的備份。'));
        model.required=true;model.autocomplete='off';model.placeholder='填模型 ID，或從取得的列表選擇';list.id=`folio-${role}-models`;model.setAttribute('list',list.id);
        const modelField=labeled(model,'model',`${label}名稱`,'可直接手填模型 ID。列表僅代表接口列出的模型；權限、額度及是否能生成摘要，請用下方測試確認。');modelField.append(list);
        picker.setAttribute('aria-label',`${label}可選模型`);picker.hidden=true;
        const invalidate=()=>{f.version++;f.controller?.abort();f.controller=null;f.fetch.disabled=false;};
        const dirty=()=>{f.dirty=true;feedback.textContent='';configured.textContent='尚未保存；目前仍使用上次保存的設定。';result.replaceChildren();};
        const clearList=()=>{invalidate();list.replaceChildren();picker.replaceChildren();picker.hidden=true;listStatus.textContent='';};
        const draft=()=>({provider:source.value,baseUrl:url.value,apiKey:key.value,clearKey:clear.checked,model:model.value});
        const bindingMatches=()=>{try{const c=state.helpers[role];return c.connection==='direct'&&c.provider===source.value&&c.baseUrl===normalizeEndpoint(url.value,source.value);}catch{return false;}};
        function visibility(){const direct=source.value!=='saved';connectionField.hidden=direct;urlField.hidden=keyField.hidden=!direct;f.fetch.textContent=direct?'取得模型列表':'讀取連線模型';
            url.placeholder=PROVIDERS[source.value]?.url||'https://example.com/v1';
            const keep=bindingMatches()&&state.helpers[role].hasKey&&!clear.checked;
            key.placeholder=keep?'已保存；留空沿用這個網址的金鑰':source.value==='custom'?'需驗證的接口請填；本機免金鑰可留空':'貼上這個來源的 API 金鑰';
            clearLabel.hidden=!keep&&!clear.checked;
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
            if(source.value==='saved')engine.host.configureHelper(role,connection.value,model.value);
            else engine.host.configureDirect(role,draft());
            key.value='';key.type='password';f.show.textContent='顯示';clear.checked=false;f.dirty=false;f.optionsKey='';
            engine.cancel();engine.connectionTests[role]=null;engine.retry();feedback.textContent='已保存。';
        }
        function action(task){return async()=>{feedback.textContent='';try{await task();}catch(e){feedback.textContent=e.message||'操作未完成，請稍後重試';}};}
        f.test=button(`測試${label}`,action(async()=>{if(f.dirty||state.apiMode==='main')save();await engine.testHelper(role);}));
        const actions=el('div','folio-toolbar');actions.append(button(`保存${label}`,action(save),'folio-primary'),f.test);
        const modelsBar=el('div','folio-toolbar');modelsBar.append(f.fetch);modelField.append(modelsBar,picker,listStatus);
        section.append(heading(label),el('p','folio-muted',description),sourceField,connectionField,urlField,keyField,modelField,configured,actions,feedback,result);grid.append(section);
        source.addEventListener('change',()=>{clearList();dirty();url.value=PROVIDERS[source.value]?.url??'';key.value='';key.type='password';f.show.textContent='顯示';clear.checked=false;model.value='';visibility();});
        url.addEventListener('input',()=>{clearList();dirty();key.value='';clear.checked=false;visibility();});
        key.addEventListener('input',()=>{clearList();dirty();clear.checked=false;visibility();});
        clear.addEventListener('change',()=>{clearList();dirty();key.value='';visibility();});
        model.addEventListener('input',dirty);
        picker.addEventListener('change',()=>{if(picker.value){model.value=picker.value;dirty();}});
        connection.addEventListener('change',()=>{clearList();dirty();model.value=state.profiles.find(p=>p.id===connection.value)?.model??'';load();});
        f.render=()=>{
            const config=state.helpers[role],options=[{id:'current',name:'目前聊天連線（模型分開指定）'},...state.profiles];
            for(const id of [config.connection,f.dirty?connection.value:null].filter(id=>id&&id!=='direct'))if(!options.some(p=>p.id===id))options.push({id,name:'原連線已不存在，請重新選擇'});
            const optionsKey=JSON.stringify(options);if(connection.dataset.options!==optionsKey){const prev=connection.value;connection.replaceChildren(...options.map(p=>{const o=el('option','',p.name);o.value=p.id;return o;}));connection.dataset.options=optionsKey;connection.value=f.dirty?prev:config.connection;}
            if(!f.dirty){source.value=config.connection==='direct'?config.provider:'saved';connection.value=config.connection==='direct'?'current':config.connection;url.value=config.baseUrl||'';model.value=config.model;
                configured.textContent=`已保存：${config.label||'目前聊天連線'} / ${config.model||'尚未填寫模型'}${config.lastModel?`；最近呼叫：${config.lastModel}`:''}`;}
            visibility();f.test.disabled=state.busy;
            const keyOptions=source.value+connection.value+JSON.stringify(state.profiles);
            if(customization.open&&f.optionsKey!==keyOptions){f.optionsKey=keyOptions;if(source.value==='saved')load();}
            if(!f.dirty){const outcome=state.connectionTests[role];result.replaceChildren();
                if(outcome)result.append(el('p',outcome.ok?'folio-observed':'folio-muted',outcome.pending?'正在測試這個用途…':outcome.ok?`${outcome.model} 測試通過，用時 ${(outcome.ms/1000).toFixed(1)} 秒。`:`測試未通過：${outcome.error}`));
                if(outcome?.ok)result.append(el('p','folio-summary-text',outcome.summary));}
        };
    }
    container.append(el('p','folio-muted','向量已內建，會在本機運行。'));
    customization.addEventListener('toggle',()=>{if(customization.open)for(const f of Object.values(fields))f.render();});
    return {render(next){state=next;const follows=state.apiMode==='main';main.setAttribute('aria-pressed',String(follows));main.textContent=follows?'已使用酒館主 API':'全部使用酒館主 API';current.textContent=follows?`方案一：總結與提取都跟隨酒館目前的 API 和模型${state.mainModel?'（'+state.mainModel+'）':''}。`:'方案二：正在使用已保存的獨立設定；展開下方可查看與修改。';for(const f of Object.values(fields))f.render();advanced.render(state);},conceal(){for(const f of Object.values(fields)){f.key.type='password';f.show.textContent='顯示';}},dispose(){for(const f of Object.values(fields))f.controller?.abort();}};
}
