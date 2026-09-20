"""Native saveReply events + native saveChat serialization, isolated synthetic chat.
No model calls or account writes. Mock chat storage persists across page reload
and a fresh browser context with no IndexedDB. FOLIO_LOCAL=1 tests local files.
"""
import gzip
import json
import mimetypes
import os
import pathlib
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT=pathlib.Path(__file__).resolve().parents[1]
ORIGIN=os.environ['FOLIO_ST_URL'].rstrip('/')
NAME='third-party/sillytavern-folio'
PREFIX='/scripts/extensions/'+NAME+'/'
reads={'/api/settings/get','/api/characters/all','/api/characters/get','/api/characters/chats','/api/chats/get','/api/worldinfo/get','/api/presets/get','/api/avatars/get','/api/groups/all','/api/secrets/read','/api/backgrounds/all'}
disk=None
saves=0
errors=[]

def handle(route):
    global disk,saves
    req=route.request;path=urlparse(req.url).path
    if urlparse(req.url).netloc!=urlparse(ORIGIN).netloc:route.abort();return
    if path=='/api/extensions/discover':
        response=route.fetch();route.fulfill(response=response,body=json.dumps([x for x in response.json() if not x['name'].startswith('third-party/') or x['name']==NAME]));return
    if os.environ.get('FOLIO_LOCAL')=='1' and path.startswith(PREFIX):
        file=(ROOT/path[len(PREFIX):]).resolve();assert file.is_relative_to(ROOT)
        mime={'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm'}.get(file.suffix,mimetypes.guess_type(str(file))[0] or 'application/octet-stream')
        route.fulfill(body=file.read_bytes(),content_type=mime);return
    if path=='/api/settings/get':
        response=route.fetch();data=response.json();settings=json.loads(data['settings']);ext=settings['extension_settings']
        ext['folio']={'enabled':False,'account':'isolated-native-receipts'}
        ext['disabledExtensions']=[x for x in ext.get('disabledExtensions',[]) if x!=NAME]
        data['settings']=json.dumps(settings);route.fulfill(response=response,body=json.dumps(data));return
    if path=='/api/chats/save':
        raw=req.post_data_buffer
        if raw[:2]==b'\x1f\x8b':raw=gzip.decompress(raw)
        data=json.loads(raw)
        if data.get('file_name')=='folio-receipt-fixture':
            assert all('FOLIO-RECEIPT' in m.get('mes','') for m in data['chat'][1:])
            metadata=data['chat'][0]['chat_metadata']
            disk=[{'chat_metadata':{'folio_usage':metadata.get('folio_usage',{})}},*data['chat'][1:]];saves+=1
        route.fulfill(content_type='application/json',body='{}');return
    if req.method in ('POST','PUT','PATCH','DELETE') and path not in reads and not path.startswith('/api/tokenizers/'):
        route.fulfill(content_type='application/json',body='{}');return
    route.continue_()

