import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {KEY, cleanBody, splitBody, sourceOf, newRecord, validRecord, parseSummary, parseSelection, rankCandidates,
    cosine, estimatedTokens, budgetFor, recentIndices, chooseModel, summaryChunks} from '../src/core.js';
import {WordPiece} from '../src/tokenizer.js';
import {sha256} from '../src/hash.js';
import {createHash} from 'node:crypto';

test('HTTP-compatible SHA-256 agrees with Node for Unicode, padding and long bodies',()=>{
    for(const text of ['', 'abc', '故事😀', 'a'.repeat(55),'b'.repeat(56),'長'.repeat(10000)])
        assert.equal(sha256(text),createHash('sha256').update(text).digest('hex'));
});

test('clean story without reasoning, summaries, script or changing dialogue',()=>{
    assert.equal(cleanBody('<think>private</think><p>「我們明日見。」</p><small_summary>meta</small_summary><script>alert(1)</script><scene>潮水漲了。</scene>'), '「我們明日見。」\n潮水漲了。');
    assert.equal(cleanBody('故事。<think>unfinished'), '故事。');
    assert.equal(cleanBody('3 < 5；<unknown>正文</unknown> &amp; 海。'), '3 < 5；正文 & 海。');
    assert.equal(cleanBody('<UpdateVariable>{"a":1}</UpdateVariable>正文\r\n下一行'), '正文\n下一行');
});
test('all long body text is covered exactly once',()=>{
    const text='故事很長。\n'.repeat(1800)+'終點😀';
    const parts=splitBody(text);assert.equal(parts.join(''),text);assert.ok(parts.every(p=>p.length<=3600));
    assert.equal(splitBody('').length,0);
    assert.equal(summaryChunks('a'.repeat(600)).join(''),'a'.repeat(600));
});
test('content revisions and swipes invalidate stale summaries; no floor-only cursor',()=>{
    const m={mes:'正文',name:'角色',is_user:false};m.extra={[KEY]:newRecord(m)};
    assert.ok(validRecord(m));const hash=sourceOf(m).hash;m.mes='新正文';assert.equal(validRecord(m),null);
    m.mes='正文';assert.equal(sourceOf(m).hash,hash);assert.ok(validRecord(m));m.name='另一角色';assert.equal(validRecord(m),null);
});
test('summary JSON is validated and HTML never needed',()=>{
    assert.equal(parseSummary('```json\n{"summary":"兩人在港口立約。"}\n```'),'兩人在港口立約。');
    assert.throws(()=>parseSummary('{"summary":""}'));
    assert.throws(()=>parseSummary('wrong'));
    assert.throws(()=>parseSelection('{"ids":"p0"}',[]));
    assert.deepEqual(parseSelection('{"ids":["p1","invented","p1"]}',[{id:'p1'}]),['p1']);
    assert.deepEqual(parseSelection('{"ids":[]}',[{id:'p1'}]),[]);
});
test('hybrid search ranks names and semantic paraphrases',()=>{
    const rows=[{id:'sea',index:0,summary:'在港口碼頭等待船長歸來',vectors:[[1,0]]},
        {id:'food',index:1,summary:'晚飯吃牛肉麵',vectors:[[0,1]]},
        {id:'name',index:2,summary:'蕭墨欠下契約債務',vectors:[[.7,.3]]}];
    assert.equal(rankCandidates(rows,'船長在碼頭',[1,0])[0].id,'sea');
    assert.equal(rankCandidates(rows,'蕭墨欠債',null)[0].id,'name');
    assert.equal(cosine([1,0],[1,0]),1);assert.equal(cosine([1],[1,2]),0);
    assert.deepEqual(rankCandidates([], 'word', null),[]);
});
test('budget follows tokens and protects current user/continuation, not fixed floors',()=>{
    assert.ok(estimatedTokens('中'.repeat(10))>estimatedTokens('a'.repeat(10)));
    assert.equal(budgetFor(128000).history,14000);assert.ok(budgetFor(4000).history<2000);
    const chat=[{is_user:false},{is_user:true},{is_user:false},{is_user:true},{is_user:false}];
    const recent=recentIndices(chat,[100,100,100,1000,1000],100);
    assert.deepEqual([...recent.picked].sort(),[3,4]);
});
test('only advertised small models on existing provider; fallback current, no guesses',()=>{
    assert.equal(chooseModel('deepseek-chat',[]),'deepseek-chat');
    assert.equal(chooseModel('vendor/large',[{id:'other/mini'},{id:'vendor/small'},{id:'vendor/embed-mini'}]),'vendor/small');
    assert.equal(chooseModel('large',['small'],new Set(['small'])),'large');
    assert.equal(chooseModel('large',[{id:'small',context_length:2048}]),'large');
});
test('bundled tokenizer: Chinese, WordPiece, caps, truncation and unknown characters',async()=>{
    const vocab=await readFile(new URL('../assets/bge-small-zh-v1.5/vocab.txt',import.meta.url),'utf8');
    const tok=new WordPiece(vocab);
    const a=tok.encode('中国人'),b=tok.encode('中國人');assert.equal(a.length,5);assert.equal(b.length,5);
    assert.deepEqual(tok.encode('Hello WORLD'),tok.encode('hello world'));
    const long=tok.encode('我'.repeat(1000));assert.equal(long.length,512);assert.equal(long.at(-1),tok.vocab.get('[SEP]'));
    assert.equal(tok.encode('x'.repeat(101))[1],tok.vocab.get('[UNK]'));
});
