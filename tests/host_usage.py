"""Installed UI + native send adapter, synthetic chat and mocked outgoing requests.
No source substitution, paid calls, user chat/settings writes, or listening server.
"""
import gzip
import json
import os
import pathlib
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results'
OUT.mkdir(exist_ok=True)
ORIGIN=os.environ['FOLIO_ST_URL'].rstrip('/')
NAME='third-party/sillytavern-folio'
PREFIX='/scripts/extensions/'+NAME+'/'
reads={'/api/settings/get','/api/characters/all','/api/characters/get','/api/characters/chats','/api/chats/get','/api/worldinfo/get','/api/presets/get','/api/avatars/get','/api/groups/all','/api/sd/comfy/workflows','/api/secrets/read','/api/backgrounds/all'}
mock_sends=[]
saved_folio={'enabled':False,'account':'folio-usage-synthetic'}

def handle(route):
    global saved_folio
    req=route.request;parsed=urlparse(req.url);path=parsed.path
    if parsed.netloc!=urlparse(ORIGIN).netloc:
        route.abort();return
    if path=='/api/extensions/discover':
        response=route.fetch();entries=[x for x in response.json() if not x['name'].startswith('third-party/') or x['name']==NAME]
        route.fulfill(response=response,body=json.dumps(entries));return
    if path=='/api/settings/get':
        response=route.fetch();data=response.json();settings=json.loads(data['settings']);ext=settings.setdefault('extension_settings',{})
        ext['folio']=saved_folio
        ext['disabledExtensions']=[x for x in ext.get('disabledExtensions',[]) if x!=NAME]
        data['settings']=json.dumps(settings);route.fulfill(response=response,body=json.dumps(data));return
    if path=='/api/settings/save':
        raw=req.post_data_buffer
        if raw[:2]==b'\x1f\x8b':raw=gzip.decompress(raw)
        saved_folio=json.loads(raw)['extension_settings']['folio']
        route.fulfill(content_type='application/json',body='{}');return
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
        switch=page.get_by_role('switch',name='新回覆自動記憶',exact=True)
        assert not switch.is_checked()
        assert page.locator('.folio-top .folio-toggle-state').inner_text()=='已關閉'
        page.evaluate("async()=>{const c=SillyTavern.getContext();await c.eventSource.emit(c.eventTypes.GENERATION_STARTED,'normal',{},true);await c.eventSource.emit(c.eventTypes.GENERATION_STARTED,'quiet',{},false);}")
        assert '目前正在生成回覆' not in page.locator('#folio-view-run .folio-rebuild').inner_text()
        native_state=page.evaluate("""async prefix=>{const {Host}=await import(prefix+'src/host.js'),api=await import('/script.js'),h=new Host();api.deactivateSendButtons();const busy=await h.generationActive();api.activateSendButtons();const idle=await h.generationActive();return {busy,idle};}""",PREFIX)
        assert native_state=={'busy':True,'idle':False},native_state
        page.get_by_role('tab',name='記憶助手',exact=True).click()
        assert page.get_by_role('switch',name='使用獨立 API',exact=True).is_visible()
        assert not page.get_by_role('switch',name='使用獨立 API',exact=True).is_checked()
        assert page.locator('.folio-api-current').inner_text()=='目前生效：酒館主 API'
        current_before=page.evaluate('JSON.stringify(SillyTavern.getContext().chatCompletionSettings)')
        api_switch=page.get_by_role('switch',name='使用獨立 API',exact=True)
        api_switch.check()
        expect(api_switch).to_be_enabled(timeout=15000)
        assert page.locator('.folio-api-current').inner_text()=='目前生效：獨立 API 設定'
        assert page.locator('.folio-active-model').count()==2
        api_switch.uncheck()
        expect(api_switch).to_be_enabled(timeout=15000)
        assert page.locator('.folio-api-current').inner_text()=='目前生效：酒館主 API'
        assert page.evaluate('JSON.stringify(SillyTavern.getContext().chatCompletionSettings)')==current_before
        page.locator('summary').filter(has_text='不同 API 與模型').click()
        assert not page.locator('#folio-summary-source').is_visible()
        page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-tiers-main-desktop.png'))
        page.set_viewport_size({'width':390,'height':844});page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-tiers-main-mobile.png'))
        page.locator('summary').filter(has_text='不同 API 與模型').click()
        assert page.locator('#folio-summary-source').is_visible()
        assert not page.get_by_label('總結溫度',exact=True).is_visible()
        page.locator('summary').filter(has_text='進階參數與提示詞').click()
        assert page.get_by_label('總結溫度',exact=True).is_visible()
        assert page.locator('.folio-content').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        page.locator('summary').filter(has_text='進階參數與提示詞').scroll_into_view_if_needed()
        page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-tiers-advanced-mobile.png'))
        page.get_by_role('button',name='關閉',exact=True).click()
        page.locator('#extensionsMenuButton').click();page.locator('#folio-wand').click()
        assert not page.locator('#folio-summary-source').is_visible()
        page.set_viewport_size({'width':1440,'height':1050})
        page.get_by_role('button',name='關閉',exact=True).click()
        result=page.evaluate("""async prefix=>{
          const real=SillyTavern.getContext(),originalChat=JSON.stringify(real.chat),originalSettings=JSON.stringify(real.chatCompletionSettings);
          const {Host}=await import(prefix+'src/host.js'),{Engine}=await import(prefix+'src/engine.js'),{Cache}=await import(prefix+'src/store.js');
          const {mountUI}=await import(prefix+'src/ui.js'),{bookPages,newRecord,KEY}=await import(prefix+'src/core.js');
          const oldChat=[{mes:'合成驗收：打開時已經存在的舊正文',is_user:false,name:'船長',send_date:'old-boundary',extra:{}}];
          const oldFixture={...real,chat:oldChat,chatMetadata:{},chatId:'folio-old-boundary',mainApi:'openai',extensionSettings:{folio:{enabled:true,account:'folio-old-boundary'}},saveChat:async()=>{throw Error('Old chat must not be saved');},saveSettingsDebounced:()=>{},getTokenCountAsync:async text=>text.length};
          const oldHost=new Host(()=>oldFixture),oldCache=new Cache('folio-installed-old-boundary'),oldEmbedder={stop(){},embed:async()=>{throw Error('Old chat must not be embedded');}};
          const oldEngine=new Engine(oldHost,oldCache,oldEmbedder);oldEngine.schedule=()=>{};oldEngine.changed();await oldEngine.tick();const oldBoundary={recorded:!!bookPages(oldChat)[0].record,manualPending:oldEngine.snapshot().auto.manualPending};oldEngine.dispose();
          const chat=['合成驗收：船長的藍色信封要交給誰？','合成驗收：船長約定冬天前送到山城，收信人是旅店主人。','合成驗收：我收好信，走進旅店。','合成驗收：旅店主人留下銀色鑰匙，請旅人明日到碼頭。','合成驗收：我明天要去哪裡？'].map((mes,i)=>({mes,is_user:i%2===0,name:i%2?'船長':'玩家',send_date:'folio-usage-'+i,extra:{}}));
          for(const p of bookPages(chat)){const r=newRecord(p.message,p.playerInput);r.done=true;r.summary=p.body;r.title=p.number===1?'藍色信件的約定':'銀色鑰匙';p.message.extra[KEY]=r;}
          const fixture={...real,chat,chatMetadata:{},chatId:'folio-usage-only',mainApi:'openai',isGenerating:()=>window.usageTest?.engine.generating??false,extensionSettings:{folio:{enabled:true,account:'folio-usage-only'}},saveChat:async()=>{if(!fixture.chatMetadata.folio_usage)throw Error('Unexpected non-journal save');},saveSettingsDebounced:()=>{},getTokenCountAsync:async text=>text.length};
          const host=new Host(()=>fixture),cache=new Cache('folio-installed-usage-test'),embedder={stop(){},embed:async()=>{throw Error('No inference needed');}};
          document.querySelector('.folio-dialog').remove();document.querySelector('#folio-wand').remove();
          const t={host,cache,embedder,fixture,originalChat,originalSettings,previous:window.folioIntercept,real};window.usageTest=t;
          t.mount=()=>{t.engine=new Engine(host,cache,embedder,s=>t.ui?.update(s));t.engine.schedule=()=>{};t.ui=mountUI(t.engine);t.engine.changed();for(const p of t.engine.pages())if(p.record?.done)t.engine.vectors.set(t.engine.vectorKey(p.record),[[1,0]]);t.engine.emit();window.folioIntercept=(...args)=>t.engine.intercept(...args);};
          t.observe=body=>t.engine.captureFinal(body);real.eventSource.on(real.eventTypes.CHAT_COMPLETION_SETTINGS_READY,t.observe);t.mount();
          const {runGenerationInterceptors}=await import('/scripts/extensions.js');
          t.engine.generationStarted();t.ui.open();document.querySelector('#folio-view-run .folio-rebuild .folio-primary').click();for(let i=0;i<6;i++)await Promise.resolve();
          const manualPopup=[...document.querySelectorAll('.folio-auto-popup')].at(-1);
          const installedManualQueue={queued:t.engine.snapshot().rebuildQueued,popupVisible:!manualPopup.hidden,popupText:manualPopup.textContent};
          const cancelButton=[...manualPopup.querySelectorAll('button')].find(b=>b.textContent==='取消排隊');if(!cancelButton||cancelButton.hidden)throw Error('Queue cancellation missing');cancelButton.click();for(let i=0;i<6;i++)await Promise.resolve();
          const installedQueueCancelled=!t.engine.snapshot().rebuildQueued&&t.engine.generating&&!t.engine.snapshot().rebuild;
          if(!installedQueueCancelled)throw Error('Queue cancellation failed or stopped the main reply');
          t.engine.generating=false;t.engine.emit();document.querySelector('.folio-dialog').close();
          t.sequence=0;t.send=async()=>{const core=structuredClone(chat);if(await runGenerationInterceptors(core,10000,'normal'))throw Error('Unexpected abort');const api=await host.api();const answer=await api.sendOpenAIRequest('normal',core.map(m=>({role:m.is_user?'user':'assistant',content:m.mes})));if(typeof answer==='function'){for await(const part of answer()){};}const n=++t.sequence;chat.push({mes:'合成驗收：角色回覆 '+n,is_user:false,name:'船長',send_date:'usage-result-'+n,extra:{}});t.engine.newResponse();await t.engine.usageWrite;return core;};
          await t.send();t.first=t.engine.snapshot().usages[0].id;t.ui.open();
          return {oldBoundary,installedManualQueue,installedQueueCancelled,receiptCount:t.engine.snapshot().usages.length,kept:t.engine.snapshot().usages[0].final.kept,originalChatUntouched:JSON.stringify(real.chat)===originalChat,settingsUntouched:JSON.stringify(real.chatCompletionSettings)===originalSettings};
        }""",PREFIX)
        assert result['oldBoundary']=={'recorded':False,'manualPending':1},result
        assert result['installedManualQueue']['queued'] and result['installedManualQueue']['popupVisible'] and '已排隊，等待回覆完成' in result['installedManualQueue']['popupText'],result
        assert {key:result[key] for key in ('receiptCount','kept','originalChatUntouched','settingsUntouched')}=={'receiptCount':1,'kept':5,'originalChatUntouched':True,'settingsUntouched':True},result
        installed_popup=page.locator('.folio-auto-popup').last
        assert installed_popup.is_visible()
        assert '摘要 0/1 頁' in installed_popup.inner_text() and '向量 0/1 頁' in installed_popup.inner_text()
        installed_popup.screenshot(path=str(OUT/'lan-auto-progress.png'))
        page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-dashboard-desktop.png'))
        page.set_viewport_size({'width':390,'height':844});page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-dashboard-mobile.png'))
        assert page.locator('.folio-content').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        page.evaluate("""async()=>{
          const t=usageTest;t.fixture.chat.push({mes:'合成驗收：第二次提問',is_user:true,name:'玩家',send_date:'second-user',extra:{}});t.engine.changed();await t.send();
          if(t.engine.snapshot().usages[0].id===t.first)throw Error('New response did not become latest');
          t.fixture.chat.pop();t.engine.changed({deleted:true});
          if(t.engine.snapshot().usages[0].id!==t.first)throw Error('Deleting newest response did not roll back to older receipt');
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
        page.locator('summary').filter(has_text='較早的取用紀錄').click()
        page.get_by_label('發送紀錄',exact=True).select_option(index=1)
        assert page.locator('.folio-source-missing').count()==2
        final=page.evaluate("""()=>{const t=usageTest;const intact=JSON.stringify(t.real.chat)===t.originalChat&&JSON.stringify(t.real.chatCompletionSettings)===t.originalSettings;t.real.eventSource.removeListener(t.real.eventTypes.CHAT_COMPLETION_SETTINGS_READY,t.observe);window.folioIntercept=t.previous;t.engine.dispose();t.ui.dispose();return intact;}""")
        assert final
        assert len(mock_sends)==3,mock_sends
        assert not errors,errors
        print(json.dumps({'passed':True,'installedVersion':version,'installedThreeLayers':True,'installedDryRunFilter':True,'nativeGenerationState':native_state,'installedQueueCancelled':result['installedQueueCancelled'],'oldChatAutomaticCalls':0,'oldChatManualPending':1,'nativeWand':True,'installedManualQueue':True,'installedManualPopup':True,'installedAutoProgress':True,'nativeMockSends':mock_sends,'paidCalls':0,'deletedLatestAndSourcesPersist':True,'cacheReopen':True,'historySwitching':True,'userChatAndSettingsUntouched':final,'browserErrors':errors}),flush=True)
    finally:
        browser.close()
