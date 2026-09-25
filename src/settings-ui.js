import { MEMORY_DEFAULTS, generationOptions } from './settings.js';
import { SUMMARY_SYSTEM, SELECT_SYSTEM, MODEL_TIERS } from './core.js';

export function fold(el,title,level=2){const d=el('details','folio-settings-fold');d.dataset.level=String(level);d.append(el('summary','',title));return d;}
function field(el,info,input,label,help){input.setAttribute('aria-label',label);const wrap=el('label','folio-field'),title=el('span','',label);if(help)title.append(info(help));wrap.append(title,input);return wrap;}
function select(el,options){const input=el('select');for(const [value,title] of options){const o=el('option','',title);o.value=value;input.append(o);}return input;}
function numeric(el,{min,max,step=1,placeholder=''}){const input=el('input');input.type='number';Object.assign(input,{min,max,step,placeholder});return input;}
const invalidate=engine=>{engine.cancel();engine.warning='';engine.connectionTests={summary:null,selection:null};engine.emit();engine.schedule();};

export function mountMemoryOptions(engine,container,{el,button,info}){
    const section=fold(el,'摘要與取用設定'),advanced=fold(el,'進階容量限制',3),feedback=el('p','folio-api-feedback');feedback.setAttribute('role','status');
    const inputs={detail:select(el,[['brief','精簡'],['standard','標準'],['detailed','詳細（預設）']]),focus:select(el,[['balanced','事件與人物兼顧'],['plot','劇情、因果與線索'],['relationships','人物關係與承諾']]),recentPages:numeric(el,{min:0,max:20,placeholder:'0：依模型自動'}),recallPages:numeric(el,{min:0,max:8,placeholder:'0：依模型自動'}),recallNote:select(el,[['true','開啟（預設）'],['false','關閉']]),historyBudget:numeric(el,{min:0,max:200000,placeholder:'0：自動'})};
    const capacity=el('p','folio-muted folio-capacity'),mismatch=el('p','folio-usage-warning');mismatch.hidden=true;
    section.append(el('p','folio-muted','調整摘要寫法、保留近期正文與舊事召回。預設按目前模型的實際上下文自動分配；改摘要方式只影響接下來的整理，舊頁要按一鍵重新整理才更新。'),capacity,mismatch);
    for(const [key,label,help] of [['detail','摘要詳略','每段摘要的目標長度：精簡 50–100 字、標準 80–180 字、詳細 180–350 字。'],['focus','摘要重點','只記錄已發生的事件；選項和玩家願望不會被當成事實。'],['recentPages','保留近期正文頁數','0 代表依模型自動：小上下文按容量保留，長上下文約 4 頁／12k tokens，超長上下文約 6 頁／24k tokens。更早的頁一律經目錄查找。1–20 為自訂上限，至少保留最新回合。'],['recallPages','每次最多召回舊正文','0 代表依模型自動（小 3／長 6／超長 8 頁）。釘選頁另外計算，全部仍受容量限制。'],['recallNote','書頁回顧提示','在最後一則玩家輸入前加入一段簡短提示，列出這次取回的舊正文頁、原因與一小段原文，讓模型知道哪些舊情節與本次相關。只引用原文，不發送摘要。']])section.append(field(el,info,inputs[key],label,help));
    advanced.append(field(el,info,inputs.historyBudget,'歷史正文預算（tokens）','0 使用自動預算。自訂值可進一步限制記憶歷史容量；不覆寫酒館主聊天的總上下文或回覆設定。'));section.append(advanced);
    let dirty=false;for(const input of Object.values(inputs))input.addEventListener('input',()=>{dirty=true;feedback.textContent='尚未保存';});
    const sourceLabel={list:'酒館模型列表',known:'已知規格',default:'未能識別，保守估計',host:'沿用酒館設定'};
    function render(state){
        if(!dirty)for(const [key,input] of Object.entries(inputs))input.value=String((state.memory??MEMORY_DEFAULTS)[key]??MEMORY_DEFAULTS[key]);
        const c=state.capacity,n=v=>Number(v).toLocaleString();capacity.hidden=!c;mismatch.hidden=true;if(!c)return;
        capacity.textContent=`目前模型 ${c.model||'未選擇'}：${c.context?`實際上下文 ${n(c.context)}（${sourceLabel[c.source]??c.source}）`:'上下文沿用酒館設定'}。書頁按 ${n(c.capacity)} 可用輸入計算（${MODEL_TIERS[c.tier]?.label??c.tier}）：歷史目標 ${n(c.history)} tokens，近期正文最多 ${Number.isFinite(c.recent)?n(c.recent):'—'} tokens${c.recentPages?`／${c.recentPages} 頁`:''}，其餘舊頁經目錄查找，每次最多召回 ${c.recallPages} 頁。`;
        if(c.context&&c.hostContext>c.context){mismatch.hidden=false;mismatch.textContent=`酒館的上下文設定 ${n(c.hostContext)} 大於這個模型的實際上限 ${n(c.context)}。書頁已按模型上限計算；建議在酒館關閉「解鎖上下文」或把上下文調到 ${n(c.context)} 以下，避免主請求超出模型上限。`;}
    }
    const actions=el('div','folio-toolbar');actions.append(button('保存摘要與取用設定',()=>{try{engine.host.configureMemory(Object.fromEntries(Object.entries(inputs).map(([key,input])=>[key,input.value])));dirty=false;invalidate(engine);feedback.textContent='已保存；舊聊天仍需手動整理。';render(engine.snapshot());}catch(e){feedback.textContent=e.message;}},'folio-primary'),button('恢復預設',()=>{engine.host.configureMemory(MEMORY_DEFAULTS);dirty=false;invalidate(engine);render(engine.snapshot());feedback.textContent='已恢復預設；未啟動整理。';}));
    section.append(actions,feedback);container.append(section);render(engine.snapshot());return {render};
}

