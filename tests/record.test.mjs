import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePageRecord, summaryLength, termHits, digestLine, isLegacyRecord, RECORD_FORMAT, rankCandidates} from '../src/core.js';

test('page record keeps only terms copied from the page text and falls back sensibly',()=>{
    const text='默戮在空座町把半崩玉交給浦原喜助，約定三天後在浦原商店再見。';
    const record=parsePageRecord(JSON.stringify({title:'崩玉交付',blurb:'默戮把半崩玉交給浦原。',summary:'默戮在空座町把半崩玉交給浦原喜助。\n兩人約定三天後在浦原商店再見。',
        terms:['默戮','半崩玉','浦原喜助','浦原商店','藍染','交給','x']}),text);
    assert.deepEqual(record.terms,['默戮','半崩玉','浦原喜助','浦原商店','交給'],'invented 藍染 and one-character terms are dropped');
    assert.equal(record.droppedTerms,2);assert.equal(record.blurb,'默戮把半崩玉交給浦原。');assert.match(record.summary,/約定三天後/);
    const bare=parsePageRecord('{"summary":"默戮交出半崩玉。之後離開。"}',text);
    assert.equal(bare.blurb,'默戮交出半崩玉。');assert.deepEqual(bare.terms,[]);assert.equal(bare.title,'默戮交出半崩玉');
    const legacy=parsePageRecord(JSON.stringify({title:'舊',sections:{events:[{entry:'默戮：交出半崩玉'}]}}),text);assert.match(legacy.summary,/事件與結果：默戮：交出半崩玉/);
    assert.throws(()=>parsePageRecord('{"title":"空"}',text),/空白小總結/);
});

test('retelling length follows the page length within per-detail bounds',()=>{
    assert.equal(summaryLength(6000,'standard'),600);assert.equal(summaryLength(300,'standard'),120);assert.equal(summaryLength(20000,'standard'),700);
    assert.equal(summaryLength(6000,'brief'),360);assert.equal(summaryLength(6000,'detailed'),900);assert.equal(summaryLength(6000,'unknown'),600);
});

test('term recall weighs the new input and rare terms, and recursion reaches pages through a hit',()=>{
    const pages=[
        {id:'a',terms:['真咲','婚約'],blurb:'默戮與真咲訂下婚約。',summary:'默戮與真咲在空座町訂下婚約，交換了戒指。'},
        {id:'b',terms:['戒指','黑崎一心'],blurb:'黑崎一心得知戒指的來歷。',summary:'黑崎一心看見戒指。'},
        {id:'c',terms:['虛圈','藍染'],blurb:'藍染召見默戮。',summary:'藍染在虛圈召見。'},
        {id:'d',terms:['默戮'],blurb:'',summary:''},{id:'e',terms:['默戮'],blurb:'',summary:''},
    ];
    const found=termHits(pages,[{text:'我想起和真咲的婚約',weight:3},{text:'默戮走進房間',weight:1}],{depth:2});
    assert.equal(found.get('a').step,0);assert.deepEqual(found.get('a').hits,['真咲','婚約']);
    assert.equal(found.get('b').step,1,'戒指 appears only in page a\'s retelling');assert.deepEqual(found.get('b').hits,['戒指']);
    assert.equal(found.has('c'),false);assert.ok(found.get('a').score>found.get('d').score,'rare terms from the new input outweigh a name every page shares');
    assert.equal(termHits(pages,[{text:'我想起和真咲的婚約',weight:3}],{depth:0}).has('b'),false,'depth 0 disables recursion');
    const ranked=rankCandidates(pages.map((p,i)=>({...p,index:i,summary:'',termScore:p.id==='b'?5:0})),'',null,5);assert.equal(ranked[0].id,'b');
});

test('digest lines step down from retelling to blurb to title, and legacy excludes manual edits',()=>{
    const page={number:3,title:'崩玉',summary:'默戮交出半崩玉。\n浦原收下。',blurb:'默戮交出崩玉。'};
    assert.equal(digestLine(page),'第 3 頁〈崩玉〉：默戮交出半崩玉。；浦原收下。');assert.equal(digestLine(page,'blurb'),'第 3 頁〈崩玉〉：默戮交出崩玉。');assert.equal(digestLine(page,'title'),'第 3 頁〈崩玉〉');
    assert.equal(isLegacyRecord({done:true}),true);assert.equal(isLegacyRecord({done:true,format:RECORD_FORMAT}),false);assert.equal(isLegacyRecord({done:true,edited:true}),false);assert.equal(isLegacyRecord({done:false}),false);
});
