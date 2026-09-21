import test from 'node:test';
import assert from 'node:assert/strict';
import {Host,helperPayload,completionText} from '../src/host.js';

test('journal backup is staged synchronously without racing the native chat save',()=>{
    let saves=0;const c={chat:[],chatMetadata:{other:'keep'},saveChat:async()=>{saves++;}};
    const h=new Host(()=>c);let identity='a';h.identity=()=>identity;
    const record={id:'receipt',stage:'observed',receiptVersion:2,result:{messageId:'reply'},final:{observedAt:1},items:[]};
    assert.equal(h.stageUsage('a',[record]),true);assert.equal(c.chatMetadata.other,'keep');assert.equal(h.readUsage()[0].id,'receipt');
    record.items.push({body:'later mutation'});assert.equal(h.readUsage()[0].items.length,0);
    assert.equal(saves,0,'Folio must leave the actual save to the host lifecycle');
    identity='b';assert.equal(h.stageUsage('a',[record]),false);assert.equal(saves,0);
    identity='a';assert.equal(h.stageUsage('a',h.readUsage()),false,'Identical journal must not rewrite metadata on every refresh');
});

test('known DeepSeek Flash/Pro helper disables thinking through custom backend passthrough',()=>{
    for(const model of ['deepseek-flash','deepseek-pro','deepseek-v4-flash','deepseek/deepseek-v4-pro'])assert.deepEqual(JSON.parse(helperPayload(model).custom_include_body),{thinking:{type:'disabled'}});
    assert.equal(helperPayload('other-mini').custom_include_body,undefined);
});
test('empty thinking-only length response is an error, not a successful summary',()=>{
    assert.throws(()=>completionText({choices:[{message:{content:'',reasoning_content:'private reasoning'},finish_reason:'length'}]}),/輸出被截斷/);
    assert.equal(completionText({choices:[{message:{content:'{"summary":"正文"}'}}]}),'{"summary":"正文"}');
});
test('connection-manager helper uses separate raw response, no preset, no global mutations',async()=>{
    let sent;const settings={folio:{enabled:true,account:'fixture',helperConnection:'auto'}},globalModel={model:'main-model'};
    const c={mainApi:'openai',extensionSettings:settings,chatCompletionSettings:globalModel,saveSettingsDebounced(){},
        ConnectionManagerRequestService:{getSupportedProfiles:()=>[{id:'fixture',name:'Flash',model:'deepseek-flash'}],sendRequest:async(...args)=>{sent=args;return {choices:[{message:{content:'{"summary":"測試"}'}}]};}}};
    const host=new Host(()=>c);const raw=await host.complete('system','synthetic prompt');
    assert.ok(raw.includes('測試'));assert.equal(sent[3].extractData,false);assert.equal(sent[3].includePreset,false);
    assert.equal(sent[4].type,'quiet');assert.equal(JSON.parse(sent[4].custom_include_body).thinking.type,'disabled');assert.deepEqual(globalModel,{model:'main-model'});
});

test('summary and extraction use independent models and connections, migration happens once',async()=>{
    const calls=[],c={mainApi:'openai',extensionSettings:{folio:{enabled:true,account:'test',helperConnection:'legacy',helperModel:'old-mini'}},chatCompletionSettings:{custom_model:'main'},saveSettingsDebounced(){},
        ConnectionManagerRequestService:{getSupportedProfiles:()=>[{id:'legacy',name:'Legacy',model:'old-mini'},{id:'extract',name:'Extract',model:'extract-mini'}],sendRequest:async(...args)=>{calls.push(args);return {content:'{"summary":"x"}'};}}};
    const host=new Host(()=>c);assert.notEqual(host.settings().helpers.summary,host.settings().helpers.selection);
    host.configureHelper('summary','legacy','summary-only');host.configureHelper('selection','extract','extract-only');
    await host.complete('s','summary');await host.complete('s','selection',{selection:true});
    assert.deepEqual(calls.map(c=>[c[0],c[4].model]),[['legacy','summary-only'],['extract','extract-only']]);assert.deepEqual(host.models,{summary:'summary-only',selection:'extract-only'});
    assert.equal(new Host(()=>c).helper('summary').model,'summary-only');assert.equal(new Host(()=>c).helper('selection').model,'extract-only');
});
test('empty or missing explicit model config never makes a paid fallback call',async()=>{
    let called=0;const c={mainApi:'openai',extensionSettings:{folio:{account:'test',helpers:{summary:{connection:'current',model:''},selection:{connection:'gone',model:'chosen'}}}},saveSettingsDebounced(){},ConnectionManagerRequestService:{getSupportedProfiles:()=>[],sendRequest:async()=>{called++;}}};
    const h=new Host(()=>c);await assert.rejects(h.complete('s','p'),/填寫總結模型/);await assert.rejects(h.complete('s','p',{selection:true}),/提取模型的連線已不存在/);assert.equal(called,0);
});
test('current-connection explicit model failure never calls the main model instead',async()=>{
    const c={mainApi:'openai',extensionSettings:{folio:{account:'test',helpers:{summary:{connection:'current',model:'configured-summary'},selection:{connection:'current',model:'configured-extract'}}}},chatCompletionSettings:{custom_model:'main'},getRequestHeaders:()=>({}),saveSettingsDebounced(){}};
    const h=new Host(()=>c);h.api=async()=>({getChatCompletionModel:s=>s.custom_model,createGenerationParameters:async(s,model,type,messages)=>({generate_data:{model,type,messages}})});
    const old=globalThis.fetch,calls=[];globalThis.fetch=async(url,req)=>{calls.push(JSON.parse(req.body).model);return new Response('{}',{status:400});};
    try{await assert.rejects(h.complete('s','p'),/總結模型連線回應 400/);assert.deepEqual(calls,['configured-summary']);}finally{globalThis.fetch=old;}
});
