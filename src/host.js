import { chooseModel, estimatedTokens } from './core.js';

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
        this.context = context; this.modules = null; this.rejected = new Set(); this.model = ''; this.counts = new Map();
    }
    async api() {
        // Isolate the one version-sensitive ST adapter; the rest uses getContext().
        if (!this.modules) this.modules = import('/scripts/openai.js').catch(e => { this.modules = null; throw e; });
        return this.modules;
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
        s.account ||= uid(); s.helperConnection ??= 'auto'; s.helperModel ??= '';
        return c.extensionSettings.folio;
    }
    profiles() {
        try { return this.context().ConnectionManagerRequestService?.getSupportedProfiles() ?? []; }
        catch { return []; }
    }
    helper() {
        const settings=this.settings(),profiles=this.profiles();
        let profile=settings.helperConnection==='auto'
            ? profiles.find(p=>/flash|mini|haiku|small|nano|[1378]b\b/i.test(`${p.name} ${p.model}`))
            : profiles.find(p=>p.id===settings.helperConnection);
        if(settings.helperConnection==='current')profile=null;
        return {profile, model:settings.helperModel || profile?.model || '', label:profile?.name || '目前聊天連線', automatic:settings.helperConnection==='auto'};
    }
    configureHelper(connection, model = '') {
        this.settings().helperConnection=connection;this.settings().helperModel=model.trim();
        this.rejected.clear();this.context().saveSettingsDebounced();
    }
    async modelChoices() {
        const api=await this.api();const helper=this.helper();
        if(helper.profile)return [...new Set([helper.profile.model,helper.model].filter(Boolean))];
        return [...new Set([api.getChatCompletionModel(this.context().chatCompletionSettings),...(api.model_list??[]).map(x=>x.id)].filter(Boolean))];
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
        const c = this.context();
        if (c.mainApi !== 'openai') throw new Error('目前先支援酒館的「聊天補全」連線；原本聊天不受影響');
        const helper=this.helper();
        if(!['auto','current'].includes(this.settings().helperConnection)&&!helper.profile)throw new Error('原助手連線已不存在，請在「記憶助手」重新選擇');
        if(helper.profile){
            const controller=new AbortController();const abort=()=>controller.abort(signal?.reason??new DOMException('Cancelled','AbortError'));
            signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});
            const timer=setTimeout(()=>controller.abort(new Error('記憶助手連線超時，稍後可重試')),selection?30000:60000);
            this.model=helper.model;
            try{
                const data=await c.ConnectionManagerRequestService.sendRequest(helper.profile.id,[{role:'system',content:system},{role:'user',content:prompt}],selection?1200:850,
                    {stream:false,signal:controller.signal,extractData:false,includePreset:false,includeInstruct:false},
                    {model:helper.model,temperature:.2,stream:false,type:'quiet',...helperPayload(helper.model)});
                return typeof data==='string'?data:completionText(data);
            }catch(e){if(controller.signal.aborted)throw controller.signal.reason;if(e.name==='FolioResponseError')throw e;throw new Error('記憶助手請求失敗，請在「記憶助手」頁測試連線');}
            finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
        }
        const api = await this.api();
        if (!api.createGenerationParameters || !api.getChatCompletionModel) throw new Error('這個酒館版本缺少記憶需要的連線介面');
        const original = structuredClone(c.chatCompletionSettings);
        const current = api.getChatCompletionModel(original);
        if (!current) throw new Error('等待酒館目前的模型連線');
        const preferred = this.settings().helperModel || chooseModel(current, api.model_list ?? [], this.rejected);
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
        signal?.throwIfAborted(); signal?.addEventListener('abort', abort, {once:true});
        const timer = setTimeout(() => controller.abort(new Error('摘要連線超時，稍後自動重試')), selection ? 30000 : 60000);
        try {
            for (const model of [...new Set([preferred, current])]) {
                controller.signal.throwIfAborted(); this.model = model;
                const settings = { ...original, stream_openai:false, openai_max_tokens:selection ? 1200 : 850,
                    temp_openai:.2, freq_pen_openai:0, pres_pen_openai:0, n:1, bias_preset_selected:'',
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
                    if ([400,404,422].includes(response.status) && model !== current) { this.rejected.add(model); continue; }
                    throw new Error(`摘要連線回應 ${response.status}；${response.status === 429 ? '稍後自動重試' : '請檢查酒館原本的連線'}`);
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
    async save() { await this.context().saveChat(); }
}
