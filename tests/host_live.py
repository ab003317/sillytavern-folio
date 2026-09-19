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
        prompt=json.dumps(data.get('messages',[]),ensure_ascii=False)
        safe=(MARKER in prompt or ('連線測試' in prompt and ('船長將藍色信件交給旅人，約定冬天前送到山城。' in prompt or '船長的信應在甚麼時候送到哪裡' in prompt))) and len(calls)<6 and not data.get('stream')
        if not safe:
            blocked.append(path);route.fulfill(status=403,body='Blocked non-fixture generation');return
        entry={'model':data.get('model'),'source':data.get('chat_completion_source')}
        calls.append(entry);start=time.monotonic()
        try:
            response=route.fetch(timeout=65000);entry.update(status=response.status,seconds=round(time.monotonic()-start,2))
            try:
                payload=response.json();choice=(payload.get('choices') or [{}])[0]
                err=payload.get('error');entry.update(responseKeys=list(payload.keys()),errorType=err.get('type') if isinstance(err,dict) else type(err).__name__ if err else None,errorCode=err.get('code') if isinstance(err,dict) else None,contentLength=len(str(choice.get('message',{}).get('content') or '')),finishReason=choice.get('finish_reason'))
            except Exception:
                entry['responseFormat']='non-json'
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
        assert installed['version']=='0.3.0' and installed['wand'],installed
        page.locator('#extensionsMenuButton').click()
        page.locator('#folio-wand').click()
        page.locator('.folio-dialog').wait_for(state='visible')
        page.get_by_role('button',name='關閉',exact=True).click()
        installed['nativeWandClick']=True
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
          const api=await host.api(),extractionModel=api.getChatCompletionModel(real.chatCompletionSettings);
          host.configureHelper('selection','current',extractionModel);
          if(host.helper('summary').model===extractionModel)throw Error('This acceptance requires two distinct existing models');
          let ui;const engine=new Engine(host,cache,embedder,state=>ui?.update(state));engine.schedule=()=>{};engine.changed();
          // Replace only this isolated browser's UI with the synthetic chat reader.
          document.querySelector('#folio-wand')?.remove();document.querySelector('.folio-dialog')?.remove();ui=mountUI(engine);
          window.liveFixture={engine,ui,fixture,host,chat,cache,embedder,dispose:()=>{engine.dispose();ui.dispose();}};
          const settingsBefore=JSON.stringify(real.chatCompletionSettings);
          for(let i=0;i<4;i++){await engine.tick();if(engine.warning&&!engine.snapshot().ready)throw Error('First live summary failed: '+engine.warning);}
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
          return {summaryCount:bookPages(chat).filter(p=>p.record?.done).length,summarySaves,summaryModel:host.models.summary,extractionModel:host.models.selection,
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
        page.get_by_role('button',name='測試總結模型',exact=True).click()
        page.wait_for_function("liveFixture.engine.connectionTests.summary && !liveFixture.engine.connectionTests.summary.pending",timeout=65000)
        assert page.evaluate('liveFixture.engine.connectionTests.summary.ok'),page.evaluate('liveFixture.engine.connectionTests.summary')
        page.get_by_role('button',name='測試提取模型',exact=True).click()
        page.wait_for_function("liveFixture.engine.connectionTests.selection && !liveFixture.engine.connectionTests.selection.pending",timeout=65000)
        assert page.evaluate('liveFixture.engine.connectionTests.selection.ok'),page.evaluate('liveFixture.engine.connectionTests.selection')
        result['bothModelButtons']=True
        page.locator('.folio-content').evaluate('(e)=>e.scrollTop=0')
        page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-helper.png'))
        page.set_viewport_size({'width':390,'height':844})
        page.get_by_role('tab',name='書頁目錄').click()
        page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-mobile.png'))
        assert page.locator('.folio-dialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        deletion=page.evaluate("""async(prefix)=>{
          const {engine,host,chat,cache}=liveFixture,{bookPages}=await import(prefix+'src/core.js');
          const core=structuredClone(chat),oldHash=bookPages(chat)[0].hash,survivorHashes=bookPages(chat).slice(1).map(p=>p.hash);
          await engine.intercept(core,10000,()=>{throw Error('unexpected abort');},'normal');
          chat.splice(0,2);engine.changed({deleted:true});await engine.maintenance;
          const c=SillyTavern.getContext(),observe=body=>engine.captureFinal(body);c.eventSource.on(c.eventTypes.CHAT_COMPLETION_SETTINGS_READY,observe);
          let blocked=false;
          try{await(await host.api()).sendOpenAIRequest('normal',core.map(m=>({role:m.is_user?'user':'assistant',content:m.mes})));}
          catch(e){blocked=String(e.message).includes('生成已取消');}
          finally{c.eventSource.removeListener(c.eventTypes.CHAT_COMPLETION_SETTINGS_READY,observe);}
          await engine.tick();const pages=bookPages(chat);
          return {blockedBeforeFetch:blocked,traceCleared:engine.last===null,remainingPages:pages.length,survivorsUnchanged:pages.every((p,i)=>p.record?.hash===survivorHashes[i]),deletedReceiptGone:!await cache.get('records',host.identity()+':'+oldHash),deletedAbsent:!engine.snapshot().entries.some(p=>p.body.includes('收件人是醫師林嵐'))};
        }""",PREFIX)
        assert deletion['blockedBeforeFetch'] and deletion['traceCleared'] and deletion['remainingPages']==2 and deletion['survivorsUnchanged'] and deletion['deletedReceiptGone'] and deletion['deletedAbsent'],deletion
        assert len(calls)==6,calls
        assert calls[0]['model']==result['summaryModel'] and calls[3]['model']==result['extractionModel'] and calls[4]['model']==result['summaryModel'] and calls[5]['model']==result['extractionModel'],calls
        assert result['summaryModel']!=result['extractionModel'],result
        assert not [e for e in errors if 'folio' in e.lower()],errors
        page.evaluate('liveFixture.dispose()')
        print(json.dumps({'passed':True,'installed':installed,'actual_host':result,'deletion':deletion,'real_helper_calls':calls,'blocked_write_endpoints':sorted(set(blocked)),'unrelated_host_page_errors':len(errors)},ensure_ascii=False),flush=True)
    finally:
        browser.close()
