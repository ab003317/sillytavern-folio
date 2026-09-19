"""Installed UI + native send adapter, synthetic chat and mocked outgoing requests.
No source substitution, paid calls, user chat/settings writes, or listening server.
"""
import json
import os
import pathlib
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results'
OUT.mkdir(exist_ok=True)
ORIGIN=os.environ['FOLIO_ST_URL'].rstrip('/')
NAME='third-party/sillytavern-folio'
PREFIX='/scripts/extensions/'+NAME+'/'
reads={'/api/settings/get','/api/characters/all','/api/characters/get','/api/characters/chats','/api/chats/get','/api/worldinfo/get','/api/presets/get','/api/avatars/get','/api/groups/all','/api/sd/comfy/workflows','/api/secrets/read','/api/backgrounds/all'}
mock_sends=[]

def handle(route):
    req=route.request;parsed=urlparse(req.url);path=parsed.path
    if parsed.netloc!=urlparse(ORIGIN).netloc:
        route.abort();return
    if path=='/api/extensions/discover':
        response=route.fetch();entries=[x for x in response.json() if not x['name'].startswith('third-party/') or x['name']==NAME]
        route.fulfill(response=response,body=json.dumps(entries));return
    if path=='/api/settings/get':
        response=route.fetch();data=response.json();settings=json.loads(data['settings']);ext=settings.setdefault('extension_settings',{})
        ext['folio']={'enabled':False,'account':'folio-usage-synthetic'}
        ext['disabledExtensions']=[x for x in ext.get('disabledExtensions',[]) if x!=NAME]
        data['settings']=json.dumps(settings);route.fulfill(response=response,body=json.dumps(data));return
    if path=='/api/backends/chat-completions/generate':
        data=req.post_data_json
        assert data['messages'] and all('合成驗收' in str(m.get('content','')) for m in data['messages']), 'Unexpected request blocked'
        mock_sends.append({'messages':len(data['messages']),'stream':bool(data.get('stream'))})
        if data.get('stream'):
            route.fulfill(status=200,content_type='text/event-stream',body='data: {"choices":[{"index":0,"delta":{"content":"合成測試回覆"}}]}\n\ndata: [DONE]\n\n')
        else:
            route.fulfill(status=200,content_type='application/json',body=json.dumps({'choices':[{'message':{'content':'合成測試回覆'}}]}))
        return
    if req.method in ('POST','PUT','PATCH','DELETE') and path not in reads and not path.startswith('/api/tokenizers/'):
        route.fulfill(status=200,body='{}',content_type='application/json');return
    route.continue_()

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    try:
        context=browser.new_context(viewport={'width':1440,'height':1050});context.route('**/*',handle)
        page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(ORIGIN,wait_until='domcontentloaded',timeout=60000)
        page.wait_for_selector('#folio-wand',state='attached',timeout=60000)
        version=page.evaluate("async prefix=>(await(await fetch(prefix+'manifest.json')).json()).version",PREFIX)
        assert version==json.loads((ROOT/'manifest.json').read_text(encoding='utf-8'))['version']
        page.locator('#extensionsMenuButton').click();page.locator('#folio-wand').click()
        assert page.get_by_role('progressbar',name='摘要目錄',exact=True).is_visible()
        switch=page.get_by_role('switch',name='自動記憶',exact=True)
        assert not switch.is_checked()
        assert page.locator('.folio-toggle-state').inner_text()=='已關閉'
        page.get_by_role('button',name='關閉',exact=True).click()
        result=page.evaluate("""async prefix=>{
          const real=SillyTavern.getContext(),originalChat=JSON.stringify(real.chat),originalSettings=JSON.stringify(real.chatCompletionSettings);
          const {Host}=await import(prefix+'src/host.js'),{Engine}=await import(prefix+'src/engine.js'),{Cache}=await import(prefix+'src/store.js');
          const {mountUI}=await import(prefix+'src/ui.js'),{bookPages,newRecord,KEY}=await import(prefix+'src/core.js');
          const chat=['合成驗收：船長的藍色信封要交給誰？','合成驗收：船長約定冬天前送到山城，收信人是旅店主人。','合成驗收：我收好信，走進旅店。','合成驗收：旅店主人留下銀色鑰匙，請旅人明日到碼頭。','合成驗收：我明天要去哪裡？'].map((mes,i)=>({mes,is_user:i%2===0,name:i%2?'船長':'玩家',send_date:'folio-usage-'+i,extra:{}}));
          for(const p of bookPages(chat)){const r=newRecord(p.message,p.playerInput);r.done=true;r.summary=p.body;r.title=p.number===1?'藍色信件的約定':'銀色鑰匙';p.message.extra[KEY]=r;}
          const fixture={...real,chat,chatId:'folio-usage-only',mainApi:'openai',extensionSettings:{folio:{enabled:true,account:'folio-usage-only'}},saveChat:async()=>{throw Error('Unexpected chat save');},saveSettingsDebounced:()=>{},getTokenCountAsync:async text=>text.length};
          const host=new Host(()=>fixture),cache=new Cache('folio-installed-usage-test'),embedder={stop(){},embed:async()=>{throw Error('No inference needed');}};
          document.querySelector('.folio-dialog').remove();document.querySelector('#folio-wand').remove();
          const t={host,cache,embedder,fixture,originalChat,originalSettings,previous:window.folioIntercept,real};window.usageTest=t;
          t.mount=()=>{t.engine=new Engine(host,cache,embedder,s=>t.ui?.update(s));t.engine.schedule=()=>{};t.ui=mountUI(t.engine);t.engine.changed();for(const p of t.engine.pages())t.engine.vectors.set(t.engine.vectorKey(p.record),[[1,0]]);t.engine.emit();window.folioIntercept=(...args)=>t.engine.intercept(...args);};
          t.observe=body=>t.engine.captureFinal(body);real.eventSource.on(real.eventTypes.CHAT_COMPLETION_SETTINGS_READY,t.observe);t.mount();
          const {runGenerationInterceptors}=await import('/scripts/extensions.js');
          t.send=async()=>{const core=structuredClone(chat);if(await runGenerationInterceptors(core,10000,'normal'))throw Error('Unexpected abort');const api=await host.api();const answer=await api.sendOpenAIRequest('normal',core.map(m=>({role:m.is_user?'user':'assistant',content:m.mes})));if(typeof answer==='function'){for await(const part of answer()){};}await t.engine.usageWrite;return core;};
          await t.send();t.first=t.engine.snapshot().usages[0].id;t.ui.open();
          return {receiptCount:t.engine.snapshot().usages.length,kept:t.engine.snapshot().usages[0].final.kept,originalChatUntouched:JSON.stringify(real.chat)===originalChat,settingsUntouched:JSON.stringify(real.chatCompletionSettings)===originalSettings};
        }""",PREFIX)
        assert result=={'receiptCount':1,'kept':5,'originalChatUntouched':True,'settingsUntouched':True},result
        page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-dashboard-desktop.png'))
        page.set_viewport_size({'width':390,'height':844});page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-dashboard-mobile.png'))
        assert page.locator('.folio-content').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        page.evaluate("""async()=>{
          const t=usageTest;t.fixture.chat.push({mes:'合成驗收：最新回覆',is_user:false,name:'船長',send_date:'latest',extra:{}});t.engine.changed();t.fixture.chat.pop();t.engine.changed({deleted:true});
          if(t.engine.snapshot().usages[0].id!==t.first)throw Error('Deleted latest response erased receipt');
          t.fixture.chat.splice(0,2);t.engine.changed({deleted:true});await t.engine.maintenance;await t.engine.usageWrite;t.engine.dispose();t.ui.dispose();t.mount();
        }""")
        page.wait_for_function('usageTest.engine.snapshot().usages.length===1')
        page.evaluate('usageTest.ui.open()');page.get_by_role('tab',name='本次取用',exact=True).click()
        assert page.locator('.folio-source-missing').count()==2
        assert page.locator('#folio-view-selection textarea').count()==0
        page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-usage-deleted-mobile.png'))
        page.set_viewport_size({'width':1440,'height':1050});page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-usage-deleted-desktop.png'))
        page.evaluate('usageTest.send()')
        page.wait_for_function("document.querySelectorAll('.folio-usage-bar option').length===2")
        assert page.locator('.folio-source-missing').count()==0
        page.get_by_label('發送紀錄',exact=True).select_option(index=1)
        assert page.locator('.folio-source-missing').count()==2
        final=page.evaluate("""()=>{const t=usageTest;const intact=JSON.stringify(t.real.chat)===t.originalChat&&JSON.stringify(t.real.chatCompletionSettings)===t.originalSettings;t.real.eventSource.removeListener(t.real.eventTypes.CHAT_COMPLETION_SETTINGS_READY,t.observe);window.folioIntercept=t.previous;t.engine.dispose();t.ui.dispose();return intact;}""")
        assert final
        assert len(mock_sends)==2,mock_sends
        assert not errors,errors
        print(json.dumps({'passed':True,'installedVersion':version,'nativeWand':True,'nativeMockSends':mock_sends,'paidCalls':0,'deletedLatestAndSourcesPersist':True,'cacheReopen':True,'historySwitching':True,'userChatAndSettingsUntouched':final,'browserErrors':errors}),flush=True)
    finally:
        browser.close()
