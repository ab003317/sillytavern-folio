"""LAN native extension UI/interceptor/serializer/send; all writes and model calls blocked.
FOLIO_LOCAL=1 serves development files into the isolated browser; default tests installed files.
"""
import json
import mimetypes
import os
import pathlib
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
ORIGIN = os.environ['FOLIO_ST_URL'].rstrip('/')
NAME = 'third-party/sillytavern-folio'
PREFIX = '/scripts/extensions/' + NAME + '/'
reads = {'/api/settings/get', '/api/characters/all', '/api/characters/get', '/api/characters/chats', '/api/chats/get', '/api/worldinfo/get', '/api/presets/get', '/api/avatars/get', '/api/groups/all', '/api/secrets/read', '/api/backgrounds/all'}
sent = []

def handle(route):
    req = route.request
    parsed = urlparse(req.url)
    path = parsed.path
    if parsed.netloc != urlparse(ORIGIN).netloc:
        route.abort(); return
    if path == '/api/extensions/discover':
        response = route.fetch()
        entries = [x for x in response.json() if not x['name'].startswith('third-party/') or x['name'] == NAME]
        route.fulfill(response=response, body=json.dumps(entries)); return
    if os.environ.get('FOLIO_LOCAL') == '1' and path.startswith(PREFIX):
        file = (ROOT / path[len(PREFIX):]).resolve()
        if file.is_relative_to(ROOT) and file.is_file():
            mime = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream'}.get(file.suffix, mimetypes.guess_type(str(file))[0] or 'text/plain')
            route.fulfill(body=file.read_bytes(), content_type=mime); return
        route.fulfill(status=404, body='not found'); return
    if path == '/api/settings/get':
        response = route.fetch()
        data = response.json()
        settings = json.loads(data['settings'])
        ext = settings.setdefault('extension_settings', {})
        ext['folio'] = {'enabled': False, 'account': 'scope-synthetic-only'}
        ext['disabledExtensions'] = [x for x in ext.get('disabledExtensions', []) if x != NAME]
        data['settings'] = json.dumps(settings)
        route.fulfill(response=response, body=json.dumps(data)); return
    if path == '/api/backends/chat-completions/generate':
        data = req.post_data_json
        assert data['messages'] and all('合成驗收' in str(m.get('content', '')) for m in data['messages']), 'Unexpected request blocked'
        sent.append(data['messages'])
        if data.get('stream'):
            route.fulfill(content_type='text/event-stream', body='data: {"choices":[{"index":0,"delta":{"content":"合成驗收回覆"}}]}\n\ndata: [DONE]\n\n')
        else:
            route.fulfill(content_type='application/json', body=json.dumps({'choices': [{'message': {'content': '合成驗收回覆'}}]}))
        return
    if req.method in ('POST', 'PUT', 'PATCH', 'DELETE') and path not in reads and not path.startswith('/api/tokenizers/'):
        route.fulfill(content_type='application/json', body='{}'); return
    route.continue_()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        context = browser.new_context(viewport={'width': 1280, 'height': 1000})
        context.route('**/*', handle)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(ORIGIN, wait_until='domcontentloaded', timeout=60000)
        page.wait_for_selector('#folio-wand', state='attached', timeout=60000)
        result = page.evaluate("""async prefix=>{
          const real=SillyTavern.getContext(),before=JSON.stringify(real.chat),settings=JSON.stringify(real.chatCompletionSettings);
          const {Host}=await import(prefix+'src/host.js'),{Engine}=await import(prefix+'src/engine.js'),{Cache}=await import(prefix+'src/store.js');
          const {mountUI}=await import(prefix+'src/ui.js'),{bookPages,newRecord,KEY}=await import(prefix+'src/core.js');
          const chat=['合成驗收隱藏玩家','合成驗收隱藏信件正文','合成驗收近期玩家','合成驗收近期正文','合成驗收詢問信件'].map((mes,i)=>({mes,is_user:i%2===0,is_system:i<2,name:i%2?'船長':'玩家',send_date:'scope-'+i,extra:{}}));
          const last=bookPages(chat)[1],record=newRecord(last.message,last.playerInput);Object.assign(record,{done:true,summary:'合成驗收人工目錄',edited:true});last.message.extra[KEY]=record;
          const fixture={...real,chat,chatMetadata:{},chatId:'scope-only',mainApi:'openai',isGenerating:()=>false,extensionSettings:{folio:{enabled:true,account:'scope-only',apiMode:'main',memory:{recentPages:1}}},saveChat:async()=>{},saveSettingsDebounced:()=>{},getTokenCountAsync:async text=>text.length};
          const host=new Host(()=>fixture),cache=new Cache('scope-only'),embedder={embed:async texts=>texts.map(()=>[1,0]),stop(){}};
          const t={real,before,settings,chat,host,cache,embedder,calls:0,previous:window.folioIntercept,preserved:JSON.stringify(last.message)};window.scopeTest=t;
          host.complete=async(_s,_p,options)=>{if(options.selection)return '{"ids":["p1"]}';t.calls++;return '{"summary":"合成驗收新目錄"}';};
          document.querySelector('.folio-dialog').remove();document.querySelector('#folio-wand').remove();
          t.engine=new Engine(host,cache,embedder,s=>t.ui?.update(s));t.engine.schedule=()=>{};t.engine.changed();t.engine.vectors.set(t.engine.vectorKey(record),[[1,0]]);t.ui=mountUI(t.engine);t.ui.open();window.folioIntercept=(...args)=>t.engine.intercept(...args);
          return {missing:t.engine.snapshot().missing,total:t.engine.snapshot().total};
        }""", PREFIX)
        assert result == {'missing': 1, 'total': 2}, result
        page.locator('#folio-view-run').get_by_role('button', name='一鍵整理未整理的', exact=True).click()
        page.wait_for_function('scopeTest.engine.snapshot().rebuild?.pending===1')
        result = page.evaluate("""async()=>{
          const t=scopeTest;await t.engine.tick();await t.engine.tick();
          const {runGenerationInterceptors}=await import('/scripts/extensions.js');
          const outgoing=structuredClone(t.chat.filter(m=>!m.is_system)).map(m=>m.is_user?m:{...m,mes:'合成驗收被正則改寫的摘要副本'});await runGenerationInterceptors(outgoing,10000,'normal');
          const api=await t.host.api(),messages=api.setOpenAIMessages(outgoing);
          const [prepared]=await api.prepareOpenAIMessages({name2:'船長',type:'normal',messages:structuredClone(messages),messageExamples:[],extensionPrompts:{},charDescription:'',charPersonality:'',scenario:'',worldInfoBefore:'',worldInfoAfter:'',bias:'',quietPrompt:''},false);
          t.engine.captureFinal({type:'normal',messages:prepared});
          if(t.engine.last.items.filter(x=>x.role==='assistant'&&x.final).length!==2)throw Error('Native Chat History lost the full bodies');
          if(outgoing.some(m=>m.mes.includes('被正則改寫的摘要副本')))throw Error('Recall used rewritten copy instead of original body');
          const result=await api.sendOpenAIRequest('normal',messages);if(typeof result==='function'){for await(const part of result()){};}
          return {calls:t.calls,preserved:JSON.stringify(t.chat[3])===t.preserved,hiddenFlags:t.chat.slice(0,2).every(m=>m.is_system),order:outgoing.map(m=>m.send_date),realChatUntouched:JSON.stringify(t.real.chat)===t.before,settingsUntouched:JSON.stringify(t.real.chatCompletionSettings)===t.settings};
        }""")
        assert result == {'calls': 1, 'preserved': True, 'hiddenFlags': True, 'order': ['scope-0', 'scope-1', 'scope-2', 'scope-3', 'scope-4'], 'realChatUntouched': True, 'settingsUntouched': True}, result
        assert len(sent) == 1 and len(sent[0]) == 5, sent
        assert sum('合成驗收隱藏信件正文' in str(m['content']) for m in sent[0]) == 1
        page.locator('#folio-view-run').get_by_role('button', name='一鍵重新整理全部', exact=True).click()
        page.wait_for_function('scopeTest.engine.snapshot().rebuild?.pending===2')
        assert page.evaluate('async()=>{for(let i=0;i<4;i++)await scopeTest.engine.tick();return scopeTest.calls;}') == 3
        # Switch to the installed, real local WASM embedder for native repair UI.
        page.evaluate("""async prefix=>{
          const {Embedder}=await import(prefix+'src/embedding.js');const t=scopeTest;
          t.engine.embedder=new Embedder(t.cache);t.engine.vectors.clear();t.engine.emit();
          t.summaryBefore=JSON.stringify(t.chat.map(m=>m.extra.folio_memory?.summary));
        }""", PREFIX)
        page.locator('#folio-view-run').get_by_role('button', name='補齊本機向量', exact=True).click()
        page.wait_for_function("scopeTest.engine.snapshot().rebuild?.mode==='vectors'&&scopeTest.engine.snapshot().rebuild?.pending===2")
        result = page.evaluate("""async()=>{
          const t=scopeTest;await t.engine.tick();const built=t.engine.snapshot();
          t.engine.vectors.clear();t.engine.changed();await t.engine.vectorHydration;const restored=t.engine.snapshot();
          return {built:built.indexed,restored:restored.indexed,calls:t.calls,summariesPreserved:JSON.stringify(t.chat.map(m=>m.extra.folio_memory?.summary))===t.summaryBefore,realChatUntouched:JSON.stringify(t.real.chat)===t.before,settingsUntouched:JSON.stringify(t.real.chatCompletionSettings)===t.settings};
        }""")
        assert result == {'built': 2, 'restored': 2, 'calls': 3, 'summariesPreserved': True, 'realChatUntouched': True, 'settingsUntouched': True}, result
        page.evaluate('()=>{scopeTest.ui.dispose();scopeTest.engine.dispose();window.folioIntercept=scopeTest.previous;}')
        assert not errors, errors
        print(json.dumps({'passed': True, 'localOverride': os.environ.get('FOLIO_LOCAL') == '1', 'missingSummaryCalls': 1, 'allAdditionalCalls': 2, 'nativeSerializedMessages': 5, 'hiddenBodyOccurrences': 1, 'canonicalBodiesInNativeChatHistory': 2, 'realWasmRepairAndHydration': True, 'vectorOnlyApiCalls': 0, 'realUserDataUnchanged': True, 'browserErrors': errors}), flush=True)
    finally:
        browser.close()
