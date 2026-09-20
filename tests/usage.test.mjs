import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeUsage,usageView,USAGE_LIMIT,usageOverview,playerOwner} from '../src/usage.js';

test('body overview never counts player-only matches as a successful recall',()=>{
    const record={items:[{role:'user',index:0,final:true},{role:'assistant',index:1,final:false},{role:'assistant',index:3,final:true,recent:true}],candidates:[{index:1,selected:true}],skipped:[]};
    assert.deepEqual(usageOverview(record),{bodies:1,recalled:0,recent:1,retained:0,unverified:1,players:1,selected:1,skipped:0});
    record.items[1].final=true;assert.equal(usageOverview(record).recalled,1);
    record.mode='building';record.candidates=[];assert.equal(usageOverview(record).recalled,0);assert.equal(usageOverview(record).retained,1);
});

test('background grouping follows the request receipt, including missing bodies and old receipts',()=>{
    const record={items:[{role:'user',index:0},{role:'assistant',index:1,final:false},{role:'assistant',index:3,final:true},{role:'user',index:4}]};
    assert.equal(playerOwner(record,record.items[0]),1);assert.equal(playerOwner(record,record.items[3]),undefined);
    assert.equal(playerOwner(record,{role:'user',index:2,pageIndex:10}),10);
});
const record=(id,time=1)=>({id,stage:'observed',final:{observedAt:time},items:[],stamps:[]});
test('journal filters unobserved/preview records and retains newest unique bounded receipts',()=>{
    const records=Array.from({length:25},(_,i)=>record(String(i),i));
    const merged=mergeUsage(records,[record('24',30),{...record('preview',40),preview:true},{...record('pending',41),stage:'awaiting-final'},null]);
    assert.equal(merged.length,USAGE_LIMIT);assert.equal(merged[0].id,'24');assert.equal(merged[0].final.observedAt,30);
});
test('source mapping distinguishes moved, missing, identical collisions and legacy unknown without mutating receipts',()=>{
    const original={...record('a'),stamps:['old','kept','same'],items:[{index:0,body:'old'},{index:1,body:'kept'},{index:2,body:'same'},{index:8,body:'unknown'}]};
    const before=JSON.stringify(original),view=usageView([original],['kept','same','same'])[0];
    assert.equal(view.sourceChanged,true);assert.deepEqual(view.items.map(x=>x.sourceState),['missing','present','ambiguous','unknown']);
    assert.deepEqual(view.items.map(x=>x.currentIndex),[null,0,null,null]);assert.equal(JSON.stringify(original),before);
});
test('only a uniquely present generated response is active; legacy receipts infer the following assistant floor',()=>{
    const exact={...record('exact',3),stamps:['question'],result:{sourceStamp:'reply'},items:[]};
    const deleted={...record('deleted',2),stamps:['question'],result:{sourceStamp:'gone'},items:[]};
    const legacy={...record('legacy',1),stamps:['question'],items:[]};
    const view=usageView([exact,deleted,legacy],['question','reply'],['user','assistant']);
    assert.deepEqual(view.map(x=>x.resultState),['present','missing','present']);assert.deepEqual(view.map(x=>x.resultIndex),[1,null,1]);
});
