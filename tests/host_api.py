"""Installed provider UI + actual native /status proxy, no paid generation or writes.

Only an anonymous OpenRouter public catalogue request is allowed past the interceptor.
No secret is retrieved, saved, or printed. All browser instances close in finally.
"""
import json
import os
import pathlib
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results'
OUT.mkdir(exist_ok=True)
ORIGIN=os.environ['FOLIO_ST_URL'].rstrip('/')
NAME='third-party/sillytavern-folio'
PREFIX='/scripts/extensions/'+NAME+'/'
reads={'/api/settings/get','/api/characters/all','/api/characters/get','/api/characters/chats','/api/chats/get','/api/worldinfo/get','/api/presets/get','/api/avatars/get','/api/groups/all','/api/sd/comfy/workflows','/api/secrets/read','/api/backgrounds/all'}
public=[]
blocked=[]

def handle(route):
    req=route.request
    parsed=urlparse(req.url)
    if parsed.netloc!=urlparse(ORIGIN).netloc:
        route.abort();return
    path=parsed.path
    if path=='/api/extensions/discover':
        response=route.fetch()
        entries=[x for x in response.json() if not x['name'].startswith('third-party/') or x['name']==NAME]
        route.fulfill(response=response,body=json.dumps(entries));return
    if path=='/api/settings/get':
        response=route.fetch();data=response.json();settings=json.loads(data['settings']);ext=settings.setdefault('extension_settings',{})
        ext['folio']={'enabled':False,'account':'folio-api-synthetic'}
        ext['disabledExtensions']=[x for x in ext.get('disabledExtensions',[]) if x!=NAME]
        data['settings']=json.dumps(settings);route.fulfill(response=response,body=json.dumps(data));return
    if path=='/api/backends/chat-completions/status':
        body=req.post_data_json
        if body.get('custom_url')=='https://openrouter.ai/api/v1' and body.get('secret_id')=='folio-no-inherited-secret' and json.loads(body.get('custom_include_headers') or '{}')=={'Authorization':''} and len(public)<1:
            response=route.fetch(timeout=35000);payload=response.json()
            public.append({'status':response.status,'models':len(payload.get('data',[])) if isinstance(payload.get('data'),list) else 0})
            route.fulfill(response=response);return
    if req.method in ('POST','PUT','PATCH','DELETE') and path not in reads and not path.startswith('/api/tokenizers/'):
        blocked.append(path);route.fulfill(status=200,body='{}',content_type='application/json');return
    route.continue_()

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    try:
        context=browser.new_context(viewport={'width':1440,'height':1050})
        context.route('**/*',handle)
        page=context.new_page();errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(ORIGIN,wait_until='domcontentloaded',timeout=60000)
        page.wait_for_selector('#folio-wand',state='attached',timeout=60000)
        before=page.evaluate('JSON.stringify(SillyTavern.getContext().chatCompletionSettings)')
        version=page.evaluate("""async(prefix)=>(await(await fetch(prefix+'manifest.json')).json()).version""",PREFIX)
        assert version==json.loads((ROOT/'manifest.json').read_text(encoding='utf-8'))['version']
        page.locator('#extensionsMenuButton').click();page.locator('#folio-wand').click()
        page.get_by_role('tab',name='記憶助手').click()
        page.locator('summary').filter(has_text='不同 API 與模型').click()
        assert page.locator('#folio-summary-source option').count()==8
        page.locator('#folio-summary-source').select_option('custom')
        page.locator('#folio-summary-url').fill('https://openrouter.ai/api/v1')
        summary=page.locator('.folio-helper-section').nth(0)
        summary.get_by_role('button',name='取得模型列表',exact=True).click()
        page.wait_for_function("document.querySelector('#folio-summary-models').children.length>0",timeout=35000)
        assert public and public[0]['status']==200 and public[0]['models']>0,public
        assert page.locator('#folio-summary-model').input_value()==''
        page.get_by_label('總結模型可選模型',exact=True).select_option(index=1)
        assert page.locator('#folio-summary-model').input_value()
        page.locator('#folio-selection-source').select_option('google')
        assert page.locator('#folio-selection-url').input_value()=='https://generativelanguage.googleapis.com/v1beta'
        page.locator('.folio-content').evaluate('(e)=>e.scrollTop=0')
        page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-api-desktop.png'))
        page.set_viewport_size({'width':390,'height':844})
        page.locator('.folio-dialog').screenshot(path=str(OUT/'lan-api-mobile.png'))
        assert page.locator('.folio-content').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        assert page.evaluate('JSON.stringify(SillyTavern.getContext().chatCompletionSettings)')==before
        assert not errors,errors
        print(json.dumps({'passed':True,'installedVersion':version,'nativeWand':True,'actualNativePublicModels':public[0],'independentDrafts':True,'mainSettingsUntouched':True,'paidGenerations':0,'browserErrors':errors}),flush=True)
    finally:
        browser.close()
