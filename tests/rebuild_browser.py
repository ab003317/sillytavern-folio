"""Click actual rebuild controls with HTTP fixture, real IndexedDB/embedding and mock LLM."""
import json
import mimetypes
import pathlib
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results'
OUT.mkdir(exist_ok=True)
calls=[]
failure={'next':False}

def handle(route):
    req=route.request;parsed=urlparse(req.url);path=parsed.path
    if parsed.hostname!='folio.test':route.abort();return
    if path=='/scripts/openai.js':
        route.fulfill(content_type='text/javascript',body="export const getChatCompletionModel=s=>s.custom_model;export const model_list=[];export async function createGenerationParameters(s,model,type,messages){return {generate_data:{model,messages,type,stream:false}};}");return
    if path=='/scripts/extensions.js':route.fulfill(content_type='text/javascript',body='export const extensionNames=[];');return
    if path=='/api/backends/chat-completions/generate':
        data=req.post_data_json;calls.append(data)
        if failure['next']:
            failure['next']=False;route.fulfill(status=503,body='synthetic failure');return
        text=json.loads(data['messages'][-1]['content'])['text']
        answer={'title':'重整版本 '+str(len(calls)),'summary':'第 '+str(len(calls))+' 次整理：'+text[:150]}
        route.fulfill(content_type='application/json',body=json.dumps({'choices':[{'message':{'content':json.dumps(answer,ensure_ascii=False)}}]}));return
    relative=path.removeprefix('/folio/') if path.startswith('/folio/') else path.lstrip('/')
    file=(ROOT/relative).resolve()
    if file.is_relative_to(ROOT) and file.is_file():
        mime={'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.onnx':'application/octet-stream'}.get(file.suffix,mimetypes.guess_type(str(file))[0] or 'text/plain')
        route.fulfill(body=file.read_bytes(),content_type=mime);return
    route.fulfill(status=404,body='not found')

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    try:
        context=browser.new_context(viewport={'width':1280,'height':1000});context.route('**/*',handle)
        page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://folio.test/tests/fixture.html');page.wait_for_function('window.fixtureReady===true')
        page.wait_for_timeout(2300);assert len(calls)==0
        page.locator('#folio-wand').click();rebuild_all=page.get_by_role('button',name='一鍵重新整理全部',exact=True).first
        page.evaluate("events.emit('GENERATION_STARTED')");assert rebuild_all.is_enabled();rebuild_all.click()
        assert len(calls)==0
        assert page.get_by_role('button',name='已排隊，等待回覆完成',exact=True).first.is_disabled()
        popup=page.locator('.folio-auto-popup');assert popup.is_visible();assert '已排隊，等待回覆完成' in popup.inner_text()
        popup.screenshot(path=str(OUT/'rebuild-queued-desktop.png'))
        page.set_viewport_size({'width':390,'height':844})
        assert popup.evaluate('(e)=>e.getBoundingClientRect().left>=0 && e.getBoundingClientRect().right<=innerWidth')
        page.screenshot(path=str(OUT/'rebuild-queued-mobile.png'));page.set_viewport_size({'width':1280,'height':1000})
        page.evaluate("events.emit('GENERATION_ENDED')")
        page.wait_for_function("document.querySelector('.folio-auto-popup-title')?.textContent==='正在重新整理舊聊天'",timeout=10000)
        page.wait_for_function('testContext.chat.filter(m=>!m.is_user).every(m=>m.extra.folio_memory?.done)',timeout=90000)
        page.wait_for_function("document.querySelector('.folio-auto-popup-title')?.textContent==='舊聊天重新整理完成'",timeout=10000)
        assert len(calls)==3
        source=page.evaluate('JSON.stringify(testContext.chat.map(m=>m.mes))')
        page.get_by_label('新回覆自動記憶',exact=True).uncheck()
        page.get_by_role('tab',name='書頁目錄').click();page.locator('.folio-page-link').nth(2).click()
        old=page.locator('.folio-reader .folio-summary-text').inner_text()
        # Hold one model reply after transport, allowing inspection of pending UI and duplicate clicks.
        page.evaluate("""()=>{const original=window.fetch;window.holdRebuild=true;window.fetch=async(...args)=>{const response=await original(...args);if(window.holdRebuild&&String(args[0]).endsWith('/generate')){window.holdRebuild=false;return new Promise(resolve=>window.releaseRebuild=()=>resolve(response));}return response;};}""")
        page.get_by_role('button',name='重新整理此頁',exact=True).click()
        page.wait_for_function('!!window.releaseRebuild')
        assert len(calls)==4
        assert '銀色鑰匙' in json.loads(calls[-1]['messages'][-1]['content'])['text']
        assert page.get_by_role('button',name='正在重整此頁…',exact=True).is_disabled()
        assert not page.get_by_label('新回覆自動記憶',exact=True).is_checked()
        assert page.locator('.folio-reader .folio-summary-text').inner_text()==old
        page.locator('.folio-dialog').screenshot(path=str(OUT/'rebuild-pending-desktop.png'))
        page.evaluate('()=>{releaseRebuild();}')
        page.wait_for_function("document.querySelector('.folio-page-work').textContent.includes('已重新整理完成')",timeout=60000)
        assert page.locator('.folio-reader .folio-summary-text').inner_text()!=old
        assert len(calls)==4
        # Rebuild all: exactly three new calls, not a cache hit and not repeated on reload.
        page.get_by_role('button',name='一鍵重新整理全部',exact=True).click()
        page.wait_for_function("[...document.querySelectorAll('.folio-rebuild-status')].some(e=>e.textContent.includes('摘要 3/3')&&e.textContent.includes('向量 3/3')&&e.textContent.includes('已完成'))",timeout=90000)
        assert len(calls)==7
        assert page.evaluate('JSON.stringify(testContext.chat.map(m=>m.mes))')==source
        page.set_viewport_size({'width':390,'height':844});page.get_by_role('tab',name='運行',exact=True).click()
        page.locator('.folio-content').evaluate('(e)=>e.scrollTop=0');page.locator('.folio-dialog').screenshot(path=str(OUT/'rebuild-complete-mobile.png'))
        assert page.locator('.folio-content').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        page.reload();page.wait_for_function('window.fixtureReady===true');page.locator('#folio-wand').click()
        page.get_by_role('tab',name='書頁目錄').click();page.locator('.folio-page-link').first.click()
        assert len(calls)==7
        old=page.locator('.folio-reader .folio-summary-text').inner_text()
        failure['next']=True;page.get_by_role('button',name='重新整理此頁',exact=True).click()
        page.wait_for_function("document.querySelector('.folio-page-work').textContent.includes('等待重試')")
        assert page.locator('.folio-reader .folio-summary-text').inner_text()==old
        page.locator('#folio-view-pages').get_by_role('button',name='停止本次重整',exact=True).click()
        page.wait_for_function("[...document.querySelectorAll('.folio-rebuild-status')].some(e=>e.textContent.includes('已停止'))")
        assert page.locator('.folio-reader .folio-summary-text').inner_text()==old
        assert page.evaluate('testContext.chat[1].extra.folio_memory.done')
        assert not page.get_by_label('新回覆自動記憶',exact=True).is_checked()
        assert not errors,errors
        print(json.dumps({'passed':True,'actualSinglePageClick':True,'pausedManualWorks':True,'priorityLastPage':True,'allRebuiltCalls':3,'reloadNoRepeat':True,'failureKeepsOldSummary':True,'stopRestores':True,'totalMockCalls':len(calls),'browserErrors':errors}),flush=True)
    finally:browser.close()