export function mountAdvancedOptions(engine,container,{el,button,info,heading}){
    const section=fold(el,'進階參數與提示詞',3),grid=el('div','folio-helper-grid'),fields={};
    section.append(el('p','folio-muted','只影響記憶助手的請求，不改主聊天設定。上下文填 0、取樣參數或提示詞留空即可使用預設。'),grid);container.append(section);
    for(const [role,label] of [['summary','總結'],['selection','提取']]){
        const body=el('section'),feedback=el('p','folio-api-feedback');feedback.setAttribute('role','status');
        const inputs={contextTokens:numeric(el,{min:0,max:2000000,placeholder:'0：自動'}),maxTokens:numeric(el,{min:64,max:64000}),temperature:numeric(el,{min:0,max:2,step:.05,placeholder:'自動'}),topP:numeric(el,{min:.01,max:1,step:.01,placeholder:'自動'}),prompt:el('textarea','folio-prompt-editor')};
        inputs.prompt.rows=7;inputs.prompt.placeholder=role==='summary'?SUMMARY_SYSTEM:SELECT_SYSTEM;
        const f={inputs,dirty:false};fields[role]=f;body.append(heading(`${label}助手`));
        for(const [key,title,help] of [['contextTokens','上下文長度（tokens）','0 使用現有分段與候選數。自訂後限制助手輸入加輸出，超限會明確提示；長正文會按此容量分段。'],['maxTokens','回覆長度上限（tokens）','這是助手回傳摘要／選頁結果的上限，不是主聊天回覆長度。'],['temperature','溫度','留空使用自動設定；部分推理模型不支援自訂溫度。'],['topP','Top P','留空沿用相容的自動設定。'],['prompt','提示詞','留空使用內建提示詞。輸出仍須符合摘要／選頁 JSON 格式；可在此定義記錄重點和語氣。']])body.append(field(el,info,inputs[key],`${label}${title}`,help));
        for(const input of Object.values(inputs))input.addEventListener('input',()=>{f.dirty=true;feedback.textContent='尚未保存';});
        const actions=el('div','folio-toolbar');actions.append(button(`保存${label}進階設定`,()=>{try{engine.host.configureAdvanced(role,Object.fromEntries(Object.entries(inputs).map(([key,input])=>[key,input.value])));f.dirty=false;invalidate(engine);render(engine.snapshot());feedback.textContent='已保存，接下來的助手請求生效。';}catch(e){feedback.textContent=e.message;}},'folio-primary'),button(`重設${label}進階設定`,()=>{engine.host.configureAdvanced(role,{});f.dirty=false;invalidate(engine);render(engine.snapshot());feedback.textContent='已恢復內建參數與提示詞。';}));body.append(actions,feedback);grid.append(body);
    }
    function render(state){for(const [role,f] of Object.entries(fields))if(!f.dirty){const values=state.advanced?.[role]??generationOptions({},role);for(const [key,input] of Object.entries(f.inputs))input.value=String(values[key]??'');}}
    render(engine.snapshot());return {render};
}

export function mountPerformanceOptions(engine,container,{el,info}){
    const section=fold(el,'手機效能'),input=select(el,[['true','開啟（預設）'],['false','關閉']]),calm=select(el,[['auto','僅手機等觸控裝置（預設）'],['on','所有裝置'],['off','關閉']]),feedback=el('p','folio-api-feedback');feedback.setAttribute('role','status');
    section.append(el('p','folio-muted','酒館在每次收到、編輯或刪除訊息後，都會在背景完整組裝一次提示詞（含整本世界書掃描），只為更新提示詞管理面板上的 token 數，面板沒打開也照做。開啟後改為打開該面板時才補算一次；實際發送不受影響。'),
        field(el,info,input,'面板關閉時延後提示詞試算','大型世界書或遞迴設定下，手機每則回覆可省下數秒卡頓。關閉即恢復酒館原本行為。'),
        field(el,info,calm,'訊息美化中的無限循環動畫只播一次','狀態欄等美化常有永不停止的裝飾動畫（如掃描線），手機會因此持續重繪、打字與捲動發澀。開啟後這類動畫播完一輪即停；彈出、展開等一次性動畫不受影響。不修改角色卡或預設。'),feedback);
    calm.addEventListener('change',()=>{engine.host.settings().calmAnimations=calm.value;engine.host.context().saveSettingsDebounced();engine.performanceChanged?.();feedback.textContent=calm.value==='off'?'已關閉；動畫恢復原樣（已停止的動畫需重新渲染該樓層）。':'已套用到目前顯示的美化內容。';});
    input.addEventListener('change',()=>{engine.host.settings().deferDryRun=input.value==='true';engine.host.context().saveSettingsDebounced();feedback.textContent=input.value==='true'?'已開啟；下次打開提示詞管理面板時會補算。':'已關閉；恢復酒館原本的背景試算。';});
    container.append(section);
    return {render(){input.value=String(engine.host.settings().deferDryRun!==false);calm.value=engine.host.settings().calmAnimations??'auto';}};
}
