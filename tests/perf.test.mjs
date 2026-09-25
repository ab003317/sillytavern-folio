import test from 'node:test';
import assert from 'node:assert/strict';
import {deferPromptDryRuns} from '../src/perf.js';

function fixture(){
    const el={rects:0,getClientRects(){return {length:this.rects};}};
    const document={getElementById:id=>id==='completion_prompt_manager'?el:null};
    let observed=null;class Observer{constructor(cb){this.cb=cb;observed=this;}observe(){}disconnect(){}}
    let dry=0,renders=0;const pm={configuration:{containerIdentifier:'completion_prompt_manager'},tryGenerate(){dry++;return Promise.resolve('built');},render(after){renders++;if(after)this.tryGenerate();}};
    return {el,document,Observer,pm,counts:()=>({dry,renders}),fire:v=>observed.cb([{isIntersecting:v}])};
}

test('hidden prompt manager skips dry runs and refreshes once when opened',async()=>{
    const f=fixture();let on=true;const d=deferPromptDryRuns(f.pm,()=>on,{document:f.document,Observer:f.Observer});
    await f.pm.tryGenerate();await f.pm.tryGenerate();
    assert.deepEqual(f.counts(),{dry:0,renders:0});assert.equal(d.state.skipped,2);assert.equal(d.state.pending,true);
    f.el.rects=1;f.fire(true);assert.deepEqual(f.counts(),{dry:1,renders:1},'one deferred refresh on open');
    f.fire(true);assert.equal(f.counts().renders,1,'nothing pending, no extra work');
    assert.equal(await f.pm.tryGenerate(),'built','visible panel runs normally');
    f.el.rects=0;on=false;await f.pm.tryGenerate();assert.equal(f.counts().dry,3,'switch off restores host behaviour');
});

test('deferral is idempotent and dispose only removes its own wrapper',()=>{
    const f=fixture(),original=f.pm.tryGenerate;
    const a=deferPromptDryRuns(f.pm,()=>true,{document:f.document,Observer:f.Observer}),b=deferPromptDryRuns(f.pm,()=>true,{document:f.document,Observer:f.Observer});
    assert.equal(a,b);a.dispose();assert.equal(f.pm.tryGenerate,original);
    const again=deferPromptDryRuns(f.pm,()=>true,{document:f.document,Observer:f.Observer}),other=()=>Promise.resolve();f.pm.tryGenerate=other;again.dispose();assert.equal(f.pm.tryGenerate,other);
    assert.equal(deferPromptDryRuns(null,()=>true),null);
});

test('infinite animations in message iframes are calmed on load and restored when switched off',async()=>{
    const {calmFrameAnimations,CALM_CSS}=await import('../src/perf.js');
    const styles=new Map();const frameDoc={head:{append:s=>styles.set(s.id,s)},getElementById:id=>styles.has(id)?{remove:()=>styles.delete(id)}:null,createElement:()=>({})};
    const frame={tagName:'IFRAME',contentDocument:frameDoc,closest:()=>({})};let listener=null,on=true;
    const document={querySelectorAll:()=>[frame],addEventListener:(t,fn)=>{listener=fn;},removeEventListener:()=>{listener=null;}};
    const calm=calmFrameAnimations(()=>on,{document});assert.equal(styles.get('folio-calm').textContent,CALM_CSS);
    styles.clear();listener({target:frame});assert.ok(styles.has('folio-calm'),'newly loaded frame is calmed');
    on=false;calm.scan();assert.equal(styles.size,0);calm.dispose();assert.equal(listener,null);
});
