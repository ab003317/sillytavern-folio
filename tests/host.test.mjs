import test from 'node:test';
import assert from 'node:assert/strict';
import {Host,helperPayload,completionText} from '../src/host.js';

test('known DeepSeek Flash/Pro helper disables thinking through custom backend passthrough',()=>{
    for(const model of ['deepseek-flash','deepseek-pro','deepseek-v4-flash','deepseek/deepseek-v4-pro'])assert.deepEqual(JSON.parse(helperPayload(model).custom_include_body),{thinking:{type:'disabled'}});
    assert.equal(helperPayload('other-mini').custom_include_body,undefined);
});
test('empty thinking-only length response is an error, not a successful summary',()=>{
    assert.throws(()=>completionText({choices:[{message:{content:'',reasoning_content:'private reasoning'},finish_reason:'length'}]}),/用盡输出額度|用盡輸出額度/);
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
