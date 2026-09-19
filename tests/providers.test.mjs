import test from 'node:test';
import assert from 'node:assert/strict';
import {PROVIDERS,normalizeEndpoint,directConfig,providerRequest,modelIds} from '../src/providers.js';
import {Host} from '../src/host.js';

const config=(provider='custom',extra={})=>directConfig({provider,baseUrl:PROVIDERS[provider].url||'https://synthetic.invalid/v1',apiKey:'fixture-only-key',model:'fixture-model',...extra});
function fixture(){const c={mainApi:'openai',extensionSettings:{folio:{account:'fixture',helpers:{summary:{connection:'current',model:'before'},selection:{connection:'current',model:'old-extract'}}}},chatCompletionSettings:{chat_completion_source:'custom',custom_url:'https://main.invalid',custom_include_headers:'MAIN-MUST-NOT-LEAK'},saveSettingsDebounced(){},getRequestHeaders:()=>({'Content-Type':'application/json'})};return {c,host:new Host(()=>c)};}
async function intercept(fn,run){const previous=globalThis.fetch;globalThis.fetch=fn;try{await run();}finally{globalThis.fetch=previous;}}

test('provider endpoints strip full operation paths without duplicating version or dropping custom prefixes',()=>{
    assert.equal(normalizeEndpoint(' https://host.invalid/prefix/v1/chat/completions/ '),'https://host.invalid/prefix/v1');
    assert.equal(normalizeEndpoint('http://127.0.0.1:11434/v1/models'),'http://127.0.0.1:11434/v1');
    assert.equal(normalizeEndpoint('https://host.invalid/prefix/v1/messages','claude'),'https://host.invalid/prefix/v1');
    for(const url of ['https://host.invalid','https://host.invalid/v1beta','https://host.invalid/v1beta/models'])assert.equal(normalizeEndpoint(url,'google'),'https://host.invalid/v1beta');
    for(const url of ['javascript:alert(1)','file:///private','https://user:pass@host.invalid','https://host.invalid?key=private','https://host.invalid#private','host.invalid'])assert.throws(()=>normalizeEndpoint(url));
    assert.throws(()=>normalizeEndpoint('https://host.invalid/v1','google'),/v1beta/);
});

test('empty key only reuses exact role destination; changing source/URL cannot leak old credentials',()=>{
    const previous=config('deepseek');
    assert.equal(directConfig({...previous,apiKey:'',model:'new'},previous).apiKey,'fixture-only-key');
    assert.throws(()=>directConfig({...previous,apiKey:'',baseUrl:'https://new.invalid/v1'},previous),/金鑰/);
    assert.throws(()=>directConfig({...previous,provider:'openai',apiKey:''},previous),/金鑰/);
    assert.throws(()=>directConfig({...previous,clearKey:true},previous),/金鑰/);
    const noKey=directConfig({...previous,provider:'custom',apiKey:''},previous);assert.equal(noKey.apiKey,'');
    assert.equal(directConfig({...config(),apiKey:'',clearKey:true},config()).apiKey,'');
    assert.throws(()=>config('custom',{apiKey:'abc\nInjected: key'}),/換行/);
    assert.throws(()=>config('custom',{model:''}),/模型/);
});

for(const provider of Object.keys(PROVIDERS))test(`${provider} routes its own endpoint/key/model for both generation and model list`,()=>{
    const c=config(provider),r=providerRequest(c,{messages:[{role:'user',content:'fixture'}]}),m=providerRequest(c,{models:true});
    assert.equal(r.model,'fixture-model');assert.equal(r.stream,false);assert.equal(r.max_tokens,850);assert.equal(providerRequest(c,{selection:true}).max_tokens,1200);
    assert.equal(r.secret_id,'folio-no-inherited-secret');assert.equal(m.secret_id,'folio-no-inherited-secret');assert.equal(m.messages,undefined);
    if(['claude','google','openai'].includes(provider)){
        assert.equal(r.proxy_password,c.apiKey);assert.equal(r.reverse_proxy,provider==='google'?c.baseUrl.replace('/v1beta',''):c.baseUrl);
    }else{
        assert.equal(r.custom_url,c.baseUrl);assert.equal(JSON.parse(r.custom_include_headers).Authorization,'Bearer fixture-only-key');
    }
    if(provider==='claude'){assert.equal(m.chat_completion_source,'custom');assert.equal(JSON.parse(m.custom_include_headers)['x-api-key'],c.apiKey);assert.equal(m.proxy_password,'');}
    if(provider==='google'){assert.equal(m.chat_completion_source,'makersuite');assert.ok(!m.reverse_proxy.includes('v1beta'));}
});

