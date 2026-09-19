"""Actual bundled ONNX model + real DOM + mocked paid API. No listening server process."""
import json
import mimetypes
import pathlib
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results'
OUT.mkdir(exist_ok=True)
calls=[]
external=[]
MOCK_API="""
export const model_list=[{id:'fixture-large'},{id:'fixture-mini'}];
export const getChatCompletionModel=s=>s.custom_model;
export async function createGenerationParameters(s,model,type,messages){return {generate_data:{model,messages,type,max_tokens:s.openai_max_tokens,stream:s.stream_openai,custom_url:s.custom_url,chat_completion_source:s.chat_completion_source}};}
"""
def route_request(route):
    req=route.request
    url=urlparse(req.url)
    path=url.path
    if url.hostname!='folio.test':
        external.append(req.url);route.abort();return
    if path=='/scripts/openai.js':
        route.fulfill(status=200,body=MOCK_API,content_type='text/javascript');return
    if path=='/scripts/extensions.js':
        route.fulfill(status=200,body="export const extensionNames=globalThis.folioFixtureConflicts??[];export async function disableExtension(name){window.testDisabled=[name];}",content_type='text/javascript');return
    if path=='/api/backends/chat-completions/generate':
        body=req.post_data_json
        calls.append(body)
        assert body['model'] in ('fixture-mini','fixture-summary','fixture-extract')
        assert body['stream'] is False
        assert body['custom_url']=='https://existing-provider.invalid/v1'
        data=json.loads(body['messages'][-1]['content'])
        if 'catalogue' in data:
            ids=[e['id'] for e in data['catalogue'] if '藍色' in e['summary'] or '冬天' in e['summary']][:2]
            answer={'ids':ids}
        else:
            answer={'summary':data['text'][:180]}
        route.fulfill(status=200,body=json.dumps({'choices':[{'message':{'content':json.dumps(answer,ensure_ascii=False)}}]}),content_type='application/json');return
    relative=path.removeprefix('/folio/') if path.startswith('/folio/') else path.lstrip('/')
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
        page=context.new_page()
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.goto('http://folio.test/tests/fixture.html')
        page.wait_for_function('window.fixtureReady===true')
        # Exercise true HTTP (not secure context), IndexedDB and the shipped model.
        inference=page.evaluate("""async()=>{
          const {Cache}=await import('/folio/src/store.js');const {Embedder}=await import('/folio/src/embedding.js');
          const {cosine}=await import('/folio/src/core.js');const cache=new Cache('folio-model-test');const embed=new Embedder(cache);
          try {const start=performance.now();const v=await embed.embed(['船長在港口碼頭等待來信。','航海的人正在碼頭等一封信。','晚飯吃了一碗牛肉麵。']);
          return {dim:v[0].length,norm:Math.hypot(...v[0]),related:cosine(v[0],v[1]),unrelated:cosine(v[0],v[2]),ms:performance.now()-start,secure:window.isSecureContext};}
          finally{embed.stop();cache.close();}
        }""")
        assert inference['dim']==512 and abs(inference['norm']-1)<0.001,inference
        assert inference['related']>inference['unrelated'],inference
        print(json.dumps({'real_inference':inference}),flush=True)
        page.wait_for_function('testContext.chat.filter(m=>!m.is_user).every(m=>m.extra.folio_memory?.done)',timeout=120000)
        assert len([c for c in calls if 'text' in json.loads(c['messages'][-1]['content'])])==3,len(calls)
        assert page.evaluate('testContext.chatCompletionSettings.custom_model')=='fixture-large'
        assert not page.evaluate('JSON.stringify(testContext.chat.map(m=>m.extra.folio_memory)).includes("不應被保存的推理")')
        page.locator('#folio-wand').click()
        page.get_by_role('tab',name='書頁目錄').click()
        page.locator('.folio-page-link').first.click()
        page.locator('.folio-dialog').screenshot(path=str(OUT/'desktop.png'))
        page.set_viewport_size({'width':390,'height':844})
        page.locator('.folio-dialog').screenshot(path=str(OUT/'mobile.png'))
        assert page.locator('.folio-dialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        page.get_by_role('searchbox').fill('藍色')
        assert page.locator('.folio-page-link').count()==1
        page.get_by_role('searchbox').fill('')
        page.get_by_role('button',name='關閉',exact=True).click()
        before=len(calls)
        page.reload();page.wait_for_function('window.fixtureReady===true')
        page.wait_for_timeout(4000)
        assert len(calls)==before,'reopen must not regenerate summaries'
        # Shrink context to require history selection; keep latest user and real bodies.
        selected=page.evaluate("""async()=>{
          const original=JSON.stringify(testContext.chat);const core=structuredClone(testContext.chat);let aborted=false;
          await folioIntercept(core,520,()=>{aborted=true;},'normal');
          return {count:core.length,latest:core.at(-1).mes,unchanged:JSON.stringify(testContext.chat)===original,aborted,bodies:core.map(m=>m.mes)};
        }""")
        assert selected['unchanged'] and not selected['aborted'],selected
        assert selected['latest']=='我還欠船長什麼約定？',selected
        assert selected['count']<7,selected
        # Pause cancels background work; no orphan worker/server at shutdown.
        page.locator('#folio-wand').click()
        page.get_by_role('tab',name='記憶助手').click()
        page.get_by_label('總結模型名稱',exact=True).fill('fixture-summary')
        page.get_by_role('button',name='保存總結模型',exact=True).click()
        page.get_by_label('提取模型名稱',exact=True).fill('fixture-extract')
        page.get_by_role('button',name='保存提取模型',exact=True).click()
        page.get_by_role('button',name='測試總結模型',exact=True).click()
        page.wait_for_function("document.querySelectorAll('.folio-connection-result')[0].textContent.includes('測試通過')")
        assert calls[-1]['model']=='fixture-summary'
        page.get_by_role('button',name='測試提取模型',exact=True).click()
        page.wait_for_function("document.querySelectorAll('.folio-connection-result')[1].textContent.includes('測試通過')")
        assert calls[-1]['model']=='fixture-extract'
        page.locator('.folio-content').evaluate('(e)=>e.scrollTop=0')
        page.locator('.folio-dialog').screenshot(path=str(OUT/'models-mobile.png'))
        page.set_viewport_size({'width':1100,'height':950})
        page.locator('.folio-content').evaluate('(e)=>e.scrollTop=0')
        page.locator('.folio-dialog').screenshot(path=str(OUT/'models-desktop.png'))
        # Actual IndexedDB reconciliation, stale trace invalidation, and source floor shift.
        page.evaluate("testContext.chat.splice(0,2);events.emit('MESSAGE_DELETED');testContext.saveChat();")
        page.get_by_role('tab',name='本次取用',exact=True).click()
        assert page.locator('.folio-view:not([hidden])').inner_text().find('失效')>=0
        page.get_by_role('tab',name='書頁目錄',exact=True).click()
        assert page.locator('.folio-page-link').count()==2
        page.get_by_role('button',name='關閉',exact=True).click()
        before=len(calls);page.reload();page.wait_for_function('window.fixtureReady===true');page.wait_for_timeout(2500)
        assert len(calls)==before,'deletion/reload must not regenerate unaffected pages'
        page.locator('#folio-wand').click();page.get_by_role('tab',name='記憶助手',exact=True).click()
        assert page.get_by_label('總結模型名稱',exact=True).input_value()=='fixture-summary'
        assert page.get_by_label('提取模型名稱',exact=True).input_value()=='fixture-extract'
        page.get_by_role('checkbox',name='自動記憶').uncheck()
        page.evaluate("testContext.chat.push({mes:'新故事。',name:'角色',is_user:false,send_date:'later',extra:{}});events.emit('MESSAGE_RECEIVED');")
        before=len(calls);page.wait_for_timeout(2300);assert len(calls)==before
        page.evaluate("localStorage.removeItem('folio-fixture-settings')")
        conflict_page=context.new_page()
        conflict_page.add_init_script("window.folioFixtureConflicts=['third-party/Anima-Memory-System'];")
        conflict_page.goto('http://folio.test/tests/fixture.html')
        conflict_page.locator('#folio-wand').click()
        conflict_page.get_by_role('button',name='改用書頁（停用 Anima 並刷新）').wait_for(state='visible')
        before=len(calls);conflict_page.wait_for_timeout(2500);assert len(calls)==before
        conflict_page.get_by_role('button',name='改用書頁（停用 Anima 並刷新）').click()
        conflict_page.wait_for_function("window.testDisabled?.[0]==='third-party/Anima-Memory-System'")
        conflict_page.close()
        assert not external,external
        assert not errors,errors
        result={'passed':True,'model':inference,'summaries':3,'total_api_requests':len(calls),'selected_count':selected['count'],'conflict_takeover':True,'external_requests':len(external),'browser_errors':errors}
        print(json.dumps(result,ensure_ascii=False),flush=True)
    finally:
        browser.close()
