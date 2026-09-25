import { estimatedTokens, SUMMARY_CHUNK_CHARS, SUMMARY_CONTEXT_CHARS, listedContext, knownContext, UNKNOWN_MODEL_CONTEXT } from './core.js';
import { PROVIDERS, directConfig, providerRequest, modelIds, apiError } from './providers.js';
import { memoryOptions, generationOptions, rolePrompt, checkContext } from './settings.js';
import {mergeUsage,compactUsage,USAGE_KEY} from './usage.js';
export const MODEL_ROLES = {summary:'總結模型',selection:'提取模型'};

export function helperPayload(model) {
    // ST's custom backend only forwards extra vendor fields through this YAML/JSON field.
    // DeepSeek Flash defaults to thinking: a tiny output cap can otherwise produce no answer.
    const overrides={include_reasoning:false};
    if(/(?:^|\/)deepseek-(?:flash|pro|v4(?:[-/]|$))/i.test(model))overrides.custom_include_body=JSON.stringify({thinking:{type:'disabled'}});
    return overrides;
}
export function completionText(data) {
    const choice=data?.choices?.[0],message=choice?.message?.content??data?.content??data?.text;
    const text=Array.isArray(message)?message.filter(x=>x.type==='text').map(x=>x.text).join('\n'):message;
    if(choice?.finish_reason==='length'){
        const error=new Error('總結模型的輸出被截斷；插件會保留原記錄並重試，請勿把回覆長度設得過低');
        error.name='FolioOutputLimitError';throw error;
    }
    if(typeof text!=='string'||!text.trim()){
        const error=new Error(choice?.finish_reason==='length'?'助手用盡輸出額度但未回傳摘要；可能仍在思考，請改用非思考模型':'助手沒有回傳正文，請在記憶助手頁測試連線');
        error.name='FolioResponseError';throw error;
    }
    return text;
}

export function uid() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2,'0')).join('');
}

