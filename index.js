import { Host } from './src/host.js';
import { Cache } from './src/store.js';
import { Embedder } from './src/embedding.js';
import { Engine } from './src/engine.js';
import { mountUI } from './src/ui.js';
import { deferPromptDryRuns, calmFrameAnimations } from './src/perf.js';

const host = new Host(), context = host.context(), cache = new Cache();
let ui;
const embedder = new Embedder(cache, text => engine.setStatus(text));
const engine = new Engine(host, cache, embedder, state => ui?.update(state));
globalThis.folioIntercept = (...args) => engine.intercept(...args);
const listeners = [];
function on(type, fn) {
    if (!type) return; context.eventSource.on(type, fn); listeners.push([type,fn]);
}
let initializing = false, deferral = null, calm = null;
const calmEnabled = () => { const mode = host.settings().calmAnimations ?? 'auto'; return mode === 'on' || (mode === 'auto' && !!globalThis.matchMedia?.('(pointer: coarse)').matches); };
// Independent of the memory panel: keep it working even if the UI fails to mount.
async function setupPerformance() {
    try { deferral ??= deferPromptDryRuns((await host.api()).promptManager, () => host.settings().deferDryRun !== false); deferral?.watch(); }
    catch (e) { console.warn('[Folio] 無法接管提示詞試算', e.message); }
    calm ??= calmFrameAnimations(calmEnabled); calm?.scan();
}
engine.performanceChanged = () => calm?.scan();
async function initialize() {
    setupPerformance();
    if (ui || initializing) return;
    initializing = true;
    try { engine.conflict = await host.memoryConflict(); ui = mountUI(engine); engine.changed(); }
    catch (e) { console.warn('[Folio] 擴充面板未就緒', e.message); }
    finally { initializing = false; }
}
const events = context.eventTypes;
on(events.APP_READY ?? events.APP_INITIALIZED, initialize);
for (const name of ['CHAT_CHANGED','MESSAGE_EDITED','MESSAGE_SENT']) on(events[name],()=>engine.changed());
on(events.CHAT_CHANGED,()=>setupPerformance());
// Navigating an existing swipe is not a newly generated reply. Actual regenerated
// variants arrive through MESSAGE_RECEIVED with type='swipe'.
on(events.MESSAGE_SWIPED,()=>engine.changed());
on(events.MESSAGE_DELETED,()=>engine.changed({deleted:true}));
for (const name of ['MESSAGE_RECEIVED','CHARACTER_MESSAGE_RENDERED']) on(events[name],(messageId,type)=>engine.newResponse({messageId,type}));
on(events.USER_MESSAGE_RENDERED,()=>{engine.emit();engine.schedule();});
on(events.GENERATION_STARTED,(type,options,dryRun)=>engine.generationStarted(type,options,dryRun));
on(events.GENERATION_ENDED,()=>engine.generationEnded());
on(events.GENERATION_STOPPED,()=>engine.generationEnded());
on(events.CHAT_COMPLETION_SETTINGS_READY,body=>engine.captureFinal(body));
for (const name of ['MAIN_API_CHANGED','CHATCOMPLETION_SOURCE_CHANGED','CHATCOMPLETION_MODEL_CHANGED','CONNECTION_PROFILE_LOADED']) on(events[name],()=>{
    host.rejected.clear(); engine.connectionTests={summary:null,selection:null};engine.changed();
});
const startup = setTimeout(initialize, 2500);
window.addEventListener('pagehide',()=>{
    clearTimeout(startup);engine.dispose();ui?.dispose();deferral?.dispose();calm?.dispose();
    for (const [event,fn] of listeners)context.eventSource.removeListener(event,fn);
},{once:true});
