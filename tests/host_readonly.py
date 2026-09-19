"""Load via ST's actual extension discovery and interceptor pipeline in an isolated browser.

FOLIO_ST_URL points at an already-running instance. All application writes and real
model calls are intercepted. Only a synthetic memory fixture is generated/saved locally.
"""
import json
import mimetypes
import os
import pathlib
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT=pathlib.Path(__file__).resolve().parents[1]
ORIGIN=os.environ.get('FOLIO_ST_URL','http://127.0.0.1:8000').rstrip('/')
NAME='third-party/sillytavern-folio'
PREFIX='/scripts/extensions/'+NAME+'/'
reads={'/api/settings/get','/api/characters/all','/api/characters/get','/api/characters/chats','/api/chats/get','/api/worldinfo/get','/api/presets/get','/api/avatars/get','/api/groups/all','/api/sd/comfy/workflows','/api/secrets/read','/api/backgrounds/all'}
blocked=[]
model_calls=[]
def route_request(route):
    req=route.request
    parsed=urlparse(req.url)
    if parsed.netloc!=urlparse(ORIGIN).netloc:
        route.abort();return
    path=parsed.path
    if path=='/api/extensions/discover':
        response=route.fetch()
        existing=[x for x in response.json() if not x['name'].startswith('third-party/')]
        existing.append({'name':NAME,'type':'local'})
        route.fulfill(response=response,body=json.dumps(existing));return
    if path.startswith(PREFIX):
        file=(ROOT/path[len(PREFIX):]).resolve()
        if file.is_relative_to(ROOT) and file.is_file():
            mime={'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.onnx':'application/octet-stream'}.get(file.suffix,mimetypes.guess_type(str(file))[0] or 'text/plain')
            route.fulfill(status=200,body=file.read_bytes(),content_type=mime);return
        route.fulfill(status=404,body='not found');return
    if path=='/api/settings/get':
        response=route.fetch();data=response.json();settings=json.loads(data['settings'])
        ext=settings.setdefault('extension_settings',{})
        ext['folio']={'enabled':False,'account':'synthetic-readonly-host'}
        ext['disabledExtensions']=[x for x in ext.get('disabledExtensions',[]) if x!=NAME]
        data['settings']=json.dumps(settings)
        route.fulfill(response=response,body=json.dumps(data));return
    if req.method in ('POST','PUT','PATCH','DELETE') and path not in reads and not path.startswith('/api/tokenizers/'):
        blocked.append(path)
        if path=='/api/backends/chat-completions/generate':
            data=req.post_data_json
            assert data.get('custom_url')=='https://folio-fixture.invalid/v1','Unexpected real model request was blocked'
            assert data['model']=='folio-fixture-mini'
            model_calls.append({'model':data['model'],'stream':data['stream']})
            prompt=json.loads(data['messages'][-1]['content'])
            answer={'ids':['p1']} if 'catalogue' in prompt else {'summary':'船長交付藍色信件，約定冬天以前送到山城。'}
            route.fulfill(status=200,content_type='application/json',body=json.dumps({'choices':[{'message':{'content':json.dumps(answer,ensure_ascii=False)}}]}));return
        route.fulfill(status=200,body='{}',content_type='application/json');return
    route.continue_()

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    try:
        context=browser.new_context(viewport={'width':1440,'height':1050})
        context.route('**/*',route_request)
        page=context.new_page()
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(ORIGIN,wait_until='domcontentloaded',timeout=60000)
        page.wait_for_selector('#folio-panel',state='attached',timeout=60000)
        result=page.evaluate("""async(prefix)=>{
          const real=SillyTavern.getContext();
          const {Host}=await import(prefix+'src/host.js');
          const {Engine}=await import(prefix+'src/engine.js');
          const {Cache}=await import(prefix+'src/store.js');
          const {Embedder}=await import(prefix+'src/embedding.js');
          const {KEY,newRecord}=await import(prefix+'src/core.js');
          const {runGenerationInterceptors}=await import('/scripts/extensions.js');
          const chat=Array.from({length:12},(_,i)=>({mes:(i===1?'船長交付藍色信件，約定冬天以前送到山城。':'今日在旅店吃飯。')+'一般情節。'.repeat(50),name:i%2?'船長':'玩家',is_user:i%2===0,send_date:'synthetic-host-'+i,extra:{}}));
          chat.at(-1).mes='我還欠船長什麼約定？';chat.at(-1).is_user=true;
          let saves=0;
          const fixture={...real,chat,chatId:'folio-synthetic-only',mainApi:'openai',
            extensionSettings:{folio:{enabled:true,account:'synthetic-readonly-host'}},
            chatCompletionSettings:{...structuredClone(real.chatCompletionSettings),chat_completion_source:'custom',custom_model:'folio-fixture-mini',custom_url:'https://folio-fixture.invalid/v1',reverse_proxy:'',proxy_password:'',custom_include_headers:'',custom_include_body:'',custom_exclude_body:''},
            saveChat:async()=>{saves++;},saveSettingsDebounced:()=>{},getTokenCountAsync:async text=>Math.ceil(text.length*1.5)};
          const host=new Host(()=>fixture), cache=new Cache('folio-host-fixture'),embedder=new Embedder(cache);
          const engine=new Engine(host,cache,embedder);engine.schedule=()=>{};
          const previous=window.folioIntercept;
          try {
            const before=JSON.stringify(real.chatCompletionSettings);
            await engine.tick();
            if(!chat[0].extra[KEY]?.done)throw Error('Actual ST request adapter did not save synthetic summary: '+engine.warning);
            for(const m of chat){const r=newRecord(m);r.summary=m.mes;r.done=true;m.extra[KEY]=r;}
            const actualVectors=await embedder.embed(['船長的信件與約定']);
            for(const m of chat)engine.vectors.set(engine.vectorKey(m.extra[KEY]),actualVectors);
            const source=JSON.stringify(chat), core=structuredClone(chat);
            window.folioIntercept=(...args)=>engine.intercept(...args);
            const aborted=await runGenerationInterceptors(core,2400,'normal');
            return {panel:!!document.querySelector('#folio-panel'),globalInterceptor:typeof previous==='function',
              summarySaved:saves===1,originalUntouched:JSON.stringify(chat)===source,
              settingsUntouched:before===JSON.stringify(real.chatCompletionSettings),aborted,
              historyReduced:core.length<chat.length,selectedOriginal:core.some(m=>m.mes===chat[1].mes),
              latestPreserved:core.at(-1).mes===chat.at(-1).mes,vectorDim:actualVectors[0].length};
          }finally{window.folioIntercept=previous;engine.dispose();}
        }""",PREFIX)
        assert result['panel'] and result['globalInterceptor'],result
        assert result['summarySaved'] and result['originalUntouched'] and result['settingsUntouched'],result
        assert not result['aborted'] and result['historyReduced'] and result['selectedOriginal'] and result['latestPreserved'],result
        assert result['vectorDim']==512,result
        assert len(model_calls)==2,model_calls
        assert not [e for e in errors if 'folio' in e.lower()],errors
        print(json.dumps({'passed':True,'host_integration':result,'mock_model_calls':len(model_calls),'blocked_write_endpoints':sorted(set(blocked)),'unrelated_host_page_errors':len(errors)}),flush=True)
    finally:
        browser.close()
