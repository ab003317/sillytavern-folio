"""Provider form, key isolation and race checks. Mock API only, no server process."""
import json
import mimetypes
import pathlib
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results'
OUT.mkdir(exist_ok=True)
calls=[]
external=[]

def route_request(route):
    req=route.request
    parsed=urlparse(req.url)
    if parsed.hostname!='folio.test':
        external.append(req.url);route.abort();return
    path=parsed.path
    if path=='/scripts/openai.js':
        route.fulfill(content_type='text/javascript',body="export const model_list=[{id:'fixture-mini'}];export const getChatCompletionModel=s=>s.custom_model;");return
    if path=='/scripts/extensions.js':
        route.fulfill(content_type='text/javascript',body='export const extensionNames=[];');return
    if path.startswith('/api/backends/chat-completions/'):
        data=req.post_data_json
        calls.append(data)
        if path.endswith('/status'):
            if 'bad.invalid' in data.get('custom_url',''):
                route.fulfill(status=401,body='fixture-key-MUST-NOT-LEAK');return
            route.fulfill(content_type='application/json',body=json.dumps({'data':[{'id':'fixture-summary'},{'id':'fixture-extract'}]}));return
        prompt=json.loads(data['messages'][-1]['content'])
        answer={'ids':['letter']} if 'catalogue' in prompt else {'summary':'船長交付藍色信件，約定冬天前送到山城。'}
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
        context=browser.new_context(viewport={'width':1300,'height':1050})
        context.route('**/*',route_request)
        context.add_init_script("""if(!localStorage.getItem('folio-fixture-settings'))localStorage.setItem('folio-fixture-settings',JSON.stringify({folio:{enabled:false,account:'api-fixture',helpers:{summary:{connection:'current',model:'existing-summary'},selection:{connection:'current',model:'existing-extract'}}}}));""")
        page=context.new_page()
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://folio.test/tests/fixture.html')
        page.wait_for_function('window.fixtureReady===true')
        page.locator('#folio-wand').click()
        page.get_by_role('tab',name='記憶助手').click()
        page.locator('summary').filter(has_text='不同 API 與模型').click()
        summary=page.locator('.folio-helper-section').nth(0)
        extraction=page.locator('.folio-helper-section').nth(1)
        assert page.locator('#folio-summary-source').input_value()=='saved'
        assert page.locator('#folio-summary-model').input_value()=='existing-summary'
        assert not page.locator('#folio-summary-url').is_visible()
        # All preset sources prefill their own URL; list requests stay on that source.
        for source in ['openai','claude','openrouter','google','mistral','deepseek','custom']:
            page.locator('#folio-summary-source').select_option(source)
            assert page.locator('#folio-summary-key').input_value()==''
            assert page.locator('#folio-summary-model').input_value()==''
            if source=='custom':page.locator('#folio-summary-url').fill('https://synthetic.invalid/v1/chat/completions')
            else:assert page.locator('#folio-summary-url').input_value().startswith('https://')
            page.locator('#folio-summary-key').fill('fixture-key-'+source)
            summary.get_by_role('button',name='取得模型列表',exact=True).click()
            page.wait_for_function("document.querySelectorAll('.folio-helper-section')[0].textContent.includes('取得 2 個模型')")
            assert page.locator('#folio-summary-model').input_value()==''
            assert page.evaluate('testContext.extensionSettings.folio.helpers.summary.model')=='existing-summary'
        # Picker/manual model, separate role keys, save without exposing the stored key.
        page.get_by_label('總結模型可選模型',exact=True).select_option('fixture-summary')
        summary.get_by_role('button',name='保存總結模型',exact=True).click()
        expect(summary.locator('.folio-api-feedback')).to_contain_text('已保存')
        assert page.locator('#folio-summary-url').input_value()=='https://synthetic.invalid/v1'
        assert page.locator('#folio-summary-key').input_value()=='fixture-key-custom'
        assert page.locator('#folio-summary-key').get_attribute('type')=='password'
        assert '已保存' in summary.locator('.folio-key-status').inner_text()
        assert summary.get_by_role('checkbox').count()==0
        summary.get_by_role('button',name='顯示或隱藏總結模型金鑰').click()
        assert page.locator('#folio-summary-key').get_attribute('type')=='text'
        assert page.locator('#folio-summary-key').input_value()=='fixture-key-custom'
        summary.get_by_role('button',name='顯示或隱藏總結模型金鑰').click()
        page.locator('#folio-selection-source').select_option('claude')
        page.locator('#folio-selection-key').fill('fixture-extract-key')
        page.locator('#folio-selection-model').fill('fixture-extract')
        extraction.get_by_role('button',name='保存提取模型',exact=True).click()
        expect(extraction.locator('.folio-api-feedback')).to_contain_text('已保存')
        summary.get_by_role('button',name='測試總結模型',exact=True).click()
        page.wait_for_function("document.querySelectorAll('.folio-connection-result')[0].textContent.includes('測試通過')")
        assert calls[-1]['model']=='fixture-summary'
        assert json.loads(calls[-1]['custom_include_headers'])['Authorization']=='Bearer fixture-key-custom'
        extraction.get_by_role('button',name='測試提取模型',exact=True).click()
        page.wait_for_function("document.querySelectorAll('.folio-connection-result')[1].textContent.includes('測試通過')")
        assert calls[-1]['chat_completion_source']=='claude' and calls[-1]['proxy_password']=='fixture-extract-key'
        page.locator('.folio-content').evaluate('(e)=>e.scrollTop=0')
        page.locator('.folio-dialog').screenshot(path=str(OUT/'api-desktop.png'))
        page.set_viewport_size({'width':390,'height':844})
        page.locator('.folio-content').evaluate('(e)=>e.scrollTop=0')
        page.locator('.folio-dialog').screenshot(path=str(OUT/'api-mobile.png'))
        assert page.locator('.folio-dialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        assert page.locator('.folio-content').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        page.reload();page.wait_for_function('window.fixtureReady===true')
        page.locator('#folio-wand').click();page.get_by_role('tab',name='記憶助手').click()
        page.locator('summary').filter(has_text='不同 API 與模型').click()
        assert page.locator('#folio-summary-source').input_value()=='custom'
        assert page.locator('#folio-selection-source').input_value()=='claude'
        assert page.locator('#folio-summary-key').input_value()=='fixture-key-custom'
        assert page.locator('#folio-summary-key').get_attribute('type')=='password'
        assert page.locator('#folio-summary-model').input_value()=='fixture-summary'
        page.locator('#folio-summary-key').scroll_into_view_if_needed()
        page.locator('.folio-dialog').screenshot(path=str(OUT/'saved-key-mobile.png'))
        summary.get_by_role('button',name='顯示或隱藏總結模型金鑰').click()
        assert page.locator('#folio-summary-key').get_attribute('type')=='text'
        page.get_by_role('button',name='關閉',exact=True).click()
        page.locator('#folio-wand').click()
        page.locator('summary').filter(has_text='不同 API 與模型').click()
        assert page.locator('#folio-summary-key').get_attribute('type')=='password'
        assert page.locator('#folio-summary-key').input_value()=='fixture-key-custom'
        # Clearing edits the draft only; saving a custom anonymous endpoint clears
        # the actual key, rather than invisibly restoring the old credential.
        summary.get_by_role('button',name='清空總結模型金鑰').click()
        assert page.evaluate('testContext.extensionSettings.folio.helpers.summary.apiKey')=='fixture-key-custom'
        summary.get_by_role('button',name='保存總結模型',exact=True).click()
        expect(summary.locator('.folio-api-feedback')).to_contain_text('已保存')
        assert page.evaluate('testContext.extensionSettings.folio.helpers.summary.apiKey')==''
        assert '免驗證' in summary.locator('.folio-key-status').inner_text()
        page.locator('#folio-summary-key').fill('fixture-key-custom')
        summary.get_by_role('button',name='保存總結模型',exact=True).click()
        expect(summary.locator('.folio-api-feedback')).to_contain_text('已保存')
        extraction.get_by_role('button',name='清空提取模型金鑰').click()
        extraction.get_by_role('button',name='保存提取模型',exact=True).click()
        assert '金鑰' in extraction.locator('.folio-api-feedback').inner_text()
        assert page.evaluate('testContext.extensionSettings.folio.helpers.selection.apiKey')=='fixture-extract-key'
        # Editing destination clears a typed key, and does NOT reuse the previously saved key.
        page.locator('#folio-summary-key').fill('draft-key')
        page.locator('#folio-summary-url').fill('https://different.invalid/v1')
        assert page.locator('#folio-summary-key').input_value()==''
        summary.get_by_role('button',name='取得模型列表',exact=True).click()
        page.wait_for_function("document.querySelectorAll('.folio-helper-section')[0].textContent.includes('取得 2 個模型')")
        assert json.loads(calls[-1]['custom_include_headers'])['Authorization']==''
        # HTTP errors never render echoed key; current working configuration remains saved.
        page.locator('#folio-summary-url').fill('https://bad.invalid/v1')
        page.locator('#folio-summary-key').fill('fixture-key-MUST-NOT-LEAK')
        summary.get_by_role('button',name='取得模型列表',exact=True).click()
        page.wait_for_function("document.querySelectorAll('.folio-helper-section')[0].textContent.includes('401')")
        assert 'fixture-key-MUST-NOT-LEAK' not in summary.inner_text()
        assert page.evaluate('testContext.extensionSettings.folio.helpers.summary.baseUrl')=='https://synthetic.invalid/v1'
        # Delayed list ignores cancellation: old reply must still be discarded after source change.
        page.evaluate("""()=>{window.originalFetch=window.fetch;window.fetch=(url,options)=>url.endsWith('/status')?new Promise(resolve=>window.releaseList=()=>resolve(new Response(JSON.stringify({data:[{id:'STALE-MODEL'}]}),{headers:{'Content-Type':'application/json'}}))):originalFetch(url,options);}""")
        summary.get_by_role('button',name='取得模型列表',exact=True).click()
        page.wait_for_function('!!window.releaseList')
        page.locator('#folio-summary-source').select_option('deepseek')
        page.evaluate('()=>{releaseList();window.fetch=window.originalFetch;}')
        assert page.locator('#folio-summary-models option').count()==0
        assert not page.get_by_label('總結模型可選模型',exact=True).is_visible()
        assert page.locator('#folio-summary-key').input_value()==''
        assert page.evaluate('testContext.chatCompletionSettings.custom_model')=='fixture-large'
        assert not external,external
        assert not errors,errors
        print(json.dumps({'passed':True,'sources':7,'listDoesNotSave':True,'roleKeyIsolation':True,'reload':True,'changedDestinationNoKeyReuse':True,'staleListDiscarded':True,'externalRequests':len(external),'browserErrors':errors}),flush=True)
    finally:
        browser.close()
