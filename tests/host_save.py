"""Native ST saveSettings + Folio UI; synthetic server storage, no account writes.

Refresh and new browser context must generate with both saved manual model IDs
without /status. Native save swallowing a failed POST must not mean success.
FOLIO_LOCAL=1 tests development files; default tests the installed extension.
"""
import gzip
import json
import mimetypes
import os
import pathlib
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[1]
ORIGIN = os.environ['FOLIO_ST_URL'].rstrip('/')
NAME = 'third-party/sillytavern-folio'
PREFIX = '/scripts/extensions/' + NAME + '/'
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)
saved = {'enabled': False, 'account': 'save-synthetic', 'apiMode': 'main', 'helpers': {
    'summary': {'connection': 'current', 'model': 'old-summary'},
    'selection': {'connection': 'current', 'model': 'old-selection'}}}
reads = {'/api/settings/get', '/api/characters/all', '/api/characters/get', '/api/characters/chats', '/api/chats/get', '/api/worldinfo/get', '/api/presets/get', '/api/avatars/get', '/api/groups/all', '/api/secrets/read', '/api/backgrounds/all'}
fail_save = False
sent = []
confirmed_saves = []
errors = []


def handle(route):
    global saved
    req = route.request
    path = urlparse(req.url).path
    if urlparse(req.url).netloc != urlparse(ORIGIN).netloc:
        route.abort(); return
    if path == '/api/extensions/discover':
        response = route.fetch()
        entries = [x for x in response.json() if not x['name'].startswith('third-party/') or x['name'] == NAME]
        route.fulfill(response=response, body=json.dumps(entries)); return
    if os.environ.get('FOLIO_LOCAL') == '1' and path.startswith(PREFIX):
        file = (ROOT / path[len(PREFIX):]).resolve()
        assert file.is_relative_to(ROOT)
        mime = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm'}.get(file.suffix, mimetypes.guess_type(str(file))[0] or 'application/octet-stream')
        route.fulfill(body=file.read_bytes(), content_type=mime); return
    if path == '/api/settings/get':
        response = route.fetch()
        data = response.json()
        settings = json.loads(data['settings'])
        ext = settings.setdefault('extension_settings', {})
        ext['folio'] = saved
        ext['disabledExtensions'] = [x for x in ext.get('disabledExtensions', []) if x != NAME]
        data['settings'] = json.dumps(settings)
        route.fulfill(response=response, body=json.dumps(data)); return
    if path == '/api/settings/save':
        if fail_save:
            route.fulfill(status=503, body='synthetic rejected write'); return
        raw = req.post_data_buffer
        if raw[:2] == b'\x1f\x8b':
            raw = gzip.decompress(raw)
        payload = json.loads(raw)
        saved = payload['extension_settings']['folio']
        confirmed_saves.append(saved['apiMode'])
        route.fulfill(content_type='application/json', body='{}'); return
    if path == '/api/backends/chat-completions/status':
        # ST can probe its main connection during startup. No usable list is ever
        # returned; helper generation cannot rely on having obtained one.
        route.fulfill(status=503, content_type='application/json', body='{"error":true}'); return
    if path == '/api/backends/chat-completions/generate':
        data = req.post_data_json
        assert data['model'] in ['manual-summary', 'manual-selection', 'retried-summary']
        assert data['custom_url'] == 'https://synthetic.invalid/v1'
        role = 'selection' if data['model'] == 'manual-selection' else 'summary'
        assert json.loads(data['custom_include_headers'])['Authorization'] == 'Bearer synthetic-' + role
        prompt = json.loads(data['messages'][-1]['content'])
        assert ('catalogue' in prompt) == (role == 'selection')
        sent.append(data['model'])
        answer = {'ids': ['letter']} if role == 'selection' else {'summary': '船長交付信件，約定冬天前送到山城。'}
        route.fulfill(content_type='application/json', body=json.dumps({'choices': [{'message': {'content': json.dumps(answer, ensure_ascii=False)}}]})); return
    if req.method in ('POST', 'PUT', 'PATCH', 'DELETE') and path not in reads and not path.startswith('/api/tokenizers/'):
        route.fulfill(content_type='application/json', body='{}'); return
    route.continue_()


def open_api(page):
    page.wait_for_selector('#folio-wand', state='attached', timeout=60000)
    page.locator('#extensionsMenuButton').click()
    page.locator('#folio-wand').click()
    page.get_by_role('tab', name='記憶助手', exact=True).click()


