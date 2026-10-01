import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {watchForUpdate, FILES} from '../src/update.js';

function server(version){
    const calls=[];return {calls,set:v=>{version=v;},fetch:async(url,options)=>{calls.push([url,options?.cache]);return {json:async()=>({version})};}};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('a new deployed version reloads only once the page is idle, after refreshing every module',async()=>{
    const s=server('0.10.0'),notes=[];let busy=true,reloads=0;
    const watcher=watchForUpdate({base:'/ext/',fetch:s.fetch,isBusy:()=>busy,notify:v=>notes.push(v),reload:()=>reloads++,document:null,interval:1e9,retry:5});
    await watcher.ready;await watcher.check();assert.equal(reloads,0,'same version does nothing');
    s.set('0.10.1');await watcher.check();assert.deepEqual(notes,['0.10.1']);assert.equal(reloads,0,'busy page is not reloaded');
    await watcher.check();assert.deepEqual(notes,['0.10.1'],'notified once');
    busy=false;for(let i=0;i<20&&!reloads;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(reloads,1);const refreshed=s.calls.filter(([,cache])=>cache==='reload').map(([url])=>url);
    assert.deepEqual(refreshed.sort(),FILES.map(f=>'/ext/'+f).sort());assert.ok(s.calls.filter(([,c])=>c==='no-store').length>=3);
    watcher.dispose();
});

test('an unreachable server or a disposed watcher never reloads',async()=>{
    let reloads=0;const watcher=watchForUpdate({base:'/ext/',fetch:async()=>{throw new TypeError('offline');},isBusy:()=>false,reload:()=>reloads++,document:null,interval:1e9});
    await watcher.ready;await watcher.check();assert.equal(reloads,0);watcher.dispose();
    const s=server('1'),late=watchForUpdate({base:'/ext/',fetch:s.fetch,isBusy:()=>false,reload:()=>reloads++,document:null,interval:1e9});
    await late.ready;late.dispose();s.set('2');await late.check();await tick();assert.equal(reloads,0);
});

test('the refresh list covers every shipped module',async()=>{
    const src=(await readdir(new URL('../src/',import.meta.url))).filter(f=>f.endsWith('.js')).map(f=>'src/'+f);
    for(const file of [...src,'index.js','style.css','manifest.json'])assert.ok(FILES.includes(file),`${file} missing from FILES`);
});