def setup(page):
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(ORIGIN,wait_until='domcontentloaded',timeout=60000)
    page.wait_for_selector('#folio-wand',state='attached',timeout=60000)
    return page.evaluate("""async ({prefix,disk})=>{
      const real=SillyTavern.getContext(),api=await import('/script.js');
      const {Host}=await import(prefix+'src/host.js'),{Engine}=await import(prefix+'src/engine.js'),{Cache}=await import(prefix+'src/store.js'),{mountUI}=await import(prefix+'src/ui.js');
      real.characters.push({name:'Folio synthetic',avatar:'none',chat:'folio-receipt-fixture'});api.setCharacterId(real.characters.length-1);api.setCharacterName('Folio synthetic');
      real.chat.splice(0,real.chat.length,...(disk?disk.slice(1):[{mes:'FOLIO-RECEIPT 合成提問',is_user:true,name:'玩家',send_date:'fixture-question',extra:{}}]));
      const fixture={...real,chat:real.chat,chatId:'receipt-fixture',chatMetadata:disk?.[0]?.chat_metadata??{},mainApi:'openai',extensionSettings:{folio:{enabled:true,account:'receipt-fixture'}},isGenerating:()=>false,getTokenCountAsync:async text=>text.length,saveSettingsDebounced(){},saveChat:()=>api.saveChat({chatName:'folio-receipt-fixture',withMetadata:fixture.chatMetadata,chatData:structuredClone(fixture.chat)})};
      const host=new Host(()=>fixture),cache=new Cache('folio-native-receipts'),embedder={stop(){},embed:async()=>{throw Error('Unexpected embedding');}};
      let ui;const engine=new Engine(host,cache,embedder,s=>ui?.update(s));engine.schedule=()=>{};
      const receive=(messageId,type)=>engine.newResponse({messageId,type}),swiped=()=>engine.changed();
      real.eventSource.on(real.eventTypes.MESSAGE_RECEIVED,receive);real.eventSource.on(real.eventTypes.CHARACTER_MESSAGE_RENDERED,receive);real.eventSource.on(real.eventTypes.MESSAGE_SWIPED,swiped);
      document.querySelector('.folio-dialog')?.remove();document.querySelector('#folio-wand')?.remove();ui=mountUI(engine);engine.changed();ui.open();
      const t={engine,host,fixture,api,cache,ui,real};window.receiptTest=t;
      t.begin=async type=>{engine.generationStarted(type);const core=structuredClone(type==='swipe'?fixture.chat.slice(0,-1):fixture.chat);await engine.intercept(core,100000,()=>{throw Error('unexpected abort');},type);engine.captureFinal({type,messages:core.map(m=>({role:m.is_user?'user':'assistant',content:m.mes}))});return engine.last.id;};
      t.send=async(type,text)=>{const id=await t.begin(type);await api.saveReply({type,getMessage:'FOLIO-RECEIPT '+text});await engine.generationEnded();await engine.usageWrite;if(engine.snapshot().usages[0]?.id!==id)throw Error('Native '+type+' did not bind its receipt');return id;};
      return {restored:engine.snapshot().usages.length};
    }""",{'prefix':PREFIX,'disk':disk})

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    try:
        context=browser.new_context(viewport={'width':1280,'height':1000});context.route('**/*',handle);page=context.new_page();setup(page)
        result=page.evaluate("""async()=>{
          const t=receiptTest,{engine,fixture,api,real}=t;const first=await t.send('normal','第一個角色回覆');
          fixture.chat.at(-1).mes+=' 玩家修正';fixture.chat.at(-1).is_system=true;engine.changed();
          if(engine.snapshot().usages[0]?.id!==first)throw Error('Editing/hiding erased receipt');fixture.chat.at(-1).is_system=false;
          const continued=await t.send('continue','接續同一樓層');if(engine.snapshot().usages.length!==2)throw Error('Continue dropped older receipt');
          const reply=fixture.chat.at(-1);reply.swipe_id=reply.swipes.length;
          const swiped=await t.send('swipe','另一個候選回覆');if(engine.snapshot().usages.length!==1)throw Error('Inactive variant considered present');
          reply.swipe_id=0;reply.mes=reply.swipes[0];reply.extra=structuredClone(reply.swipe_info[0].extra);reply.send_date=reply.swipe_info[0].send_date;
          await real.eventSource.emit(real.eventTypes.MESSAGE_SWIPED,fixture.chat.length-1);
          if(engine.snapshot().usages[0]?.id!==continued)throw Error('Navigating old swipe lost old receipt');
          for(let i=0;i<23;i++){await t.begin('normal');await engine.generationEnded();}await engine.usageWrite;
          if(engine.snapshot().usages[0]?.id!==continued||engine.snapshot().usageStoredCount!==3)throw Error('Failed requests evicted receipts');
          const newest=await t.send('normal','新的另一樓回覆');fixture.chat.pop();engine.changed({deleted:true});await fixture.saveChat();
          if(engine.snapshot().usages[0]?.id!==continued)throw Error('Deleting newest did not roll back');
          return {first,continued,swiped,newest,active:engine.snapshot().usages.length,saved:engine.snapshot().usageStoredCount};
        }""")
        assert result['active']==2 and result['saved']==4,result
        assert disk and len(disk[0]['chat_metadata']['folio_usage']['records'])==4
        # Real reload: discard engines; load the serialized chat as a normal host load would.
        restored=setup(page);assert restored['restored']==2,restored
        page.get_by_role('tab',name='本次取用',exact=True).click()
        assert page.locator('.folio-usage-bar option').count()==2
        context.close()
        # Entirely fresh browser storage: only saved chat + metadata are restored.
        context=browser.new_context(viewport={'width':390,'height':844});context.route('**/*',handle);page=context.new_page()
        restored=setup(page);assert restored['restored']==2,restored
        page.get_by_role('tab',name='本次取用',exact=True).click()
        assert page.locator('.folio-usage-bar option').count()==2
        assert page.locator('.folio-content').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        assert page.evaluate('receiptTest.engine.snapshot().usages[0].id')==result['continued']
        archive=page.locator('.folio-usage-archive')
        assert archive.is_visible()
        archive.locator('summary').first.click()
        assert archive.locator('.folio-archived-entry').count()==2
        archive.locator('.folio-archived-entry summary').first.click()
        assert 'FOLIO-RECEIPT' in archive.inner_text()
        (ROOT/'test-results').mkdir(exist_ok=True)
        archive.scroll_into_view_if_needed()
        page.locator('.folio-dialog').screenshot(path=str(ROOT/'test-results'/'native-receipt-archive-mobile.png'))
        assert not errors,errors
        print(json.dumps({'passed':True,'nativeSaveReply':['normal','continue','swipe'],'editAndHideRetained':True,'oldSwipeRestored':True,'failedRequests':23,'deletionRollsBack':True,'nativeChatSaves':saves,'reload':True,'freshBrowserNoIndexedDB':True,'paidCalls':0,'userWrites':0,'browserErrors':errors}),flush=True)
    finally:
        browser.close()
