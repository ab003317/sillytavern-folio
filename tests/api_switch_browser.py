"""API source switch, effective vs saved configuration, actual mocked payloads and races."""
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
        route.abort(); raise AssertionError('Unexpected external request')
    if path == '/scripts/extensions.js':
        route.fulfill(content_type='text/javascript', body='export const extensionNames=[];'); return
    if path == '/scripts/openai.js':
        route.fulfill(content_type='text/javascript', body="export const model_list=[];export const getChatCompletionModel=s=>s.custom_model;export async function createGenerationParameters(s,model,type,messages){return {generate_data:{model,messages,type,stream:false,custom_url:s.custom_url,chat_completion_source:s.chat_completion_source}};}"); return
    if path == '/api/backends/chat-completions/generate':
        data = req.post_data_json
        calls.append(data)
        content = json.loads(data['messages'][-1]['content'])
        answer = {'ids': ['letter']} if 'catalogue' in content else {'title': '合成測試', 'summary': '船長請旅人冬天前送信到山城。'}
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
        context.add_init_script("""if(!localStorage.getItem('folio-fixture-settings'))localStorage.setItem('folio-fixture-settings',JSON.stringify({folio:{enabled:false,account:'switch-test',apiMode:'main',helpers:{summary:{connection:'direct',provider:'custom',baseUrl:'https://saved-summary.invalid/v1',apiKey:'synthetic-saved-key',model:'private-summary'},selection:{connection:'current',model:'private-selector'}}}}));""")
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://folio.test/tests/fixture.html')
        page.wait_for_function('window.fixtureReady===true')
        page.locator('#folio-wand').click()
        page.get_by_role('tab', name='記憶助手', exact=True).click()
        switch = page.get_by_role('switch', name='使用獨立 API', exact=True)
        summary = page.locator('.folio-active-helper[data-role=summary]')
        selection = page.locator('.folio-active-helper[data-role=selection]')
        assert not switch.is_checked()
        assert page.locator('.folio-api-current').inner_text() == '目前生效：酒館主 API'
        assert summary.locator('.folio-active-model').inner_text() == 'fixture-large'
        assert selection.locator('.folio-active-model').inner_text() == 'fixture-large'
        assert not page.locator('#folio-summary-source').is_visible()
        page.locator('.folio-dialog').screenshot(path=str(OUT / 'api-switch-main-desktop.png'))
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('.folio-dialog').screenshot(path=str(OUT / 'api-switch-main-mobile.png'))
        assert page.locator('.folio-content').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        page.set_viewport_size({'width': 1280, 'height': 1000})
        page.get_by_role('button', name='測試目前總結連線', exact=True).click()
        page.wait_for_function("document.querySelector('.folio-active-test-result').textContent.includes('測試通過')")
        assert calls[-1]['model'] == 'fixture-large'
        page.locator('summary').filter(has_text='不同 API 與模型').click()
        page.get_by_label('總結模型名稱', exact=True).fill('saved-summary-v2')
        assert page.get_by_role('button', name='測試總結模型', exact=True).is_disabled()
        page.get_by_role('button', name='測試目前總結連線', exact=True).click()
        page.wait_for_function("document.querySelector('.folio-active-test-result').textContent.includes('測試通過')")
        assert calls[-1]['model'] == 'fixture-large', 'Dirty drafts must not be silently saved/tested'
        page.get_by_role('button', name='保存總結模型', exact=True).click()
        assert not switch.is_checked()
        assert '已保存，尚未啟用' in page.locator('.folio-helper-section').first.inner_text()
        assert summary.locator('.folio-active-model').inner_text() == 'fixture-large'
        switch.check()
        assert page.locator('.folio-api-current').inner_text() == '目前生效：獨立 API 設定'
        assert summary.locator('.folio-active-model').inner_text() == 'saved-summary-v2'
        assert selection.locator('.folio-active-model').inner_text() == 'private-selector'
        assert '模型獨立指定' in selection.inner_text()
        page.get_by_role('button', name='測試目前總結連線', exact=True).click()
        page.wait_for_function("document.querySelector('.folio-active-test-result').textContent.includes('測試通過')")
        assert calls[-1]['model'] == 'saved-summary-v2'
        assert calls[-1]['custom_url'] == 'https://saved-summary.invalid/v1'
        assert json.loads(calls[-1]['custom_include_headers'])['Authorization'] == 'Bearer synthetic-saved-key'
        page.get_by_role('button', name='測試目前提取連線', exact=True).click()
        page.wait_for_function("document.querySelectorAll('.folio-active-test-result')[1].textContent.includes('測試通過')")
        assert calls[-1]['model'] == 'private-selector'
        # A mode switch cancels the old connection test even if transport ignores abort.
        page.evaluate("""()=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).endsWith('/generate'))return new Promise(resolve=>window.releaseTest=()=>{window.fetch=original;resolve(response);});return response;};}""")
        page.get_by_role('button', name='測試目前總結連線', exact=True).click()
        page.wait_for_function('!!window.releaseTest')
        switch.focus()
        page.keyboard.press('Space')
        assert not switch.is_checked()
        page.evaluate('releaseTest()')
        page.wait_for_function("[...document.querySelectorAll('.folio-active-test-result')].every(e=>!e.textContent)")
        assert summary.locator('.folio-active-model').inner_text() == 'fixture-large'
        page.evaluate("testContext.chatCompletionSettings.custom_model='changed-main';events.emit('CHATCOMPLETION_MODEL_CHANGED')")
        assert selection.locator('.folio-active-model').inner_text() == 'changed-main'
        page.get_by_role('button', name='測試目前提取連線', exact=True).click()
        page.wait_for_function("document.querySelectorAll('.folio-active-test-result')[1].textContent.includes('測試通過')")
        assert calls[-1]['model'] == 'changed-main'
        switch.check()
        page.get_by_role('button', name='關閉', exact=True).click()
        page.locator('#folio-wand').click()
        assert not page.locator('#folio-summary-source').is_visible()
        assert switch.is_checked() and summary.locator('.folio-active-model').inner_text() == 'saved-summary-v2'
        page.locator('.folio-content').evaluate('(e)=>e.scrollTop=0')
        page.locator('.folio-dialog').screenshot(path=str(OUT / 'api-switch-separate-desktop.png'))
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('.folio-dialog').screenshot(path=str(OUT / 'api-switch-separate-mobile.png'))
        assert page.locator('.folio-content').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        page.reload()
        page.wait_for_function('window.fixtureReady===true')
        page.locator('#folio-wand').click()
        page.get_by_role('tab', name='記憶助手', exact=True).click()
        assert switch.is_checked()
        assert summary.locator('.folio-active-model').inner_text() == 'saved-summary-v2'
        assert page.evaluate('testContext.extensionSettings.folio.helpers.summary.apiKey') == 'synthetic-saved-key'
        assert 'synthetic-saved-key' not in page.locator('.folio-dialog').inner_text()
        page.evaluate("testContext.extensionSettings.folio.helpers.summary.model='';events.emit('CONNECTION_PROFILE_LOADED')")
        assert '尚未填寫模型' in summary.inner_text()
        assert page.get_by_role('button', name='測試目前總結連線', exact=True).is_disabled()
        page.evaluate("events.emit('GENERATION_STARTED','normal',{},false)")
        assert switch.is_disabled()
        page.evaluate("events.emit('GENERATION_ENDED')")
        assert switch.is_enabled()
        assert len(calls) == 6
        assert not page.evaluate('testContext.chat.some(m=>m.extra.folio_memory)'), 'Mode changes must not process old chat'
        assert not errors, errors
        print(json.dumps({'passed': True, 'mockRequests': len(calls), 'switchMatchesRequestModel': True, 'draftDoesNotActivate': True, 'mainFollowsChange': True, 'keyAndModePersist': True, 'lateTestDiscarded': True, 'keyboardSwitch': True, 'oldChatCalls': 0, 'browserErrors': errors}), flush=True)
    finally:
        browser.close()
