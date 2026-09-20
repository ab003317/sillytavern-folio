"""Real index event wiring, cancellation at each stage, IndexedDB rollback; mock API only."""
import json
import mimetypes
import pathlib
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results'
OUT.mkdir(exist_ok=True)
calls=[]

def handle(route):
    req=route.request;parsed=urlparse(req.url);path=parsed.path
    if parsed.hostname!='folio.test':route.abort();raise AssertionError('Unexpected external request')
    if path=='/scripts/openai.js':
        route.fulfill(content_type='text/javascript',body="export const getChatCompletionModel=s=>s.custom_model;export const model_list=[];export async function createGenerationParameters(s,model,type,messages){return {generate_data:{model,messages,type,stream:false}};}");return
    if path=='/scripts/extensions.js':route.fulfill(content_type='text/javascript',body='export const extensionNames=[];');return
    if path=='/api/backends/chat-completions/generate':
        calls.append(req.post_data_json)
        answer={'title':'生命週期測試','summary':'第 '+str(len(calls))+' 次：船長交付信件，旅人答應送到山城。'}
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
        page.locator('#folio-wand').click()
        run=page.locator('#folio-view-run');popup=page.locator('.folio-auto-popup')
        rebuild=lambda:run.get_by_role('button',name='一鍵重新整理全部',exact=True)
        complete="[...document.querySelectorAll('.folio-rebuild-status')].some(e=>e.textContent.includes('摘要 3/3')&&e.textContent.includes('向量 3/3')&&e.textContent.includes('已完成'))"
        page.evaluate("async()=>{await events.emit('GENERATION_STARTED','normal',{},true);await events.emit('GENERATION_STARTED','quiet',{},false);}")
        assert '目前正在生成回覆' not in run.locator('.folio-rebuild').inner_text()
        rebuild().click();page.wait_for_function(complete,timeout=90000)
        assert len(calls)==3, 'Dry-run must not require a new real reply to release the rebuild'
        original=page.evaluate('JSON.stringify(testContext.chat)')
        # A waiting request has both an in-panel and a popup cancellation button.
        page.evaluate("events.emit('GENERATION_STARTED','normal',{},false)");rebuild().click()
        assert run.get_by_role('button',name='取消排隊',exact=True).is_visible()
        assert popup.get_by_role('button',name='取消排隊',exact=True).is_visible()
        assert not popup.get_by_role('progressbar').is_visible(), 'A queued job must not show the previous completion as its own progress'
        popup.screenshot(path=str(OUT/'lifecycle-queued-desktop.png'))
        page.set_viewport_size({'width':390,'height':844});popup.screenshot(path=str(OUT/'lifecycle-queued-mobile.png'))
        assert popup.evaluate('(e)=>e.getBoundingClientRect().left>=0&&e.getBoundingClientRect().right<=innerWidth')
        popup.get_by_role('button',name='取消排隊',exact=True).click()
        assert rebuild().is_enabled() and page.evaluate('window.fixtureGenerating')
        assert not popup.is_visible(), 'Old completion receipt must not masquerade as a newly cancelled queue'
        page.evaluate("events.emit('GENERATION_ENDED')");page.wait_for_timeout(2100)
        assert len(calls)==3 and page.evaluate('JSON.stringify(testContext.chat)')==original
        # Missing END event is reconciled against actual host idle state, not a guessed timeout.
        page.evaluate("events.emit('GENERATION_STARTED','normal',{},false)");rebuild().click()
        page.evaluate('window.fixtureGenerating=false')
        page.wait_for_function("!document.querySelector('#folio-view-run .folio-rebuild .folio-primary').textContent.includes('已排隊')",timeout=10000)
        page.wait_for_function(complete,timeout=90000);assert len(calls)==6
        # Cancel while a response is in flight. It deliberately ignores AbortSignal until released.
        original=page.evaluate('JSON.stringify(testContext.chat.map(m=>m.extra?.folio_memory?.summary))')
        page.evaluate("""()=>{const fetchOriginal=window.fetch;window.holdNext=true;window.fetch=async(...args)=>{const response=await fetchOriginal(...args);if(window.holdNext&&String(args[0]).endsWith('/generate')){window.holdNext=false;return new Promise(resolve=>window.releaseLate=()=>resolve(response));}return response;};}""")
        rebuild().click();page.wait_for_function('!!window.releaseLate')
        popup.get_by_role('button',name='停止本次重整',exact=True).click()
        assert popup.get_by_role('button',name='正在停止…',exact=True).is_disabled()
        popup.screenshot(path=str(OUT/'lifecycle-stopping-mobile.png'))
        page.evaluate('releaseLate()')
        page.wait_for_function("document.querySelector('.folio-status').textContent.includes('本次重整已停止')")
        page.wait_for_timeout(2100)
        assert len(calls)==7 and page.evaluate('JSON.stringify(testContext.chat.map(m=>m.extra?.folio_memory?.summary))')==original
        assert page.get_by_role('switch',name='新回覆自動記憶',exact=True).is_checked()
        # Cancel during the IndexedDB write, before the chat has been replaced.
        page.evaluate("""async()=>{const {Cache}=await import('/folio/src/store.js');const put=Cache.prototype.putMany;let first=true;Cache.prototype.putMany=async function(...args){await put.apply(this,args);if(first){first=false;await new Promise(resolve=>window.releaseSetup=resolve);}};}""")
        rebuild().click();page.wait_for_function('!!window.releaseSetup')
        assert popup.get_by_role('button',name='停止本次重整',exact=True).is_enabled()
        popup.get_by_role('button',name='停止本次重整',exact=True).click()
        page.evaluate('releaseSetup()')
        page.wait_for_function("document.querySelector('.folio-status').textContent.includes('本次重整已停止')")
        assert len(calls)==7
        assert page.locator('.folio-content').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        page.reload();page.wait_for_function('window.fixtureReady===true');page.locator('#folio-wand').click();page.wait_for_timeout(2100)
        assert len(calls)==7 and page.evaluate('JSON.stringify(testContext.chat.map(m=>m.extra?.folio_memory?.summary))')==original
        assert rebuild().is_enabled()
        assert not errors,errors
        print(json.dumps({'passed':True,'dryRunDoesNotBlock':True,'queuedCancelKeepsMainReply':True,'missingEndRecovered':True,'lateCancelledResultDiscarded':True,'setupCancelRolledBack':True,'reloadNoRevival':True,'mockCalls':len(calls),'paidCalls':0,'browserErrors':errors}),flush=True)
    finally:browser.close()
