"""Automatic vector repair, persistent hydration, rebuild scope and synthetic LLMs."""
import json
import mimetypes
import pathlib
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)
calls = []

def handle(route):
    req = route.request
    parsed = urlparse(req.url)
    path = parsed.path
    if parsed.hostname != 'folio.test':
        route.abort(); return
    if path == '/scripts/openai.js':
        route.fulfill(content_type='text/javascript', body="export const getChatCompletionModel=s=>s.custom_model;export const model_list=[];export async function createGenerationParameters(s,model,type,messages){return {generate_data:{model,messages,type,stream:false}};}"); return
    if path == '/scripts/extensions.js':
        route.fulfill(content_type='text/javascript', body='export const extensionNames=[];'); return
    if path == '/api/backends/chat-completions/generate':
        data = req.post_data_json
        calls.append(data)
        text = json.loads(data['messages'][-1]['content'])['text']
        answer = {'title': '測試書頁 ' + str(len(calls)), 'summary': text[:180]}
        route.fulfill(content_type='application/json', body=json.dumps({'choices': [{'message': {'content': json.dumps(answer, ensure_ascii=False)}}]})); return
    relative = path.removeprefix('/folio/') if path.startswith('/folio/') else path.lstrip('/')
    file = (ROOT / relative).resolve()
    if file.is_relative_to(ROOT) and file.is_file():
        mime = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream'}.get(file.suffix, mimetypes.guess_type(str(file))[0] or 'text/plain')
        route.fulfill(body=file.read_bytes(), content_type=mime); return
    route.fulfill(status=404, body='not found')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        context = browser.new_context(viewport={'width': 1280, 'height': 1000})
        context.route('**/*', handle)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://folio.test/tests/fixture.html')
        page.wait_for_function('window.fixtureReady===true')
        page.evaluate("""async()=>{
          const {bookPages,newRecord,KEY}=await import('/folio/src/core.js');
          for(const m of testContext.chat.slice(0,4))m.is_system=true;
          const p=bookPages(testContext.chat)[2],r=newRecord(p.message,p.playerInput);
          Object.assign(r,{summary:'手動編輯、必須保留的目錄',title:'人工摘要',parts:['手動編輯、必須保留的目錄'],done:true,edited:true,pinned:true});
          p.message.extra[KEY]=r;window.contentOf=m=>{const r=m.extra.folio_memory;return JSON.stringify([m.mes,m.is_system,r.summary,r.title,r.parts,r.edited,r.pinned,r.model,r.updatedAt]);};window.preserved=contentOf(p.message);window.source=JSON.stringify(testContext.chat.map(m=>[m.mes,m.is_system]));
          await testContext.saveChat();await events.emit('CHAT_CHANGED');
        }""")
        page.wait_for_timeout(2200)
        assert not calls
        page.locator('#folio-wand').click()
        run = page.locator('#folio-view-run')
        page.wait_for_function("document.querySelector('[aria-label=本機向量]').getAttribute('aria-valuenow')==='1'", timeout=60000)
        assert '全部重做：3 頁' in run.inner_text()
        assert '僅補未整理：2 頁（缺摘要 2 頁、只缺向量 0 頁）' in run.inner_text()
        assert run.get_by_role('button', name='補齊本機向量', exact=True).is_disabled()
        assert '包含 2 頁隱藏正文' in run.inner_text()
        missing = run.get_by_role('button', name='一鍵整理未整理的', exact=True)
        page.evaluate("events.emit('GENERATION_STARTED')")
        missing.click()
        assert '只整理未整理的摘要／向量' in run.inner_text()
        run.get_by_role('button', name='取消排隊', exact=True).click()
        page.evaluate("events.emit('GENERATION_ENDED')")
        page.wait_for_timeout(500)
        assert not calls
        page.get_by_role('tab', name='書頁目錄', exact=True).click()
        page.get_by_label('搜尋書頁').fill('這個搜尋完全不匹配')
        assert page.locator('.folio-page-link').count() == 0
        pages = page.locator('#folio-view-pages')
        pages.get_by_role('button', name='一鍵整理未整理的', exact=True).click()
        try:
            page.wait_for_function("[...document.querySelectorAll('.folio-rebuild-status')].some(e=>e.textContent.includes('摘要 2/2')&&e.textContent.includes('向量 2/2')&&e.textContent.includes('已完成'))", timeout=60000)
        except Exception:
            print(json.dumps({'mockCalls': len(calls), 'status': page.locator('.folio-status').inner_text(), 'warning': page.locator('.folio-warning').all_text_contents(), 'progress': page.locator('.folio-rebuild-status').all_text_contents(), 'errors': errors}, ensure_ascii=True), flush=True)
            raise
        assert len(calls) == 2
        assert page.evaluate('contentOf(testContext.chat[5])===preserved')
        assert page.evaluate('JSON.stringify(testContext.chat.map(m=>[m.mes,m.is_system]))===source')
        assert pages.get_by_role('button', name='一鍵整理未整理的', exact=True).is_disabled()
        page.get_by_label('搜尋書頁').fill('')
        assert page.locator('.folio-page-link').count() == 3
        assert '聊天第 2 則 · 隱藏正文' in page.locator('.folio-page-link').first.inner_text()
        pages.get_by_role('button', name='一鍵重新整理全部', exact=True).click()
        page.wait_for_function("[...document.querySelectorAll('.folio-rebuild-status')].some(e=>e.textContent.includes('摘要 3/3')&&e.textContent.includes('向量 3/3')&&e.textContent.includes('已完成'))", timeout=90000)
        assert len(calls) == 5
        assert page.evaluate('contentOf(testContext.chat[5])!==preserved')
        assert page.evaluate('JSON.stringify(testContext.chat.map(m=>[m.mes,m.is_system]))===source')
        page.get_by_role('tab', name='運行', exact=True).click()
        page.wait_for_function("document.querySelector('.folio-auto-popup').hidden", timeout=10000)
        page.locator('.folio-dialog').screenshot(path=str(OUT / 'scope-desktop.png'))
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('#folio-view-run .folio-rebuild').scroll_into_view_if_needed()
        assert page.locator('.folio-content').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        page.locator('.folio-dialog').screenshot(path=str(OUT / 'scope-mobile.png'))
        page.reload()
        page.wait_for_function('window.fixtureReady===true')
        page.locator('#folio-wand').click()
        page.wait_for_function("document.querySelector('[aria-label=本機向量]').getAttribute('aria-valuenow')==='3'")
        assert run.get_by_role('button', name='補齊本機向量', exact=True).is_disabled()
        # Clear only this isolated test browser's vector cache, not summaries.
        before_repair = page.evaluate('JSON.stringify(testContext.chat.map(m=>m.extra.folio_memory?.summary))')
        page.evaluate("""async()=>{
          const {Cache}=await import('/folio/src/store.js');const c=new Cache(),db=await c.open();
          await new Promise((resolve,reject)=>{const tx=db.transaction('vectors','readwrite');tx.objectStore('vectors').clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});c.close();
        }""")
        page.reload()
        page.wait_for_function('window.fixtureReady===true')
        page.locator('#folio-wand').click()
        page.wait_for_function("document.querySelector('[aria-label=本機向量]').getAttribute('aria-valuenow')==='3'", timeout=60000)
        assert '缺摘要 0 頁、只缺向量 0 頁' in run.inner_text()
        assert run.get_by_role('button', name='補齊本機向量', exact=True).is_disabled()
        assert run.get_by_role('button', name='一鍵整理未整理的', exact=True).is_disabled()
        page.get_by_role('tab', name='書頁目錄', exact=True).click()
        page.get_by_label('篩選書頁').select_option('pending')
        assert page.locator('.folio-page-link').count() == 0
        page.get_by_role('tab', name='運行', exact=True).click()
        assert page.evaluate('JSON.stringify(testContext.chat.map(m=>m.extra.folio_memory?.summary))') == before_repair
        assert len(calls) == 5
        page.locator('.folio-dialog').screenshot(path=str(OUT / 'vectors-repaired-mobile.png'))
        page.reload()
        page.wait_for_function('window.fixtureReady===true')
        page.locator('#folio-wand').click()
        page.wait_for_function("document.querySelector('[aria-label=本機向量]').getAttribute('aria-valuenow')==='3'")
        assert len(calls) == 5
        assert not errors, errors
        print(json.dumps({'passed': True, 'missingCalls': 2, 'allCalls': 3, 'vectorRepairCalls': 0, 'automaticVectorRepair': True, 'realVectorsRestoredOnReload': 3, 'hiddenIncluded': True, 'manualSummaryPreservedByMissing': True, 'searchDoesNotLimitScope': True, 'pendingClearedAfterAutomaticRepair': True, 'reloadNoRepeat': True, 'browserErrors': errors}), flush=True)
    finally:
        browser.close()
