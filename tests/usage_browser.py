"""Dashboard and immutable sent receipts: real DOM/IndexedDB, synthetic requests, no paid API."""
import json
import mimetypes
import pathlib
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results'
OUT.mkdir(exist_ok=True)
unexpected=[]

def route_request(route):
    req=route.request
    url=urlparse(req.url)
    if url.hostname!='folio.test' or req.method!='GET':
        unexpected.append(url.path);route.abort();return
    if url.path=='/scripts/extensions.js':
        route.fulfill(status=200,body='export const extensionNames=[];',content_type='text/javascript');return
    relative=url.path.removeprefix('/folio/') if url.path.startswith('/folio/') else url.path.lstrip('/')
    file=(ROOT/relative).resolve()
    if file.is_relative_to(ROOT) and file.is_file():
        mime={'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.onnx':'application/octet-stream'}.get(file.suffix,mimetypes.guess_type(str(file))[0] or 'text/plain')
        route.fulfill(status=200,body=file.read_bytes(),content_type=mime);return
    route.fulfill(status=404,body='not found')

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    try:
        context=browser.new_context(viewport={'width':1100,'height':950})
        context.route('**/*',route_request)
        context.add_init_script("if(!localStorage.getItem('folio-fixture-settings'))localStorage.setItem('folio-fixture-settings',JSON.stringify({folio:{enabled:false,account:'usage-fixture'}}));")
        page=context.new_page();errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://folio.test/tests/fixture.html');page.wait_for_function('window.fixtureReady===true')
        page.locator('#folio-wand').click()
        assert page.get_by_role('progressbar',name='摘要目錄',exact=True).get_attribute('aria-valuenow')=='0'
        page.get_by_role('tab',name='本次取用',exact=True).click()
        assert '尚無發送取用紀錄' in page.locator('#folio-view-selection').inner_text()
        assert page.locator('#folio-view-selection textarea').count()==0
        assert page.get_by_role('button',name='試跑選頁',exact=False).count()==0
        page.evaluate("""async()=>{
          const {newRecord,bookPages,KEY}=await import('/folio/src/core.js');
          for(const p of bookPages(testContext.chat)){const r=newRecord(p.message,p.playerInput);r.summary=p.body;r.title=['藍色信件的約定','碼頭道別','銀色鑰匙'][p.number-1];r.done=true;p.message.extra[KEY]=r;}
          await testContext.saveChat();await events.emit('CHAT_CHANGED');
        }""")
        switch=page.get_by_role('switch',name='自動記憶');assert switch.is_checked()==False
        assert page.locator('.folio-toggle-state').inner_text()=='已關閉'
        switch.focus();page.keyboard.press('Space');assert switch.is_checked()
        assert page.locator('.folio-toggle-state').inner_text()=='已開啟'
        page.get_by_role('tab',name='運行',exact=True).click()
        page.wait_for_function("document.querySelector('[aria-label=本機向量]').getAttribute('aria-valuenow')==='3'",timeout=120000)
        assert page.get_by_role('progressbar',name='摘要目錄',exact=True).get_attribute('aria-valuetext')=='3 / 3 頁，100%'
        page.evaluate("""async()=>{
          const core=structuredClone(testContext.chat);await folioIntercept(core,10000,()=>{throw Error('aborted');},'normal');
          // Simulate host cropping one original body. Uncertain content must not be labelled used.
          await events.emit('CHAT_COMPLETION_SETTINGS_READY',{type:'normal',messages:core.filter((m,i)=>i!==3).map(m=>({role:m.is_user?'user':'assistant',content:m.mes}))});
          await events.emit('GENERATION_ENDED');
        }""")
        page.wait_for_function("document.querySelector('.folio-recent-count')?.textContent==='2 頁正文 · 4 則玩家背景'")
        page.locator('.folio-content').evaluate('(e)=>e.scrollTop=0')
        page.locator('.folio-dialog').screenshot(path=str(OUT/'dashboard-desktop.png'))
        page.set_viewport_size({'width':390,'height':844})
        page.locator('.folio-dialog').screenshot(path=str(OUT/'dashboard-mobile.png'))
        assert page.locator('.folio-content').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        page.get_by_role('button',name='查看發送紀錄',exact=True).click()
        assert page.locator('#folio-view-selection').get_by_text('已核對取用：2 頁正文、4 則玩家背景',exact=True).is_visible()
        assert not page.locator('.folio-uncertain').get_attribute('open')
        # Append and delete the generated latest response: latest receipt remains the same.
        old_text=page.locator('.folio-usage-bar select').inner_text()
        page.evaluate("testContext.chat.push({mes:'合成最新回覆',is_user:false,name:'船長',send_date:'new',extra:{}});events.emit('MESSAGE_RECEIVED');testContext.chat.pop();events.emit('MESSAGE_DELETED');testContext.saveChat();")
        assert page.locator('.folio-usage-bar select').inner_text()==old_text
        # Delete a used source pair and confirm shifted surviving positions never relabel the source.
        page.evaluate("testContext.chat.splice(0,2);events.emit('MESSAGE_DELETED');testContext.saveChat();")
        page.wait_for_function("document.querySelector('.folio-source-missing')?.textContent==='來源已刪除或變更'")
        assert page.locator('.folio-usage-item').filter(has_text='藍色信件的約定').count()==1
        page.get_by_role('button',name='關閉',exact=True).click();page.reload();page.wait_for_function('window.fixtureReady===true')
        page.locator('#folio-wand').click();page.get_by_role('tab',name='本次取用',exact=True).click()
        page.wait_for_function("document.querySelector('.folio-source-missing')?.textContent==='來源已刪除或變更'")
        assert page.locator('.folio-usage-bar select').inner_text()==old_text
        page.locator('.folio-content').evaluate('(e)=>e.scrollTop=0')
        page.locator('.folio-dialog').screenshot(path=str(OUT/'usage-deleted-mobile.png'))
        page.set_viewport_size({'width':1100,'height':950})
        page.locator('.folio-dialog').screenshot(path=str(OUT/'usage-deleted-desktop.png'))
        # Pending new selection must leave latest sent record visible. Final observation adds a new one.
        page.evaluate("""async()=>{window.nextCore=structuredClone(testContext.chat);await folioIntercept(nextCore,10000,()=>{throw Error('abort');},'normal');}""")
        assert page.locator('.folio-usage-bar select option').count()==1
        assert page.locator('.folio-source-missing').count()==2
        page.evaluate("events.emit('CHAT_COMPLETION_SETTINGS_READY',{type:'normal',messages:nextCore.map(m=>({role:m.is_user?'user':'assistant',content:m.mes}))});")
        page.wait_for_function("document.querySelectorAll('.folio-usage-bar select option').length===2")
        assert page.locator('.folio-source-missing').count()==0
        page.get_by_label('發送紀錄',exact=True).select_option(index=1)
        assert page.locator('.folio-source-missing').count()==2
        # Atomic read/merge/write across two real IndexedDB connections.
        concurrent=page.evaluate("""async()=>{
          const {Cache}=await import('/folio/src/store.js');const a=new Cache('folio-usage-concurrent'),b=new Cache('folio-usage-concurrent');
          const record=id=>({id,stage:'observed',final:{observedAt:1},items:[]});
          try{await Promise.all([a.appendUsage('chat',[record('a')]),b.appendUsage('chat',[record('b')])]);return (await a.get('records','usage:chat')).map(x=>x.id).sort();}
          finally{a.close();b.close();}
        }""")
        assert concurrent==['a','b'],concurrent
        page.evaluate("testContext.chat.splice(0);events.emit('MESSAGE_DELETED');")
        page.get_by_role('tab',name='運行',exact=True).click()
        assert page.get_by_role('progressbar',name='摘要目錄',exact=True).get_attribute('aria-valuetext')=='尚無正文'
        assert page.locator('.folio-dial-number strong').first.inner_text()=='—'
        assert not errors,errors
        assert not unexpected,unexpected
        print(json.dumps({'passed':True,'paid_calls':0,'journal_reload_and_deletion':True,'history_switching':True,'concurrent_idb_append':True,'browser_errors':errors}),flush=True)
    finally:
        browser.close()
