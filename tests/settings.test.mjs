import test from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../src/host.js';
import { generationOptions, memoryOptions, rolePrompt } from '../src/settings.js';
import { recentPages, splitBody } from '../src/core.js';

function fixture(){
    const c={mainApi:'openai',extensionSettings:{folio:{enabled:true,account:'settings-test'}},chatCompletionSettings:{chat_completion_source:'custom',custom_model:'main-a',openai_max_tokens:4000,temp_openai:1},saveSettingsDebounced(){},getRequestHeaders:()=>({})};
    const host=new Host(()=>c);host.api=async()=>({getChatCompletionModel:s=>s.custom_model,createGenerationParameters:async(s,model,type,messages)=>({generate_data:{model,messages,max_tokens:s.openai_max_tokens,temperature:s.temp_openai,top_p:s.top_p_openai}})});
    return {host,c};
}
test('fresh installation follows the live main model for both roles and preserves separate settings on mode switches',async()=>{
    const {host,c}=fixture(),calls=[],old=globalThis.fetch;globalThis.fetch=async(_url,options)=>{calls.push(JSON.parse(options.body));return Response.json({content:'{"summary":"測試"}'});};
    try{
        assert.equal(host.settings().apiMode,'main');await host.complete('','story');c.chatCompletionSettings.custom_model='main-b';await host.complete('','catalogue',{selection:true});
        assert.deepEqual(calls.map(x=>x.model),['main-a','main-b']);
        host.configureDirect('summary',{provider:'custom',baseUrl:'https://fixture.invalid/v1',model:'private-model',apiKey:'fixture-only-key'});
        const saved=structuredClone(host.settings().helpers.summary);host.configureApiMode('main');await host.complete('','story');assert.equal(calls.at(-1).model,'main-b');
        host.configureApiMode('separate');assert.deepEqual(host.settings().helpers.summary,saved);assert.equal(host.helper().model,'private-model');
    }finally{globalThis.fetch=old;}
});
test('advanced output sampling and prompt reach main, direct and profile requests without changing main settings',async()=>{
    const {host,c}=fixture(),calls=[],old=globalThis.fetch,before=JSON.stringify(c.chatCompletionSettings);globalThis.fetch=async(_url,options)=>{calls.push(JSON.parse(options.body));return Response.json({content:'{"summary":"測試"}'});};
    try{
        host.configureMemory({detail:'detailed',focus:'relationships'});host.configureAdvanced('summary',{maxTokens:640,temperature:.35,topP:.8,prompt:'記錄角色承諾。',contextTokens:8192});
        await host.complete('ignored','story');host.configureDirect('summary',{provider:'custom',baseUrl:'https://fixture.invalid/v1',model:'direct-model'});await host.complete('ignored','story');
        let profile;c.ConnectionManagerRequestService={getSupportedProfiles:()=>[{id:'p',name:'P',model:'profile-model'}],sendRequest:async(...args)=>{profile=args;return {content:'{"summary":"測試"}'};}};
        host.configureHelper('summary','p','profile-model');await host.complete('ignored','story');
        for(const call of calls){assert.equal(call.max_tokens,640);assert.equal(call.temperature,.35);assert.equal(call.top_p,.8);assert.match(call.messages[0].content,/記錄角色承諾/);assert.match(call.messages[0].content,/180 至 350/);}
        assert.equal(profile[2],640);assert.equal(profile[4].temperature,.35);assert.equal(profile[4].top_p,.8);assert.match(profile[1][0].content,/記錄角色承諾/);
        assert.equal(JSON.stringify(c.chatCompletionSettings),before);assert.equal(host.advanced('selection').maxTokens,1200);
        await assert.rejects(host.complete('','中'.repeat(10000)),/上下文上限/);assert.equal(calls.length,2);
    }finally{globalThis.fetch=old;}
});
test('invalid advanced settings cannot replace saved values; reset restores default prompt and summary chunking preserves every character',()=>{
    const {host}=fixture();host.configureAdvanced('summary',{contextTokens:4096,maxTokens:600});const saved=host.advanced('summary');
    assert.throws(()=>host.configureAdvanced('summary',{contextTokens:1000,maxTokens:800}),/上下文/);assert.deepEqual(host.advanced('summary'),saved);
    assert.throws(()=>generationOptions({temperature:3}));assert.throws(()=>memoryOptions({recallPages:0}));
    const text='連續正文內容。'.repeat(1700),size=host.summaryChunkSize();assert.ok(size<3600);assert.equal(splitBody(text,size).join(''),text);
    host.configureAdvanced('summary',{});assert.equal(host.advanced('summary').prompt,'');assert.match(rolePrompt('summary',{},{}),/目錄編輯/);
});
test('recent page setting preserves paired input and still observes available budget',()=>{
    const chat=Array.from({length:10},(_,i)=>({is_user:i%2===0,mes:'正文'+i,name:'test'})),costs=chat.map(()=>10);
    assert.deepEqual([...recentPages(chat,costs,1000,2).picked].sort((a,b)=>a-b),[6,7,8,9]);
    assert.deepEqual([...recentPages(chat,costs,25,5).picked].sort((a,b)=>a-b),[8,9]);
});
