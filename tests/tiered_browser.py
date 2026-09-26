"""Three settings layers, real button saves, and actual request payloads; no paid API."""
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
        route.fulfill(content_type='text/javascript',body="export const model_list=[];export const getChatCompletionModel=s=>s.custom_model;export async function createGenerationParameters(s,model,type,messages){return {generate_data:{model,messages,type,stream:false,max_tokens:s.openai_max_tokens,temperature:s.temp_openai,top_p:s.top_p_openai}};}");return
    if path=='/scripts/extensions.js':route.fulfill(content_type='text/javascript',body='export const extensionNames=[];');return
    if path=='/api/backends/chat-completions/generate':
        data=req.post_data_json;calls.append(data)
        answer={'title':'港口記事','summary':'船長交付藍色信件，約定冬天前送到山城。'}
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
        context.add_init_script("if(!localStorage.getItem('folio-fixture-settings'))localStorage.setItem('folio-fixture-settings',JSON.stringify({folio:{enabled:false,account:'tiered-test'}}));")
        page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://folio.test/tests/fixture.html');page.wait_for_function('window.fixtureReady===true')
        page.locator('#folio-wand').click();page.get_by_role('tab',name='記憶助手',exact=True).click()
        assert page.get_by_role('switch',name='使用獨立 API',exact=True).is_visible()
        assert not page.get_by_role('switch',name='使用獨立 API',exact=True).is_checked()
        assert page.locator('.folio-api-current').inner_text()=='目前生效：酒館主 API'
        assert not page.locator('#folio-summary-source').is_visible()
        assert not page.get_by_label('總結溫度',exact=True).is_visible()
        assert page.evaluate('testContext.extensionSettings.folio.apiMode')=='main'
        page.locator('.folio-dialog').screenshot(path=str(OUT/'tiers-main-desktop.png'))
        page.set_viewport_size({'width':390,'height':844});page.locator('.folio-dialog').screenshot(path=str(OUT/'tiers-main-mobile.png'))
        page.set_viewport_size({'width':1280,'height':1000})
        page.locator('summary').filter(has_text='不同 API 與模型').click()
        assert page.locator('#folio-summary-source').is_visible()
        assert not page.get_by_label('總結溫度',exact=True).is_visible()
        page.locator('.folio-dialog').screenshot(path=str(OUT/'tiers-api-second.png'))
        page.locator('summary').filter(has_text='進階參數與提示詞').click()
        page.get_by_label('總結上下文長度（tokens）',exact=True).fill('8192')
        page.get_by_label('總結回覆長度上限（tokens）',exact=True).fill('700')
        page.get_by_label('總結溫度',exact=True).fill('0.4')
        page.get_by_label('總結Top P',exact=True).fill('0.7')
        page.get_by_label('總結提示詞',exact=True).fill('按角色承諾記錄摘要。')
        page.get_by_role('button',name='保存總結進階設定',exact=True).click()
        assert page.evaluate('testContext.extensionSettings.folio.advanced.summary.maxTokens')==700
        assert page.evaluate('testContext.extensionSettings.folio.apiMode')=='main'
        page.locator('summary').filter(has_text='進階參數與提示詞').scroll_into_view_if_needed()
        page.locator('.folio-dialog').screenshot(path=str(OUT/'tiers-api-third.png'))
        page.set_viewport_size({'width':390,'height':844})
        assert page.locator('.folio-content').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        page.locator('summary').filter(has_text='進階參數與提示詞').scroll_into_view_if_needed()
        page.locator('.folio-dialog').screenshot(path=str(OUT/'tiers-advanced-mobile.png'))
        page.set_viewport_size({'width':1280,'height':1000})
        page.get_by_role('tab',name='書頁目錄',exact=True).click()
        assert not page.get_by_label('小總結詳略',exact=True).is_visible()
        assert not page.get_by_role('button',name='修改小摘要',exact=True).is_visible()
        page.locator('summary').filter(has_text='摘要與取用設定').click()
        page.get_by_label('小總結詳略',exact=True).select_option('detailed')
        page.get_by_label('摘要重點',exact=True).select_option('relationships')
        page.get_by_label('保留近期正文頁數',exact=True).fill('2')
        page.get_by_label('每次最多召回舊正文',exact=True).fill('3')
        assert not page.get_by_label('歷史正文預算（tokens）',exact=True).is_visible()
        page.get_by_role('button',name='保存摘要與取用設定',exact=True).click()
        assert page.evaluate('testContext.extensionSettings.folio.memory.recentPages')==2
        assert not calls, 'Opening settings and saving preferences must not summarize old chat'
        page.locator('.folio-content').evaluate('(e)=>e.scrollTop=0');page.locator('.folio-dialog').screenshot(path=str(OUT/'tiers-summary-second.png'))
        page.get_by_role('button',name='一鍵重新整理全部',exact=True).click()
        page.wait_for_function("testContext.chat.filter(m=>!m.is_user).every(m=>m.extra.folio_memory?.done)",timeout=90000)
        assert len(calls)==3
        for call in calls:
            assert call['model']=='fixture-large' and call['max_tokens']==700 and call['temperature']==0.4 and call['top_p']==0.7
            assert '按角色承諾記錄摘要' in call['messages'][0]['content'] and 'summaryLength' in call['messages'][0]['content'] and '"summaryLength"' in call['messages'][1]['content']
        page.wait_for_function("[...document.querySelectorAll('.folio-rebuild-status')].some(e=>e.textContent.includes('已完成'))",timeout=90000)
        page.evaluate("testContext.chatCompletionSettings.custom_model='changed-main';events.emit('CHATCOMPLETION_MODEL_CHANGED')")
        page.get_by_role('button',name='重新整理此頁',exact=True).click()
        page.wait_for_function("testContext.chat[1].extra.folio_memory?.model==='changed-main'",timeout=90000)
        page.wait_for_function("document.querySelector('.folio-page-work').textContent.includes('已重新整理完成')",timeout=90000)
        assert calls[-1]['model']=='changed-main' and len(calls)==4
        page.get_by_role('button',name='關閉',exact=True).click();page.locator('#folio-wand').click()
        assert not page.get_by_label('小總結詳略',exact=True).is_visible()
        page.get_by_role('tab',name='記憶助手',exact=True).click();assert not page.locator('#folio-summary-source').is_visible()
        page.reload();page.wait_for_function('window.fixtureReady===true');page.locator('#folio-wand').click();page.get_by_role('tab',name='記憶助手',exact=True).click()
        assert not page.get_by_label('總結溫度',exact=True).is_visible()
        assert page.evaluate('testContext.extensionSettings.folio.advanced.summary.maxTokens')==700
        assert page.evaluate('testContext.chatCompletionSettings.openai_max_tokens')==2000
        assert not errors,errors
        print(json.dumps({'passed':True,'threeLayers':True,'mainModelFollowsChanges':True,'advancedPayload':True,'savedSummaryPreferences':True,'oldChatCallsBeforeManualClick':0,'mockCalls':len(calls),'errors':errors}),flush=True)
    finally:browser.close()
