import test from 'node:test';
import assert from 'node:assert/strict';
import {Host} from '../src/host.js';

const config=model=>({connection:'direct',provider:'custom',baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic-key',model});
function fixture(t){
    const c={extensionSettings:{folio:{account:'save-test',apiMode:'separate',helpers:{summary:config('old-summary'),selection:config('old-selection')}}},getRequestHeaders:()=>({}),saveSettingsDebounced(){throw Error('Explicit API save must not use debounce');}};
    let disk=structuredClone(c.extensionSettings),writes=0;const calls=[];
    c.saveSettings=async()=>{writes++;disk=structuredClone(c.extensionSettings);};
    const original=globalThis.fetch;globalThis.fetch=async(url,options)=>{
        calls.push(url);
        if(url==='/api/settings/get')return Response.json({settings:JSON.stringify({extension_settings:disk})});
        assert.equal(url,'/api/backends/chat-completions/generate','Fetching models must not initialize the connection');
        const payload=JSON.parse(options.body);calls.push(payload);
        return Response.json({choices:[{message:{content:'{"summary":"synthetic"}'}}]});
    };
    t.after(()=>{globalThis.fetch=original;});
    return {c,host:new Host(()=>c),calls,disk:()=>disk,writes:()=>writes};
}
test('explicit API save reads back durable settings; new Host generates without fetching models',async t=>{
    const f=fixture(t);
    await f.host.saveHelper('summary','custom',config('typed-summary'));
    await f.host.saveHelper('selection','custom',config('typed-selection'));
    assert.equal(f.writes(),2);
    f.c.extensionSettings=structuredClone(f.disk());const reopened=new Host(()=>f.c);
    await reopened.complete('','synthetic');await reopened.complete('','synthetic',{selection:true});
    assert.deepEqual(f.calls.filter(x=>typeof x==='object').map(x=>x.model),['typed-summary','typed-selection']);
    assert.ok(f.calls.filter(x=>typeof x==='object').every(x=>JSON.parse(x.custom_include_headers).Authorization==='Bearer synthetic-key'));
});
test('resolved native save without disk write is detected; old config stays usable and retry needs no list',async t=>{
    const f=fixture(t),save=f.c.saveSettings;f.c.saveSettings=async()=>{};
    await assert.rejects(f.host.saveHelper('summary','custom',config('unsaved')),/未確認保存/);
    assert.equal(f.host.helper().model,'old-summary');assert.equal(f.host.apiSaveTask,null);
    await f.host.complete('','synthetic');assert.equal(f.calls.at(-1).model,'old-summary');
    f.c.saveSettings=save;await f.host.saveHelper('summary','custom',config('unsaved'));
    await f.host.complete('','synthetic');assert.equal(f.calls.at(-1).model,'unsaved');
});
test('write exceptions cannot expose echoed secrets or destroy settings',async t=>{
    const f=fixture(t);f.c.saveSettings=async()=>{throw Error('synthetic-key');};
    await assert.rejects(f.host.saveHelper('summary','custom',config('new')),e=>e.message.includes('未確認保存')&&!e.message.includes('synthetic-key'));
    assert.equal(f.host.helper().model,'old-summary');
});
test('API mode needs readback too and failure restores previous mode',async t=>{
    const f=fixture(t);await f.host.saveApiMode('main');assert.equal(f.disk().folio.apiMode,'main');
    f.c.saveSettings=async()=>{};await assert.rejects(f.host.saveApiMode('separate'),/未確認保存/);
    assert.equal(f.host.settings().apiMode,'main');
});
test('generation waits for save acknowledgement, concurrent save is rejected',async t=>{
    const f=fixture(t),save=f.c.saveSettings;let release;f.c.saveSettings=async()=>{await new Promise(r=>release=r);await save();};
    const saving=f.host.saveHelper('summary','custom',config('new')),generation=f.host.complete('','synthetic');
    await Promise.resolve();await assert.rejects(f.host.saveApiMode('main'),/正在保存/);
    assert.equal(f.calls.length,0);release();await saving;await generation;
    assert.equal(f.calls.at(-1).model,'new');
});
test('waiting for API save is abortable without cancelling the save',async t=>{
    const f=fixture(t),save=f.c.saveSettings;let release;f.c.saveSettings=async()=>{await new Promise(r=>release=r);await save();};
    const saving=f.host.saveHelper('summary','custom',config('new')),controller=new AbortController();
    const generation=f.host.complete('','synthetic',{signal:controller.signal});await Promise.resolve();controller.abort();
    await assert.rejects(generation,{name:'AbortError'});assert.equal(f.calls.length,0);
    release();await saving;assert.equal(f.disk().folio.helpers.summary.model,'new');
});
test('saving dormant independent config never activates it',async t=>{
    const f=fixture(t);await f.host.saveApiMode('main');await f.host.saveHelper('selection','custom',config('new'));
    assert.equal(f.disk().folio.apiMode,'main');assert.equal(f.disk().folio.helpers.selection.model,'new');
});
test('readback errors reject false success and keep the previous in-window settings',async t=>{
    const f=fixture(t);globalThis.fetch=async()=>new Response('{}',{status:503});
    await assert.rejects(f.host.saveHelper('summary','custom',config('new')),/未確認保存/);
    assert.equal(f.host.helper().model,'old-summary');
});
