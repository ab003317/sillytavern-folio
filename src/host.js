import { chooseModel, estimatedTokens } from './core.js';

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
    settings() {
        const c = this.context();
        if (!c.extensionSettings.folio) {
            c.extensionSettings.folio = { enabled:true, account:uid() }; c.saveSettingsDebounced();
        }
        return c.extensionSettings.folio;
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
        const api = await this.api();
        if (!api.createGenerationParameters || !api.getChatCompletionModel) throw new Error('這個酒館版本缺少記憶需要的連線介面');
        const original = structuredClone(c.chatCompletionSettings);
        const current = api.getChatCompletionModel(original);
        if (!current) throw new Error('等待酒館目前的模型連線');
        const preferred = chooseModel(current, api.model_list ?? [], this.rejected);
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
        signal?.throwIfAborted(); signal?.addEventListener('abort', abort, {once:true});
        const timer = setTimeout(() => controller.abort(new Error('摘要連線超時，稍後自動重試')), selection ? 16000 : 45000);
        try {
            for (const model of [...new Set([preferred, current])]) {
                controller.signal.throwIfAborted(); this.model = model;
                const settings = { ...original, stream_openai:false, openai_max_tokens:selection ? 300 : 600,
                    temp_openai:.2, freq_pen_openai:0, pres_pen_openai:0, n:1, bias_preset_selected:'',
                    show_thoughts:false, enable_web_search:false, request_images:false, seed:-1 };
                const { generate_data:body } = await api.createGenerationParameters(settings, model, 'quiet', [
                    {role:'system', content:system}, {role:'user', content:prompt},
                ]);
                // No host generation events or mutable global model overrides; this is a separate request.
                for (const key of ['tools','tool_choice','stop','logprobs','top_logprobs','logit_bias','n']) delete body[key];
                body.stream = false;
                const response = await fetch('/api/backends/chat-completions/generate', {
                    method:'POST', headers:c.getRequestHeaders(), body:JSON.stringify(body), signal:controller.signal,
                });
                if (!response.ok) {
                    await response.body?.cancel();
                    if ([400,404,422].includes(response.status) && model !== current) { this.rejected.add(model); continue; }
                    throw new Error(`摘要連線回應 ${response.status}；${response.status === 429 ? '稍後自動重試' : '請檢查酒館原本的連線'}`);
                }
                const data = await response.json();
                const message = data.choices?.[0]?.message?.content ?? data.content ?? data.text;
                const text = Array.isArray(message) ? message.filter(x => x.type === 'text').map(x => x.text).join('\n') : message;
                if (data.error || typeof text !== 'string' || !text.trim()) throw new Error('摘要模型沒有回傳正文');
                return text;
            }
            throw new Error('目前連線沒有可用的摘要模型');
        } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason;
            throw error;
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    async save() { await this.context().saveChat(); }
}
