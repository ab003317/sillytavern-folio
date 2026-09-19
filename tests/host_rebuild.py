"""Opt-in click acceptance against INSTALLED Folio and actual configured summary model.

Three short paid requests maximum, only synthetic marked story. No real chat/settings
writes, no server start or restart; browser/worker closes on completion or failure.
"""
import json
import os
import pathlib
import time
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

assert os.environ.get('FOLIO_LIVE_API')=='1','Live API opt-in required'
ORIGIN=os.environ['FOLIO_ST_URL'].rstrip('/')
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results'
OUT.mkdir(exist_ok=True)
NAME='third-party/sillytavern-folio'
PREFIX='/scripts/extensions/'+NAME+'/'
MARKER='FOLIO-REBUILD-TEST'
reads={'/api/settings/get','/api/characters/all','/api/characters/get','/api/characters/chats','/api/chats/get','/api/worldinfo/get','/api/presets/get','/api/avatars/get','/api/groups/all','/api/sd/comfy/workflows','/api/secrets/read','/api/backgrounds/all'}
calls=[]

def handle(route):
    req=route.request;parsed=urlparse(req.url);path=parsed.path
    if parsed.netloc!=urlparse(ORIGIN).netloc:route.abort();return
    if path=='/api/extensions/discover':
        response=route.fetch();data=[x for x in response.json() if not x['name'].startswith('third-party/') or x['name']==NAME]
        route.fulfill(response=response,body=json.dumps(data));return
    if path=='/api/settings/get':
        response=route.fetch();data=response.json();settings=json.loads(data['settings']);ext=settings.setdefault('extension_settings',{})
        # Preserve actual helper configuration, but isolate the enabled switch and account identity.
        ext['folio']={**ext.get('folio',{}),'enabled':False,'account':'folio-rebuild-synthetic'}
        ext['disabledExtensions']=[x for x in ext.get('disabledExtensions',[]) if x!=NAME]
        data['settings']=json.dumps(settings);route.fulfill(response=response,body=json.dumps(data));return
    if path=='/api/backends/chat-completions/generate':
        data=req.post_data_json
        if MARKER not in json.dumps(data.get('messages',[])) or data.get('stream') or len(calls)>=3:
            route.fulfill(status=403,body='Blocked non-fixture generation');return
        entry={'model':data.get('model'),'source':data.get('chat_completion_source')};calls.append(entry);start=time.monotonic()
        try:
            response=route.fetch(timeout=65000);payload=response.json();choice=(payload.get('choices') or [{}])[0]
            entry.update(status=response.status,seconds=round(time.monotonic()-start,2),contentLength=len(choice.get('message',{}).get('content') or ''))
            route.fulfill(response=response)
        except Exception:entry['status']='network-error';route.fulfill(status=504,body='Fixture request failed')
        print(json.dumps({'actual_summary':entry}),flush=True);return
    if req.method in ('POST','PUT','PATCH','DELETE') and path not in reads and not path.startswith('/api/tokenizers/'):
        route.fulfill(status=200,body='{}',content_type='application/json');return
    route.continue_()

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    try:
        context=browser.new_context(viewport={'width':1440,'height':1050});context.route('**/*',handle)
        page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(ORIGIN,wait_until='domcontentloaded',timeout=60000);page.wait_for_selector('#folio-wand',state='attached',timeout=60000)
        version=page.evaluate("""async(prefix)=>(await(await fetch(prefix+'manifest.json')).json()).version""",PREFIX)
        assert version==json.loads((ROOT/'manifest.json').read_text(encoding='utf-8'))['version'],version
        page.evaluate("""async(prefix)=>{
            const real=SillyTavern.getContext(),{Host}=await import(prefix+'src/host.js'),{Engine}=await import(prefix+'src/engine.js');
            const {Cache}=await import(prefix+'src/store.js'),{Embedder}=await import(prefix+'src/embedding.js'),{mountUI}=await import(prefix+'src/ui.js'),{bookPages,newRecord}=await import(prefix+'src/core.js');
            const lines=['FOLIO-REBUILD-TEST 我向船長詢問信件。','船長交付藍色信件，請旅人在冬天前送到山城的醫師林嵐手上。','FOLIO-REBUILD-TEST 我去旅店休息。','掌櫃收下五枚銅幣，交給旅人銀色房門鑰匙，客房朝西。'];
            const chat=lines.map((mes,i)=>({mes,name:i%2?'旅人故事':'玩家',is_user:i%2===0,send_date:'rebuild-'+i,extra:{}}));
            const fixture={...real,chat,chatId:'folio-rebuild-synthetic-only',extensionSettings:{...real.extensionSettings,folio:structuredClone(real.extensionSettings.folio)},saveChat:async()=>{},saveSettingsDebounced:()=>{},getTokenCountAsync:async text=>Math.ceil(text.length*1.5)};
            fixture.extensionSettings.folio.enabled=false;
            const host=new Host(()=>fixture),cache=new Cache('folio-rebuild-test-'+Date.now()),embedder=new Embedder(cache);let ui;
            const engine=new Engine(host,cache,embedder,state=>ui?.update(state));
            for(const p of bookPages(chat)){const r=newRecord(p.message,p.playerInput);r.summary='待替換的合成舊摘要';r.title='合成舊目錄';r.done=true;p.message.extra.folio_memory=r;await cache.put('records',host.identity()+':'+r.hash,r);}
            document.querySelector('#folio-wand')?.remove();document.querySelector('.folio-dialog')?.remove();ui=mountUI(engine);engine.changed();
            window.rebuildFixture={engine,ui,host,chat,raw:JSON.stringify(chat.map(m=>m.mes)),originalChat:JSON.stringify(real.chat),originalSettings:JSON.stringify(real.chatCompletionSettings),dispose:()=>{engine.dispose();ui.dispose();}};
        }""",PREFIX)
        page.locator('#extensionsMenuButton').click();page.locator('#folio-wand').click();page.get_by_role('tab',name='書頁目錄').click()
        page.locator('.folio-page-link').nth(1).click();page.get_by_role('button',name='重新整理此頁',exact=True).click()
        page.wait_for_function('rebuildFixture.engine.rebuildState()?.complete||!!rebuildFixture.engine.warning',timeout=65000)
        assert page.evaluate('rebuildFixture.engine.rebuildState()?.complete'),page.evaluate('rebuildFixture.engine.warning')
        assert len(calls)==1 and calls[0].get('contentLength',0)>0,calls
        assert page.locator('.folio-page-work').inner_text()=='此頁已重新整理完成。'
        assert not page.get_by_label('新回覆自動記憶',exact=True).is_checked()
        page.get_by_role('button',name='一鍵重新整理全部',exact=True).click()
        page.wait_for_function('(!rebuildFixture.engine.resetting && rebuildFixture.engine.rebuildState()?.total===2 && rebuildFixture.engine.rebuildState()?.complete)||!!rebuildFixture.engine.warning',timeout=130000)
        assert page.evaluate('rebuildFixture.engine.rebuildState()?.done')==2,page.evaluate('rebuildFixture.engine.warning')
        assert page.evaluate('rebuildFixture.engine.rebuildState()?.vectors')==2
        assert len(calls)==3 and all(c.get('contentLength',0)>0 for c in calls),calls
        page.locator('.folio-content').evaluate('(e)=>e.scrollTop=0');page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-rebuild-desktop.png'))
        page.set_viewport_size({'width':390,'height':844});page.get_by_role('tab',name='運行',exact=True).click()
        page.locator('.folio-content').evaluate('(e)=>e.scrollTop=0');page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-rebuild-mobile.png'))
        assert page.locator('.folio-content').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        safe=page.evaluate("""()=>({realChatUntouched:rebuildFixture.originalChat===JSON.stringify(SillyTavern.getContext().chat),mainSettingsUntouched:rebuildFixture.originalSettings===JSON.stringify(SillyTavern.getContext().chatCompletionSettings),fixtureBodyUntouched:rebuildFixture.raw===JSON.stringify(rebuildFixture.chat.map(m=>m.mes)),autoStillOff:!rebuildFixture.host.settings().enabled})""")
        assert all(safe.values()),safe
        assert not errors,errors
        page.evaluate('rebuildFixture.dispose()')
        print(json.dumps({'passed':True,'version':version,'singlePageClick':True,'allPagesClick':True,'realCalls':calls,'safety':safe,'browserErrors':errors}),flush=True)
    finally:browser.close()
