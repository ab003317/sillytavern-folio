// Provider presets are connection defaults, never a hard-coded list of available models.
export const PROVIDERS = Object.freeze({
    openai:{label:'OpenAI',url:'https://api.openai.com/v1',source:'openai'},
    claude:{label:'Claude (Anthropic)',url:'https://api.anthropic.com/v1',source:'claude'},
    openrouter:{label:'OpenRouter',url:'https://openrouter.ai/api/v1',source:'custom'},
    google:{label:'Google Gemini',url:'https://generativelanguage.googleapis.com/v1beta',source:'makersuite'},
    mistral:{label:'Mistral',url:'https://api.mistral.ai/v1',source:'custom'},
    deepseek:{label:'DeepSeek',url:'https://api.deepseek.com/v1',source:'custom'},
    custom:{label:'自訂（OpenAI 相容）',url:'',source:'custom'},
});

export function normalizeEndpoint(value,provider='custom') {
    if(!Object.hasOwn(PROVIDERS,provider))throw new Error('請選擇支援的 API 來源');
    let url;
    try { url=new URL(String(value??'').trim()); } catch { throw new Error('請填寫完整 API 網址，例如 https://example.com/v1'); }
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)
        throw new Error('API 網址只接受 HTTP／HTTPS；金鑰請填在金鑰欄，不要放在網址中');
    let path=url.pathname.replace(/\/+$/,'');
    path=path.replace(/\/(?:chat\/completions|messages|models)$/,'');
    if(provider==='google'){
        if(/\/v1(?:alpha)?$/.test(path))throw new Error('此酒館 Gemini 接口使用 v1beta，請填來源預設網址');
        if(!path.endsWith('/v1beta'))path+='/v1beta';
    }
    return url.origin+path;
}

export function directConfig(input,previous={},requireModel=true) {
    const provider=input.provider,baseUrl=normalizeEndpoint(input.baseUrl,provider);
    const same=previous.connection==='direct'&&previous.provider===provider&&previous.baseUrl===baseUrl;
    // An explicitly empty field is empty, not a hidden instruction to reuse a key.
    // Programmatic callers can omit the field to preserve the SAME destination.
    const apiKey=input.clearKey?'':String(Object.hasOwn(input,'apiKey')?(input.apiKey??''):(same?previous.apiKey??'':'')).trim();
    if(/[\r\n]/.test(apiKey))throw new Error('API 金鑰不能包含換行，請只貼上一把金鑰');
    if(!apiKey&&provider!=='custom')throw new Error('請填寫此來源的 API 金鑰');
    const model=String(input.model??'').trim();
    if(requireModel&&!model)throw new Error('請填寫模型名稱，或先取得模型列表');
    return {connection:'direct',provider,baseUrl,apiKey,model};
}

export function providerRequest(config,{messages,selection=false,models=false,maxTokens,temperature,topP}={}) {
    const {provider,baseUrl,apiKey,model}=config,p=PROVIDERS[provider];
    // Construct from scratch: never inherit main-model credentials, tools or vendor options.
    const body={chat_completion_source:p.source,secret_id:'folio-no-inherited-secret',reverse_proxy:'',proxy_password:'',custom_include_headers:'',custom_include_body:'',custom_exclude_body:''};
    if(p.source==='custom'){
        body.custom_url=baseUrl;
        body.custom_include_headers=JSON.stringify({Authorization:apiKey?'Bearer '+apiKey:''});
    }else{
        body.reverse_proxy=provider==='google'?baseUrl.replace(/\/v1beta$/,''):baseUrl;
        body.proxy_password=apiKey;
    }
    // ST has no Claude model-list route; its custom GET /models can carry Claude headers.
    if(models&&provider==='claude')Object.assign(body,{chat_completion_source:'custom',custom_url:baseUrl,reverse_proxy:'',proxy_password:'',
        custom_include_headers:JSON.stringify({Authorization:'','x-api-key':apiKey,'anthropic-version':'2023-06-01'})});
    if(models)return body;
    Object.assign(body,{model,messages,stream:false,type:'quiet',max_tokens:maxTokens??(selection?1200:850),include_reasoning:false,use_sysprompt:true});
    if(temperature!=null)body.temperature=temperature;if(topP!=null)body.top_p=topP;
    // Omit sampling unless explicitly configured: some reasoning models reject it.
    if(p.source==='custom'&&/(?:^|\/)deepseek-(?:flash|pro|v4(?:[-/]|$))/i.test(model))
        body.custom_include_body=JSON.stringify({thinking:{type:'disabled'}});
    return body;
}

export function modelIds(data) {
    if(data?.error)throw new Error('模型列表取得失敗；請檢查來源、網址與金鑰，也可手填模型後測試');
    const list=Array.isArray(data?.data)?data.data:Array.isArray(data?.models)?data.models:Array.isArray(data)?data:[];
    const ids=[...new Set(list.filter(x=>x&&(!x.supportedGenerationMethods||x.supportedGenerationMethods.includes('generateContent')))
        .map(x=>typeof x==='string'?x:x.id??x.name).filter(x=>typeof x==='string'&&x.trim()).map(x=>x.replace(/^models\//,'')))];
    if(!ids.length)throw new Error('接口沒有提供可用模型列表；可手填模型 ID，再按測試模型');
    return ids.sort((a,b)=>a.localeCompare(b));
}

export function apiError(status,task) {
    const hint=status===401||status===403?'金鑰無效或權限不足':status===404?'網址或接口路徑不存在':status===429?'額度或速率限制，稍後重試':status===400?'接口拒絕請求，請核對來源、模型 ID 與接口格式':status>=500?'服務商或酒館代理發生錯誤':'請檢查 API 設定';
    return new Error(`${task}回應 ${status}：${hint}。不會改叫其他來源或模型。`);
}
