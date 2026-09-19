"""Visible automatic-work receipt, real DOM/IndexedDB/model, mocked paid API."""
import json
import mimetypes
import pathlib
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)
calls = []
held = []
control = {'hold_first': True, 'fail_next': False}

MOCK_API = """
export const model_list=[{id:'fixture-mini'}];
export const getChatCompletionModel=s=>s.custom_model;
export async function createGenerationParameters(s,model,type,messages){return {generate_data:{model,messages,type,max_tokens:s.openai_max_tokens,stream:s.stream_openai,custom_url:s.custom_url,chat_completion_source:s.chat_completion_source}};}
"""


def generation_reply(route, body):
    data = json.loads(body['messages'][-1]['content'])
    answer = {'summary': data.get('text', '')[:180] or '測試摘要'}
    route.fulfill(
        status=200,
        body=json.dumps({'choices': [{'message': {'content': json.dumps(answer, ensure_ascii=False)}}]}),
        content_type='application/json',
    )


def route_request(route):
    req = route.request
    url = urlparse(req.url)
    path = url.path
    if url.hostname != 'folio.test':
        route.abort()
        raise AssertionError(f'unexpected external request: {req.url}')
    if path == '/scripts/openai.js':
        route.fulfill(status=200, body=MOCK_API, content_type='text/javascript')
        return
    if path == '/scripts/extensions.js':
        route.fulfill(status=200, body='export const extensionNames=[];', content_type='text/javascript')
        return
    if path == '/api/backends/chat-completions/generate':
        body = req.post_data_json
        calls.append(body)
        if control['fail_next']:
            control['fail_next'] = False
            route.fulfill(status=503, body='temporary fixture failure', content_type='text/plain')
        elif control['hold_first']:
            control['hold_first'] = False
            held.append((route, body))
        else:
            generation_reply(route, body)
        return
    relative = path.removeprefix('/folio/') if path.startswith('/folio/') else path.lstrip('/')
    file = (ROOT / relative).resolve()
    if file.is_relative_to(ROOT) and file.is_file():
        mime = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream'}.get(file.suffix, mimetypes.guess_type(str(file))[0] or 'text/plain')
        route.fulfill(status=200, body=file.read_bytes(), content_type=mime)
        return
    route.fulfill(status=404, body='not found')


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        context = browser.new_context(viewport={'width': 1100, 'height': 900})
        context.route('**/*', route_request)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://folio.test/tests/fixture.html')
        page.wait_for_function('window.fixtureReady===true')
        popup = page.locator('.folio-auto-popup')
        popup.wait_for(state='visible', timeout=10000)
        page.wait_for_function('document.querySelector(".folio-auto-popup-title").textContent.includes("自動整理")')
        for _ in range(100):
            if held:
                break
            page.wait_for_timeout(50)
        assert held, 'the first summary request should remain pending for inspection'
        assert '第 1 頁' in popup.inner_text(), popup.inner_text()
        progress = popup.get_by_role('progressbar')
        assert progress.get_attribute('max') == '6'
        assert progress.get_attribute('value') == '0'
        popup.screenshot(path=str(OUT / 'auto-progress-popup-desktop.png'))

        page.set_viewport_size({'width': 390, 'height': 844})
        assert popup.evaluate('(e)=>e.getBoundingClientRect().left>=0 && e.getBoundingClientRect().right<=innerWidth')
        page.screenshot(path=str(OUT / 'auto-progress-popup-mobile.png'))
        page.set_viewport_size({'width': 1100, 'height': 900})

        popup.get_by_role('button', name='查看進度').click()
        page.get_by_role('tab', name='運行', exact=True).click()
        run_progress = page.locator('.folio-auto-run').get_by_role('progressbar')
        assert run_progress.get_attribute('max') == '6'
        assert run_progress.get_attribute('value') == '0'
        page.locator('.folio-dialog').screenshot(path=str(OUT / 'auto-progress-run-desktop.png'))
        page.get_by_role('button', name='關閉', exact=True).click()

        generation_reply(*held.pop())
        page.wait_for_function("testContext.chat.filter(m=>!m.is_user).every(m=>m.extra.folio_memory?.done)", timeout=120000)
        page.wait_for_function("document.querySelector('.folio-auto-popup-title')?.textContent==='自動整理完成'", timeout=120000)
        assert progress.get_attribute('value') == '6'
        popup.screenshot(path=str(OUT / 'auto-progress-complete.png'))
        popup.wait_for(state='hidden', timeout=7000)

        control['fail_next'] = True
        page.evaluate("""async()=>{testContext.chat.push({mes:'新的角色正文，用來檢查重試。',name:'船長',is_user:false,send_date:'auto-failure',extra:{}});await events.emit('MESSAGE_RECEIVED');}""")
        page.wait_for_function("document.querySelector('.folio-auto-popup-title')?.textContent==='自動整理等待重試'", timeout=15000)
        assert '摘要 3/4 頁' in popup.inner_text()
        popup.screenshot(path=str(OUT / 'auto-progress-retry.png'))
        popup.get_by_role('button', name='立即重試').click()
        page.wait_for_function("testContext.chat.at(-1).extra.folio_memory?.done===true", timeout=20000)
        page.wait_for_function("document.querySelector('.folio-auto-popup-title')?.textContent==='自動整理完成'", timeout=120000)
        assert not errors, errors
        print(json.dumps({'passed': True, 'api_calls': len(calls), 'screenshots': 5, 'errors': errors}, ensure_ascii=False), flush=True)
    finally:
        browser.close()
