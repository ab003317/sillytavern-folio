"""Opt-in LAN acceptance: installed files, actual assistant API, synthetic story only.

FOLIO_ST_URL is required. FOLIO_LIVE_API=1 permits at most six short paid helper
requests with our unique fixture marker. All other writes/generations are blocked.
No production chat or settings are saved. The browser always closes on exit.
"""
import json
import os
import pathlib
import time
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ORIGIN=os.environ['FOLIO_ST_URL'].rstrip('/')
assert os.environ.get('FOLIO_LIVE_API')=='1','Explicit live API opt-in required'
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results'
OUT.mkdir(exist_ok=True)
NAME='third-party/sillytavern-folio'
PREFIX='/scripts/extensions/'+NAME+'/'
MARKER='FOLIO-LIVE-TEST'
reads={'/api/settings/get','/api/characters/all','/api/characters/get','/api/characters/chats','/api/chats/get','/api/worldinfo/get','/api/presets/get','/api/avatars/get','/api/groups/all','/api/sd/comfy/workflows','/api/secrets/read','/api/backgrounds/all'}
calls=[]
blocked=[]

def route_request(route):
    req=route.request
    parsed=urlparse(req.url)
    if parsed.netloc!=urlparse(ORIGIN).netloc:
        route.abort();return
    path=parsed.path
    if path=='/api/extensions/discover':
        response=route.fetch()
        # Load the installed Folio through native discovery, alongside host built-ins.
        entries=[x for x in response.json() if not x['name'].startswith('third-party/') or x['name']==NAME]
        assert any(x['name']==NAME for x in entries),'Folio is not installed on this instance'
        route.fulfill(response=response,body=json.dumps(entries));return
    if path=='/api/settings/get':
        response=route.fetch();data=response.json();settings=json.loads(data['settings'])
        ext=settings.setdefault('extension_settings',{})
        ext['folio']={'enabled':False,'account':'synthetic-live-host'}
        ext['disabledExtensions']=[x for x in ext.get('disabledExtensions',[]) if x!=NAME]
        data['settings']=json.dumps(settings)
        route.fulfill(response=response,body=json.dumps(data));return
    if path=='/api/backends/chat-completions/generate':
        data=req.post_data_json
        safe=MARKER in json.dumps(data.get('messages',[])) and len(calls)<6 and not data.get('stream')
        if not safe:
            blocked.append(path);route.fulfill(status=403,body='Blocked non-fixture generation');return
        entry={'model':data.get('model'),'source':data.get('chat_completion_source')}
        calls.append(entry);start=time.monotonic()
        try:
            response=route.fetch(timeout=65000);entry.update(status=response.status,seconds=round(time.monotonic()-start,2))
            route.fulfill(response=response)
        except Exception:
            entry['status']='network-error';route.fulfill(status=504,body='Live fixture request timed out')
        print(json.dumps({'helper_request':entry}),flush=True);return
    if req.method in ('POST','PUT','PATCH','DELETE') and path not in reads and not path.startswith('/api/tokenizers/'):
        blocked.append(path);route.fulfill(status=200,body='{}',content_type='application/json');return
    route.continue_()

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    try:
        context=browser.new_context(viewport={'width':1440,'height':1050})
        context.route('**/*',route_request)
        page=context.new_page();errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(ORIGIN,wait_until='domcontentloaded',timeout=60000)
        page.wait_for_selector('#folio-wand',state='attached',timeout=60000)
        installed=page.evaluate("""async(prefix)=>({version:(await(await fetch(prefix+'manifest.json')).json()).version,wand:!!document.querySelector('#extensionsMenu #folio-wand')})""",PREFIX)
        assert installed['version']=='0.2.0' and installed['wand'],installed
        result=page.evaluate("""async(prefix)=>{
          const real=SillyTavern.getContext();
          const {Host}=await import(prefix+'src/host.js');const {Engine}=await import(prefix+'src/engine.js');
          const {Cache}=await import(prefix+'src/store.js');const {Embedder}=await import(prefix+'src/embedding.js');
          const {mountUI}=await import(prefix+'src/ui.js');const {bookPages}=await import(prefix+'src/core.js');
          const {runGenerationInterceptors}=await import('/scripts/extensions.js');
          const lines=['FOLIO-LIVE-TEST 我向船長索取信件。','<think>不要收進故事。</think><正文>船長把藍色信件交給旅人，約定冬天前送到山城。信件收件人是醫師林嵐。</正文>',
            'FOLIO-LIVE-TEST 我走到街市吃飯。','午間，旅人在街市吃牛肉麵，花了三枚銅幣。老板說今天不賣魚。',
            'FOLIO-LIVE-TEST 我在驛站休息。','旅人在驛站付了五枚銅幣住一夜。掌櫃把銀色房門鑰匙交給旅人，房間面向西邊。',
            'FOLIO-LIVE-TEST 船長交給我的東西，要在甚麼時候交給誰？'];
          const chat=lines.map((mes,i)=>({mes,name:i%2?'旅人故事':'玩家',is_user:i%2===0,send_date:'folio-live-'+i,extra:{}}));
          let saves=0;
          const fixture={...real,chat,chatId:'folio-live-synthetic-only',mainApi:'openai',
            extensionSettings:{folio:{enabled:true,account:'synthetic-live-host',helperConnection:'auto'}},
            saveChat:async()=>{saves++;},saveSettingsDebounced:()=>{},getTokenCountAsync:async text=>Math.ceil(text.length*1.5)};
          const host=new Host(()=>fixture),cache=new Cache('folio-live-synthetic-'+Date.now()),embedder=new Embedder(cache);
          let ui;const engine=new Engine(host,cache,embedder,state=>ui?.update(state));engine.schedule=()=>{};engine.changed();
          // Replace only this isolated browser's UI with the synthetic chat reader.
          document.querySelector('#folio-wand')?.remove();document.querySelector('.folio-dialog')?.remove();ui=mountUI(engine);
          window.liveFixture={engine,ui,fixture,host,chat,dispose:()=>{engine.dispose();ui.dispose();}};
          const settingsBefore=JSON.stringify(real.chatCompletionSettings);
          for(let i=0;i<4;i++)await engine.tick();
          if(engine.snapshot().ready!==3)throw Error('Live summaries incomplete: '+engine.warning+' / '+engine.status);
          const summarySaves=saves;await engine.tick();if(saves!==summarySaves)throw Error('Completed summary repeated');
          const source=JSON.stringify(chat),core=structuredClone(chat),previous=window.folioIntercept;
          let aborted;
          try{window.folioIntercept=(...args)=>engine.intercept(...args);aborted=await runGenerationInterceptors(core,900,'normal');}
          finally{window.folioIntercept=previous;}
          // Native request-ready event, without sending a paid main-model story reply.
          const observe=data=>engine.captureFinal(data);real.eventSource.on(real.eventTypes.CHAT_COMPLETION_SETTINGS_READY,observe);
          try{await real.eventSource.emit(real.eventTypes.CHAT_COMPLETION_SETTINGS_READY,{type:'normal',messages:core.map(m=>({role:m.is_user?'user':'assistant',content:m.mes}))});}
          finally{real.eventSource.removeListener(real.eventTypes.CHAT_COMPLETION_SETTINGS_READY,observe);}
          ui.open();
          return {summaryCount:bookPages(chat).filter(p=>p.record?.done).length,summarySaves,helperModel:host.model,
            originalUntouched:source===JSON.stringify(chat),settingsUntouched:settingsBefore===JSON.stringify(real.chatCompletionSettings),
            vectorPages:engine.snapshot().indexed,aborted,mode:engine.last?.mode,candidateCount:engine.last?.candidates.length,
            selectedBlueLetter:core.some(m=>m.mes.includes('收件人是醫師林嵐')),historyReduced:core.length<chat.length,
            finalKept:engine.last?.final?.kept,historyCount:core.length,latestPreserved:core.at(-1).mes===chat.at(-1).mes};
        }""",PREFIX)
        assert result['summaryCount']==3 and result['summarySaves']==3,result
        assert result['vectorPages']==3 and result['originalUntouched'] and result['settingsUntouched'],result
        assert not result['aborted'] and result['mode']=='hybrid' and result['candidateCount']>0,result
        assert result['selectedBlueLetter'] and result['historyReduced'] and result['latestPreserved'],result
        assert result['finalKept']==result['historyCount'],result
        page.get_by_role('tab',name='運行',exact=True).click()
        page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-running.png'))
        page.get_by_role('tab',name='書頁目錄').click()
        page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-catalogue.png'))
        page.get_by_role('tab',name='本次取用').click()
        page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-selection.png'))
        page.get_by_role('tab',name='記憶助手').click()
        page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-helper.png'))
        page.set_viewport_size({'width':390,'height':844})
        page.get_by_role('tab',name='書頁目錄').click()
        page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-mobile.png'))
        assert page.locator('.folio-dialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        assert not [e for e in errors if 'folio' in e.lower()],errors
        page.evaluate('liveFixture.dispose()')
        print(json.dumps({'passed':True,'installed':installed,'actual_host':result,'real_helper_calls':calls,'blocked_write_endpoints':sorted(set(blocked)),'unrelated_host_page_errors':len(errors)},ensure_ascii=False),flush=True)
    finally:
        browser.close()