def verify_generation(page, summary_model):
    for role, name, model in [('summary', '總結', summary_model), ('selection', '提取', 'manual-selection')]:
        row = page.locator('.folio-active-helper[data-role=' + role + ']')
        expect(row.locator('.folio-active-model')).to_have_text(model)
        page.get_by_role('button', name='測試目前' + name + '連線', exact=True).click()
        expect(row.locator('.folio-active-test-result')).to_contain_text('測試通過', timeout=15000)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        context = browser.new_context(viewport={'width': 1320, 'height': 1050})
        context.route('**/*', handle)
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(ORIGIN, wait_until='domcontentloaded', timeout=60000)
        open_api(page)
        page.locator('summary').filter(has_text='不同 API 與模型').click()
        for role, name in [('summary', '總結'), ('selection', '提取')]:
            page.locator('#folio-' + role + '-source').select_option('custom')
            page.locator('#folio-' + role + '-url').fill('https://synthetic.invalid/v1/chat/completions')
            page.locator('#folio-' + role + '-key').fill('synthetic-' + role)
            page.locator('#folio-' + role + '-model').fill('manual-' + role)
            page.get_by_role('button', name='保存' + name + '模型', exact=True).click()
            expect(page.locator('.folio-helper-section').nth(0 if role == 'summary' else 1).locator('.folio-api-feedback')).to_contain_text('已保存', timeout=15000)
        switch = page.get_by_role('switch', name='使用獨立 API', exact=True)
        switch.check()
        expect(switch).to_be_enabled(timeout=15000)
        verify_generation(page, 'manual-summary')
        # New document, no in-page model list or draft survives.
        page.reload(wait_until='domcontentloaded')
        open_api(page)
        verify_generation(page, 'manual-summary')
        page.locator('summary').filter(has_text='不同 API 與模型').click()
        for role in ['summary', 'selection']:
            expect(page.locator('#folio-' + role + '-key')).to_have_value('synthetic-' + role)
            expect(page.locator('#folio-' + role + '-key')).to_have_attribute('type', 'password')
        # Delayed actual native save: UI must not announce success prematurely.
        page.evaluate("""()=>{const previous=window.fetch;window.fetch=(url,...args)=>String(url)==='/api/settings/save'?new Promise(resolve=>window.releaseSave=()=>resolve(previous(url,...args))):previous(url,...args);window.restoreSave=()=>{window.fetch=previous;};}""")
        page.locator('#folio-summary-model').fill('retried-summary')
        page.get_by_role('button', name='保存總結模型', exact=True).click()
        page.wait_for_function('!!window.releaseSave')
        feedback = page.locator('.folio-helper-section').first.locator('.folio-api-feedback')
        expect(feedback).to_contain_text('正在保存')
        expect(page.get_by_role('button', name='測試目前總結連線', exact=True)).to_be_disabled()
        expect(page.get_by_role('button', name='保存提取模型', exact=True)).to_be_disabled()
        fail_save = True
        page.evaluate('releaseSave();restoreSave()')
        expect(feedback).to_contain_text('未確認保存', timeout=15000)
        expect(page.locator('#folio-summary-model')).to_have_value('retried-summary')
        expect(page.locator('.folio-active-helper[data-role=summary] .folio-active-model')).to_have_text('manual-summary')
        page.locator('.folio-dialog').screenshot(path=str(OUT / 'api-save-failure-native.png'))
        fail_save = False
        page.get_by_role('button', name='保存總結模型', exact=True).click()
        expect(feedback).to_contain_text('已保存', timeout=15000)
        assert saved['helpers']['summary']['model'] == 'retried-summary'
        # Close the entire context: no session/localStorage/IndexedDB is retained.
        context.close()
        context = browser.new_context(viewport={'width': 390, 'height': 844})
        context.route('**/*', handle)
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(ORIGIN, wait_until='domcontentloaded', timeout=60000)
        open_api(page)
        verify_generation(page, 'retried-summary')
        expect(page.get_by_role('switch', name='使用獨立 API', exact=True)).to_be_checked()
        page.locator('.folio-dialog').screenshot(path=str(OUT / 'api-save-cold-reopen-mobile.png'))
        assert page.locator('.folio-content').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        assert len(sent) == 6, sent
        assert not errors, errors
        print(json.dumps({'passed': True, 'nativeSaveAndReadback': True, 'reload': True, 'freshContextReopen': True, 'manualModelsWithoutList': sent, 'failedWritePreservesDraft': True, 'retryWithoutList': True, 'accountWrites': 0, 'paidCalls': 0, 'browserErrors': errors}), flush=True)
    finally:
        browser.close()
