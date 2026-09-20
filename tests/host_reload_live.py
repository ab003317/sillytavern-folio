"""Opt-in: reload/reopen installed Folio with existing saved helper credentials.
At most six real short connection tests. All account/chat writes are blocked;
model-list requests always fail. No settings, keys or story text are logged.
"""
import json
import os
import pathlib
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

assert os.environ.get('FOLIO_LIVE_API') == '1', 'Explicit live API opt-in required'
ORIGIN = os.environ['FOLIO_ST_URL'].rstrip('/')
NAME = 'third-party/sillytavern-folio'
PREFIX = '/scripts/extensions/' + NAME + '/'
ROOT = pathlib.Path(__file__).resolve().parents[1]
reads = {'/api/settings/get', '/api/characters/all', '/api/characters/get', '/api/characters/chats', '/api/chats/get', '/api/worldinfo/get', '/api/presets/get', '/api/avatars/get', '/api/groups/all', '/api/secrets/read', '/api/backgrounds/all'}
calls = []
outcomes = []


def handle(route):
    req = route.request
    path = urlparse(req.url).path
    if urlparse(req.url).netloc != urlparse(ORIGIN).netloc:
        route.abort(); return
    if path == '/api/extensions/discover':
        response = route.fetch()
        route.fulfill(response=response, body=json.dumps([x for x in response.json() if not x['name'].startswith('third-party/') or x['name'] == NAME])); return
    if path == '/api/settings/get':
        response = route.fetch()
        data = response.json();settings = json.loads(data['settings'])
        ext = settings['extension_settings']
        # Keep the real stored helper configuration, changing only the isolated
        # browser's auto-memory switch. All writes below are intercepted.
        ext['folio']['enabled'] = False
        ext['disabledExtensions'] = [x for x in ext.get('disabledExtensions', []) if x != NAME]
        data['settings'] = json.dumps(settings)
        route.fulfill(response=response, body=json.dumps(data)); return
    if path == '/api/backends/chat-completions/status':
        route.fulfill(status=503, content_type='application/json', body='{"error":true}'); return
    if path == '/api/backends/chat-completions/generate':
        data = req.post_data_json
        prompt = json.dumps(data.get('messages', []), ensure_ascii=False)
        safe = '連線測試' in prompt and ('船長將藍色信件交給旅人' in prompt or '船長的信應在甚麼時候送到哪裡' in prompt) and len(calls) < 6 and not data.get('stream')
        if not safe:
            route.fulfill(status=403, body='Non-fixture generation blocked'); return
        calls.append({'status': 'pending'})
        response = route.fetch(timeout=65000)
        calls[-1]['status'] = response.status
        route.fulfill(response=response); return
    if req.method in ('POST', 'PUT', 'PATCH', 'DELETE') and path not in reads and not path.startswith('/api/tokenizers/'):
        route.fulfill(content_type='application/json', body='{}'); return
    route.continue_()


def verify(page, phase):
    page.wait_for_selector('#folio-wand', state='attached', timeout=60000)
    page.locator('#extensionsMenuButton').click()
    page.locator('#folio-wand').click()
    page.get_by_role('tab', name='記憶助手', exact=True).click()
    for role, name in [('summary', '總結'), ('selection', '提取')]:
        row = page.locator('.folio-active-helper[data-role=' + role + ']')
        page.get_by_role('button', name='測試目前' + name + '連線', exact=True).click()
        result = row.locator('.folio-active-test-result')
        expect(result).to_contain_text('測試通過', timeout=65000)
        outcomes.append({'phase': phase, 'role': role, 'passed': True})
        print(json.dumps(outcomes[-1]), flush=True)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        context = browser.new_context()
        context.route('**/*', handle)
        page = context.new_page()
        page.goto(ORIGIN, wait_until='domcontentloaded', timeout=60000)
        verify(page, 'initial-load')
        page.reload(wait_until='domcontentloaded')
        verify(page, 'refresh')
        context.close()
        context = browser.new_context()
        context.route('**/*', handle)
        page = context.new_page()
        page.goto(ORIGIN, wait_until='domcontentloaded', timeout=60000)
        verify(page, 'fresh-context-reopen')
        assert len(calls) == 6 and all(x['status'] == 200 for x in calls)
        print(json.dumps({'passed': True, 'realHelperCalls': len(calls), 'modelListsAvailable': False, 'accountWrites': 0, 'outcomes': outcomes}), flush=True)
    finally:
        browser.close()
