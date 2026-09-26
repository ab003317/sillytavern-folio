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

test('saving dormant direct or profile settings leaves main mode, active model and keys intact',()=>{
    const {host,c}=fixture();host.models.summary='main-a';
    host.configureDirect('summary',{provider:'custom',baseUrl:'https://fixture.invalid/v1',model:'private-model',apiKey:'fixture-only-key'},{activate:false});
    host.configureHelper('selection','current','private-selection',{activate:false});
    assert.equal(host.settings().apiMode,'main');assert.equal(host.helper('summary').model,'main-a');assert.equal(host.models.summary,'main-a');
    assert.equal(host.helperStatus('selection').model,'main-a');assert.match(host.helperStatus('summary').label,/酒館主 API/);
    host.configureApiMode('separate');assert.equal(host.helperStatus('summary').model,'private-model');assert.match(host.helperStatus('summary').label,/獨立 API/);
    assert.equal(host.helperStatus('selection').model,'private-selection');assert.match(host.helperStatus('selection').label,/模型獨立指定/);
    assert.ok(!JSON.stringify(host.helperStatus('summary')).includes('fixture-only-key'));
    host.configureApiMode('main');assert.equal(host.settings().helpers.summary.apiKey,'fixture-only-key');
    c.chatCompletionSettings.custom_model='main-b';assert.equal(host.helperStatus('selection').model,'main-b');
});

test('effective connection status flags incomplete and deleted profiles, not successful historical tests',()=>{
    const {host,c}=fixture();host.configureApiMode('separate');host.settings().helpers.summary={connection:'current',model:''};
    assert.equal(host.helperStatus().ready,false);assert.match(host.helperStatus().issue,/模型/);
    host.settings().helpers.summary={connection:'gone',model:'missing-profile-model'};assert.match(host.helperStatus().issue,/不存在/);
    c.ConnectionManagerRequestService={getSupportedProfiles:()=>[{id:'gone',name:'Recovered',model:'x'}]};assert.equal(host.helperStatus().ready,true);assert.match(host.helperStatus().label,/Recovered/);
    host.configureApiMode('main');c.mainApi='textgenerationwebui';assert.equal(host.helperStatus().ready,false);
});

test('generation adapter uses live host state, native preparation state, and returns unknown for unsupported hosts',async()=>{
    const {host,c}=fixture(),documentBefore=globalThis.document;
    try{
        c.isGenerating=()=>true;assert.equal(await host.generationActive(),true);delete c.isGenerating;
        host.generationModule=Promise.resolve({isGenerating:()=>false});globalThis.document={body:{dataset:{generating:'true'}}};assert.equal(await host.generationActive(),true);
        delete document.body.dataset.generating;assert.equal(await host.generationActive(),false);
        host.generationModule=Promise.resolve({});assert.equal(await host.generationActive(),null);
    }finally{if(documentBefore===undefined)delete globalThis.document;else globalThis.document=documentBefore;}
});
test('advanced output sampling and prompt reach main, direct and profile requests without changing main settings',async()=>{
    const {host,c}=fixture(),calls=[],old=globalThis.fetch,before=JSON.stringify(c.chatCompletionSettings);globalThis.fetch=async(_url,options)=>{calls.push(JSON.parse(options.body));return Response.json({content:'{"summary":"測試"}'});};
    try{
        host.configureMemory({detail:'detailed',focus:'relationships'});host.configureAdvanced('summary',{maxTokens:640,temperature:.35,topP:.8,prompt:'記錄角色承諾。',contextTokens:8192});
        await host.complete('ignored','story');host.configureDirect('summary',{provider:'custom',baseUrl:'https://fixture.invalid/v1',model:'direct-model'});await host.complete('ignored','story');
        let profile;c.ConnectionManagerRequestService={getSupportedProfiles:()=>[{id:'p',name:'P',model:'profile-model'}],sendRequest:async(...args)=>{profile=args;return {content:'{"summary":"測試"}'};}};
        host.configureHelper('summary','p','profile-model');await host.complete('ignored','story');
        for(const call of calls){assert.equal(call.max_tokens,640);assert.equal(call.temperature,.35);assert.equal(call.top_p,.8);assert.match(call.messages[0].content,/記錄角色承諾/);assert.match(call.messages[0].content,/summaryLength/);}
        assert.equal(profile[2],640);assert.equal(profile[4].temperature,.35);assert.equal(profile[4].top_p,.8);assert.match(profile[1][0].content,/記錄角色承諾/);
        assert.equal(JSON.stringify(c.chatCompletionSettings),before);assert.equal(host.advanced('selection').maxTokens,1200);
        await assert.rejects(host.complete('','中'.repeat(10000)),/上下文上限/);assert.equal(calls.length,2);
    }finally{globalThis.fetch=old;}
});
test('invalid advanced settings cannot replace saved values; reset restores default prompt and summary chunking preserves every character',()=>{
    const {host}=fixture();host.configureAdvanced('summary',{contextTokens:4096,maxTokens:600});const saved=host.advanced('summary');
    assert.throws(()=>host.configureAdvanced('summary',{contextTokens:1000,maxTokens:800}),/上下文/);assert.deepEqual(host.advanced('summary'),saved);
    assert.throws(()=>generationOptions({temperature:3}));assert.throws(()=>memoryOptions({recallPages:9}));assert.throws(()=>memoryOptions({recallNote:'maybe'}));assert.equal(memoryOptions({}).recallPages,0);assert.equal(memoryOptions({recallNote:'false'}).recallNote,false);
    const text='連續正文內容。'.repeat(1700),size=host.summaryChunkSize();assert.ok(size<3600);assert.equal(splitBody(text,size).join(''),text);
    host.configureAdvanced('summary',{});assert.equal(host.advanced('summary').prompt,'');assert.match(rolePrompt('summary',{},{}),/書頁整理員/);
});
test('default page record asks for a blurb, an ordered retelling and verbatim search terms',()=>{
    const memory=memoryOptions({}),prompt=rolePrompt('summary',{},memory);
    assert.equal(memory.detail,'standard');assert.equal(memory.termDepth,2);
    assert.equal(generationOptions({},'summary').maxTokens,2000);assert.equal(generationOptions({},'selection').maxTokens,1200);
    for(const pattern of [/blurb/,/簡介/,/小總結/,/按事件發生順序/,/terms/,/逐字取自 text/,/summaryLength/,/speaker 僅是/,/玩家角色（你）/,/主體不明/,/contextBefore/,/不用/])assert.match(prompt,pattern);
    assert.doesNotMatch(prompt,/evidence|sections/);
});
test('recent page setting preserves paired input and still observes available budget',()=>{
    const chat=Array.from({length:10},(_,i)=>({is_user:i%2===0,mes:'正文'+i,name:'test'})),costs=chat.map(()=>10);
    assert.deepEqual([...recentPages(chat,costs,1000,2).picked].sort((a,b)=>a-b),[6,7,8,9]);
    assert.deepEqual([...recentPages(chat,costs,25,5).picked].sort((a,b)=>a-b),[8,9]);
});