test('anonymous custom request explicitly suppresses native main custom secret',()=>{
    const body=providerRequest(config('custom',{apiKey:''}));
    assert.equal(JSON.parse(body.custom_include_headers).Authorization,'');assert.ok(body.secret_id);
});

test('model responses validate errors, dedupe and support native Gemini normalization',()=>{
    assert.deepEqual(modelIds({data:[{id:'z'},{id:'a'},{id:'z'}]}),['a','z']);
    assert.deepEqual(modelIds({models:[{name:'models/chat',supportedGenerationMethods:['generateContent']},{name:'models/embed',supportedGenerationMethods:['embedContent']}]}),['chat']);
    for(const bad of [{error:true,data:[{id:'should-not-appear'}]},'<html>',{},null])assert.throws(()=>modelIds(bad));
});

test('direct roles stay independent and snapshot/helper never exposes API key',async()=>{
    const {c,host}=fixture(),before=structuredClone(c.chatCompletionSettings),calls=[];
    host.configureDirect('summary',config('deepseek',{model:'summary-mini'}));host.configureDirect('selection',config('claude',{model:'extract-mini',apiKey:'extract-fixture-key'}));
    assert.ok(!JSON.stringify(host.helper('summary')).includes('fixture-only-key'));assert.equal(host.helper('summary').hasKey,true);
    await intercept(async(url,req)=>{calls.push(JSON.parse(req.body));return Response.json({choices:[{message:{content:'fixture output'}}]});},async()=>{
        await host.complete('s','p');await host.complete('s','p',{selection:true});
    });
    assert.deepEqual(calls.map(x=>x.model),['summary-mini','extract-mini']);assert.equal(calls[1].proxy_password,'extract-fixture-key');
    assert.ok(!JSON.stringify(calls).includes('MAIN-MUST-NOT-LEAK'));assert.deepEqual(c.chatCompletionSettings,before);
    assert.deepEqual(host.models,{summary:'summary-mini',selection:'extract-mini'});
});

test('fetch models uses unsaved draft without storing key or changing active config',async()=>{
    const {host}=fixture(),before=structuredClone(host.settings());let body;
    await intercept(async(url,req)=>{assert.equal(url,'/api/backends/chat-completions/status');body=JSON.parse(req.body);return Response.json({data:[{id:'fixture-mini'}]});},async()=>{
        assert.deepEqual(await host.fetchModels('summary',{...config('openai'),model:''}),['fixture-mini']);
    }).catch(e=>{throw e;});
    assert.equal(body.proxy_password,'fixture-only-key');assert.deepEqual(host.settings(),before);
});

test('400/401/404/429/500 and HTTP 200 errors never retry another provider or echo a response key',async()=>{
    for(const status of [400,401,404,429,500,200]){
        const {host}=fixture();host.configureDirect('summary',config());let calls=0;
        await intercept(async()=>{calls++;return Response.json({error:{message:'fixture-only-key secret echo'}},{status});},async()=>{
            await assert.rejects(host.complete('s','p'),e=>!e.message.includes('fixture-only-key')&&(status===200||e.message.includes(String(status))));
        });assert.equal(calls,1);
    }
});

test('HTML is not a model result; pre-abort performs no request, in-flight cancellation discards reply',async()=>{
    const {host}=fixture();host.configureDirect('summary',config());
    await intercept(async()=>new Response('<html>fixture-only-key</html>'),async()=>{await assert.rejects(host.complete('s','p'),/JSON/);});
    let calls=0;const controller=new AbortController();controller.abort();
    await intercept(async()=>{calls++;},async()=>{await assert.rejects(host.complete('s','p',{signal:controller.signal}),e=>e.name==='AbortError');});assert.equal(calls,0);
    const pending=new AbortController();
    await intercept(async()=>{pending.abort();return Response.json({content:'late wrong page'});},async()=>{await assert.rejects(host.complete('s','p',{signal:pending.signal}),e=>e.name==='AbortError');});
});