export class Host {
    constructor(context = () => SillyTavern.getContext()) {
        this.context = context; this.modules = null; this.rejected = new Set(); this.model = ''; this.models={summary:'',selection:''}; this.counts = new Map();this.apiSaveTask=null;
    }
    async api() {
        // Isolate the one version-sensitive ST adapter; the rest uses getContext().
        if (!this.modules) this.modules = import('/scripts/openai.js').catch(e => { this.modules = null; throw e; });
        return this.modules;
    }
    async generationActive() {
        const c=this.context();
        if(typeof c.isGenerating==='function')return !!c.isGenerating();
        // Live host state repairs missed/early-return generation events. Do not infer
        // completion from a timeout or from the visibility of Folio's own controls.
        try{
            this.generationModule??=import('/script.js').catch(e=>{this.generationModule=null;throw e;});
            const api=await this.generationModule;
            if(typeof api.isGenerating!=='function')return null;
            return !!api.isGenerating()||globalThis.document?.body?.dataset.generating==='true';
        }catch{return null;}
    }
    async memoryConflict() {
        const extensions = await import('/scripts/extensions.js');
        const disabled = this.context().extensionSettings.disabledExtensions ?? [];
        return (extensions.extensionNames ?? []).find(name => /(?:^|\/)Anima-Memory-System(?:$|-)/i.test(name) && !disabled.includes(name)) ?? '';
    }
    async useFolioInstead(name) {
        if (!name || name !== await this.memoryConflict()) return;
        const extensions = await import('/scripts/extensions.js');
        await extensions.disableExtension(name, true);
    }
    settings() {
        const c = this.context();
        if (!c.extensionSettings.folio) {
            c.extensionSettings.folio = { enabled:true, account:uid() }; c.saveSettingsDebounced();
        }
        const s=c.extensionSettings.folio;
        s.account ||= uid();
        if(!s.apiMode){s.apiMode=s.helpers||s.helperConnection||s.helperModel?'separate':'main';c.saveSettingsDebounced();}
        if(!s.helpers){
            const legacy=s.helperConnection??'auto',profiles=this.profiles();
            const profile=legacy==='auto'?profiles.find(p=>/flash|mini|haiku|small|nano|[1378]b\b/i.test(`${p.name} ${p.model}`)):profiles.find(p=>p.id===legacy);
            const o=c.chatCompletionSettings??{};
            const model=s.helperModel||profile?.model||o[`${o.chat_completion_source}_model`]||'';
            const connection=profile?.id||(legacy==='auto'?'current':legacy);
            s.helpers={summary:{connection,model},selection:{connection,model}};
            c.saveSettingsDebounced();
        }
        for(const role of Object.keys(MODEL_ROLES))s.helpers[role]??={connection:'current',model:''};
        return c.extensionSettings.folio;
    }
    profiles() {
        try { return this.context().ConnectionManagerRequestService?.getSupportedProfiles() ?? []; }
        catch { return []; }
    }
    helper(role='summary',saved=false) {
        if(!MODEL_ROLES[role])throw new Error('未知模型用途');
        if(!saved&&this.settings().apiMode==='main'){
            const o=this.context().chatCompletionSettings??{},source=o.chat_completion_source;
            return {connection:'main',model:String(o[`${source}_model`]??(source==='makersuite'?o.google_model:undefined)??o.model??''),label:'酒館主 API（跟隨目前模型）',role,provider:'',baseUrl:'',hasKey:false};
        }
        const config=this.settings().helpers[role],profile=config.connection==='current'?null:this.profiles().find(p=>p.id===config.connection);
        return {profile,connection:config.connection,model:config.model.trim(),label:config.connection==='direct'?(PROVIDERS[config.provider]?.label??'自訂接口'):profile?.name||'目前聊天連線',role,
            provider:config.provider??'',baseUrl:config.baseUrl??'',hasKey:!!config.apiKey};
    }
    helperStatus(role='summary') {
        const h=this.helper(role),c=this.context(),source=c.chatCompletionSettings?.chat_completion_source;
        const provider=PROVIDERS[source==='makersuite'?'google':source]?.label||source||'未選來源';
        const label=h.connection==='main'?`酒館主 API · ${provider}`:h.connection==='current'?`酒館目前連線 · ${provider}（模型獨立指定）`:h.connection==='direct'?`獨立 API · ${h.label}`:`酒館連線檔 · ${h.label}`;
        const issue=!h.model?'尚未填寫模型':h.connection==='direct'?(!h.baseUrl?'尚未填寫 API 網址':''):!['main','current'].includes(h.connection)&&!h.profile?'原連線已不存在':c.mainApi!=='openai'?'主連線不是聊天補全模式':'';
        return {connection:h.connection,label,model:h.model,endpoint:h.connection==='direct'?h.baseUrl:'',ready:!issue,issue};
    }
    configureHelper(role,connection,model='',{activate=true,persist=true}={}) {
        if(!MODEL_ROLES[role])throw new Error('未知模型用途');
        if(!model.trim())throw new Error(`請填寫${MODEL_ROLES[role]}名稱`);
        if(connection!=='current'&&!this.profiles().some(p=>p.id===connection))throw new Error('連線已不存在，請重新選擇');
        this.settings().helpers[role]={connection,model:model.trim()};
        if(activate)this.settings().apiMode='separate';
        this.rejected.clear();if(persist)this.context().saveSettingsDebounced();
    }
    configureDirect(role,input,{activate=true,persist=true}={}) {
        if(!MODEL_ROLES[role])throw new Error('未知模型用途');
        const config=directConfig(input,this.settings().helpers[role]);
        this.settings().helpers[role]=config;if(activate)this.settings().apiMode='separate';if(this.settings().apiMode==='separate')this.models[role]='';if(persist)this.context().saveSettingsDebounced();
    }
    async verifyApiSaved(expected) {
        const c=this.context();
        if(typeof c.saveSettings==='function')await c.saveSettings();
        else {
            this.settingsModule??=import('/script.js').catch(e=>{this.settingsModule=null;throw e;});
            const api=await this.settingsModule;
            if(typeof api.saveSettings!=='function')throw new Error('酒館缺少即時保存介面');
            await api.saveSettings();
        }
        // Native saveSettings catches HTTP failures. Its resolved promise is not
        // an acknowledgement; read back the exact API configuration from disk.
        const response=await fetch('/api/settings/get',{method:'POST',headers:c.getRequestHeaders(),body:'{}',cache:'no-store',signal:AbortSignal.timeout(15000)});
        if(!response.ok)throw new Error('無法核對保存結果');
        const data=await response.json(),settings=typeof data.settings==='string'?JSON.parse(data.settings):data.settings;
        const saved=settings?.extension_settings?.folio;
        if(!saved||saved.apiMode!==expected.apiMode||JSON.stringify(saved.helpers)!==JSON.stringify(expected.helpers))throw new Error('伺服器保存內容不一致');
    }
    saveApiChange(change) {
        if(this.apiSaveTask)return Promise.reject(new Error('API 設定正在保存，請稍候'));
        const settings=this.settings(),before={apiMode:settings.apiMode,helpers:structuredClone(settings.helpers)};
        let expected;
        try{change();expected={apiMode:settings.apiMode,helpers:structuredClone(settings.helpers)};}catch(error){return Promise.reject(error);}
        const task=Promise.resolve().then(()=>this.verifyApiSaved(expected)).catch(()=>{
            // Keep the last working settings in this window. The form keeps its
            // unsaved draft, and no list request is needed to retry the save.
            if(settings.apiMode===expected.apiMode)settings.apiMode=before.apiMode;
            if(JSON.stringify(settings.helpers)===JSON.stringify(expected.helpers))settings.helpers=before.helpers;
            throw new Error('API 設定未確認保存到酒館；草稿已保留，本視窗沿用原設定。請重試保存，不必重新取得模型列表。');
        }).finally(()=>{if(this.apiSaveTask===task)this.apiSaveTask=null;});
        this.apiSaveTask=task;return task;
    }
    saveHelper(role,source,input) {
        return this.saveApiChange(()=>source==='saved'?this.configureHelper(role,input.connection,input.model,{activate:false,persist:false}):this.configureDirect(role,input,{activate:false,persist:false}));
    }
    saveApiMode(mode){return this.saveApiChange(()=>this.configureApiMode(mode,{persist:false}));}
    savedApiKey(role,provider,baseUrl) {
        if(!MODEL_ROLES[role])throw new Error('未知模型用途');
        const config=this.settings().helpers[role];
        // Only the credential field explicitly requests this value. Keep it out of
        // snapshots, connection status, activity, chat and usage records.
        return config?.connection==='direct'&&config.provider===provider&&config.baseUrl===baseUrl?String(config.apiKey??''):'';
    }
    configureApiMode(mode,{persist=true}={}){if(!['main','separate'].includes(mode))throw new Error('請選擇 API 方案');this.settings().apiMode=mode;this.models={summary:'',selection:''};if(persist)this.context().saveSettingsDebounced();}
    memory(){return memoryOptions(this.settings().memory);}
    advanced(role){return generationOptions(this.settings().advanced?.[role],role);}
    configureMemory(input){this.settings().memory=memoryOptions(input);this.context().saveSettingsDebounced();}
    configureAdvanced(role,input){if(!MODEL_ROLES[role])throw new Error('未知模型用途');const value=generationOptions(input,role);this.settings().advanced??={};this.settings().advanced[role]=value;this.context().saveSettingsDebounced();}
    summaryChunkSize(){
        const a=this.advanced('summary');if(!a.contextTokens)return SUMMARY_CHUNK_CHARS;
        const envelope=JSON.stringify({speaker:'角色',contextBefore:'背'.repeat(SUMMARY_CONTEXT_CHARS),playerInput:'玩'.repeat(SUMMARY_CONTEXT_CHARS),text:''});
        const available=a.contextTokens-a.maxTokens-estimatedTokens(rolePrompt('summary',a,this.memory()))-estimatedTokens(envelope)-128;
        if(available<270)throw new Error('總結上下文設定太小，連一小段正文都放不下；請把上下文長度設為 0（自動）或提高上限');
        return Math.max(180,Math.min(SUMMARY_CHUNK_CHARS,Math.floor(available/1.5)));
    }
    async fetchModels(role,input,{signal}={}) {
        if(!MODEL_ROLES[role])throw new Error('未知模型用途');
        const config=directConfig(input,this.settings().helpers[role],false);
        return modelIds(await this.directRequest(config,{models:true,signal},'取得模型列表'));
    }
    async directRequest(config,options,task) {
        const controller=new AbortController(),signal=options.signal;
        const abort=()=>controller.abort(signal.reason??new DOMException('Cancelled','AbortError'));
        signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});
        const timer=setTimeout(()=>controller.abort(new Error(`${task}超時，請稍後重試`)),options.models?30000:60000);
        try{
            const response=await fetch('/api/backends/chat-completions/'+(options.models?'status':'generate'),{
                method:'POST',headers:this.context().getRequestHeaders(),body:JSON.stringify(providerRequest(config,options)),signal:controller.signal,
            });
            if(!response.ok){await response.body?.cancel();throw apiError(response.status,task);}
            let data;try{data=await response.json();}catch{throw new Error(`${task}未返回 JSON；請檢查 API 網址，不要填網頁登入地址`);}
            if(data?.error)throw new Error(`${task}被接口拒絕；請核對來源、網址、金鑰及模型，不會使用其他連線`);
            controller.signal.throwIfAborted();return data;
        }catch(error){
            if(controller.signal.aborted)throw controller.signal.reason;
            // Never display raw transport/server errors: they may echo Authorization or a URL key.
            if(error instanceof TypeError)throw new Error(`${task}無法連到酒館後端，請檢查網路後重試`);
            throw error;
        }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
    }
    async modelChoices(role='summary',connection=this.helper(role).connection) {
        const helper=this.helper(role,true),profile=this.profiles().find(p=>p.id===connection);
        if(profile)return [...new Set([profile.model,helper.model].filter(Boolean))];
        const api=await this.api();
        return [...new Set([api.getChatCompletionModel(this.context().chatCompletionSettings),...(api.model_list??[]).map(x=>x.id)].filter(Boolean))];
    }
    async modelLimits() {
        const o=this.context().chatCompletionSettings??{};let model='',list=[];
        try{const api=await this.api();model=api.getChatCompletionModel?.(o)??'';list=Array.isArray(api.model_list)?api.model_list:[];}catch{}
        model||=String(o[`${o.chat_completion_source}_model`]??'');
        const entry=model?list.find(x=>x?.id===model)??list.find(x=>x?.name===model):null,listed=listedContext(entry),known=listed?0:knownContext(model);
        const hostContext=Number(o.openai_max_context)||0,unlocked=!!o.max_context_unlocked;
        // An unlocked or oversized slider is not evidence of a larger model window.
        const fallback=!listed&&!known&&(unlocked||hostContext>UNKNOWN_MODEL_CONTEXT)?UNKNOWN_MODEL_CONTEXT:0;
        return {model,context:listed||known||fallback,source:listed?'list':known?'known':fallback?'default':'host',hostContext,reply:Number(o.openai_max_tokens)||0,unlocked};
    }
    identity() {
        const c = this.context();
        if (!c.chatId) return '';
        return JSON.stringify([this.settings().account, c.groupId ?? c.characters?.[c.characterId]?.avatar ?? c.characterId, c.chatId]);
    }
    async count(text) {
        const c = this.context();
        const model = JSON.stringify(Object.entries(c.chatCompletionSettings ?? {}).filter(([k])=>k.endsWith('_model') || k === 'chat_completion_source'));
        const key = model + ':' + text;
        if (this.counts.has(key)) return this.counts.get(key);
        let timer;
        try {
            const n = await Promise.race([c.getTokenCountAsync(text),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1200);})]);
            const value = Number.isFinite(n) && n > 0 ? n + 8 : estimatedTokens(text);
            if (this.counts.size > 1000) this.counts.clear();
            this.counts.set(key,value); return value;
        } catch { return estimatedTokens(text); } finally { clearTimeout(timer); }
    }
    async complete(system, prompt, {signal, selection = false} = {}) {
        // Never start generation with half-saved form data or require /models to
        // initialize a connection. After failure the last working config is used.
        if(this.apiSaveTask){
            signal?.throwIfAborted();let abort;
            try{await Promise.race([this.apiSaveTask.catch(()=>{}),new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal?.addEventListener('abort',abort,{once:true});})]);}
            finally{signal?.removeEventListener('abort',abort);}
        }
        signal?.throwIfAborted();
        const c = this.context();
        const role=selection?'selection':'summary',helper=this.helper(role),label=MODEL_ROLES[role];
        const advanced=this.advanced(role);system=rolePrompt(role,advanced,this.memory());checkContext(system,prompt,advanced);
        if(helper.connection==='main'){const api=await this.api();helper.model=api.getChatCompletionModel(c.chatCompletionSettings??{})||'';}
        if(!helper.model)throw new Error(`請在「記憶助手」填寫${label}`);
        if(helper.connection==='direct'){
            const config=directConfig(this.settings().helpers[role]);this.model=config.model;this.models[role]=config.model;
            return completionText(await this.directRequest(config,{signal,selection,maxTokens:advanced.maxTokens,temperature:advanced.temperature,topP:advanced.topP,messages:[{role:'system',content:system},{role:'user',content:prompt}]},label));
        }
        if (c.mainApi !== 'openai') throw new Error('目前先支援酒館的「聊天補全」連線；原本聊天不受影響');
        if(!['current','main'].includes(helper.connection)&&!helper.profile)throw new Error(`${label}的連線已不存在，請重新選擇`);
        if(helper.profile){
            const controller=new AbortController();const abort=()=>controller.abort(signal?.reason??new DOMException('Cancelled','AbortError'));
            signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});
            const timer=setTimeout(()=>controller.abort(new Error(`${label}連線超時，稍後可重試`)),60000);
            this.model=helper.model;this.models[role]=helper.model;
            try{
                const data=await c.ConnectionManagerRequestService.sendRequest(helper.profile.id,[{role:'system',content:system},{role:'user',content:prompt}],advanced.maxTokens,
                    {stream:false,signal:controller.signal,extractData:false,includePreset:false,includeInstruct:false},
                    {model:helper.model,temperature:advanced.temperature??.2,...(advanced.topP==null?{}:{top_p:advanced.topP}),stream:false,type:'quiet',...helperPayload(helper.model)});
                return typeof data==='string'?data:completionText(data);
            }catch(e){if(controller.signal.aborted)throw controller.signal.reason;if(e.name==='FolioResponseError')throw e;throw new Error('記憶助手請求失敗，請在「記憶助手」頁測試連線');}
            finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
        }
        const api = await this.api();
        if (!api.createGenerationParameters || !api.getChatCompletionModel) throw new Error('這個酒館版本缺少記憶需要的連線介面');
        const original = structuredClone(c.chatCompletionSettings);
        const current = api.getChatCompletionModel(original);
        if (!current) throw new Error('等待酒館目前的模型連線');
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
        signal?.throwIfAborted(); signal?.addEventListener('abort', abort, {once:true});
        const timer = setTimeout(() => controller.abort(new Error(`${label}連線超時，稍後可重試`)),60000);
        try {
            for (const model of [helper.model]) {
                controller.signal.throwIfAborted(); this.model = model;this.models[role]=model;
                const settings = { ...original, stream_openai:false, openai_max_tokens:advanced.maxTokens,
                    temp_openai:advanced.temperature??.2,...(advanced.topP==null?{}:{top_p_openai:advanced.topP}), freq_pen_openai:0, pres_pen_openai:0, n:1, bias_preset_selected:'',
                    show_thoughts:false, enable_web_search:false, request_images:false, seed:-1 };
                const { generate_data:body } = await api.createGenerationParameters(settings, model, 'quiet', [
                    {role:'system', content:system}, {role:'user', content:prompt},
                ]);
                // No host generation events or mutable global model overrides; this is a separate request.
                for (const key of ['tools','tool_choice','stop','logprobs','top_logprobs','logit_bias','n']) delete body[key];
                body.stream = false;
                Object.assign(body,helperPayload(model));
                const response = await fetch('/api/backends/chat-completions/generate', {
                    method:'POST', headers:c.getRequestHeaders(), body:JSON.stringify(body), signal:controller.signal,
                });
                if (!response.ok) {
                    await response.body?.cancel();
                    throw new Error(`${label}連線回應 ${response.status}；${response.status === 429 ? '稍後自動重試' : '請檢查該模型設定，不會改叫其他模型'}`);
                }
                const data = await response.json();
                if(data.error)throw new Error('摘要連線回傳錯誤，請在記憶助手頁測試連線');
                return completionText(data);
            }
            throw new Error('目前連線沒有可用的摘要模型');
        } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason;
            throw error;
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    readUsage(){const records=this.context().chatMetadata?.[USAGE_KEY]?.records;return Array.isArray(records)?records:[];}
    stageUsage(identity,records){
        const c=this.context();if(!identity||identity!==this.identity()||!c.chatMetadata||!records.length)return false;
        const merged=mergeUsage(records,this.readUsage()).map(r=>compactUsage(r,c.chat??[]));
        if(JSON.stringify(merged)===JSON.stringify(this.readUsage()))return false;
        c.chatMetadata[USAGE_KEY]={version:1,records:structuredClone(merged)};
        // Do not save here. During streaming ST emits GENERATION_ENDED before
        // MESSAGE_RECEIVED and before its own saveChatConditional. Starting a
        // second save races the native reply save and can roll both back. The
        // synchronous metadata change is included in the native save that follows.
        return true;
    }
    async save() { await this.context().saveChat(); }
}
