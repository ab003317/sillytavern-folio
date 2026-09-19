function el(tag, className, text) {
    const node = document.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = text; return node;
}
function button(text, action, className = '') {
    const b = el('button', `folio-button ${className}`, text); b.type = 'button'; b.addEventListener('click', action); return b;
}
function info(text) {
    const wrap = el('span', 'folio-info-wrap'), tip = el('span', 'folio-tip', text);
    tip.hidden = true; tip.id = `folio-tip-${Math.random().toString(36).slice(2)}`;
    const b = button('ⓘ', () => { tip.hidden = !tip.hidden; b.setAttribute('aria-expanded', String(!tip.hidden)); }, 'folio-info');
    b.setAttribute('aria-label','說明'); b.setAttribute('aria-expanded','false'); b.setAttribute('aria-controls',tip.id);
    wrap.append(b,tip); return wrap;
}

export function mountUI(engine) {
    const root = el('section', 'folio-panel'); root.id = 'folio-panel';
    const header = el('div', 'folio-header');
    const title = el('h3', 'folio-title', '書頁');
    const toggleLabel = el('label', 'folio-toggle'), toggle = el('input');
    toggle.type='checkbox'; toggle.setAttribute('aria-label','自動記憶'); toggleLabel.append(toggle, document.createTextNode('自動記憶'));
    toggle.addEventListener('change',()=>engine.toggle(toggle.checked));
    header.append(title, info('正文像書頁，摘要像目錄。每則玩家和角色訊息都會自動整理；要回憶時先查目錄，再把選中的正文放回這次的聊天歷史。原聊天不刪、不永久隱藏。'), toggleLabel);
    const status = el('p', 'folio-status'); status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
    const progress = el('p', 'folio-progress'), warning = el('p', 'folio-warning');
    const model = el('p','folio-model');
    const open = button('查閱記憶', ()=>{renderList(); dialog.showModal(); search.focus();}, 'folio-open');
    const takeover = button('改用書頁（停用 Anima 並刷新）',async event=>{
        event.currentTarget.disabled=true;
        try { await engine.host.useFolioInstead(engine.conflict); }
        catch { warning.hidden=false;warning.textContent='停用尚未保存成功；可在酒館擴充管理停用 Anima 後重新整理。';event.currentTarget.disabled=false; }
    });
    takeover.hidden=true;
    root.append(header,status,progress,warning,open,takeover);
    const parent = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!parent) throw new Error('找不到酒館擴充功能面板');
    parent.append(root);

    const dialog = el('dialog','folio-dialog'); dialog.setAttribute('aria-label','書頁記憶');
    const top = el('div','folio-dialog-top');
    top.append(el('h2','folio-title','記憶目錄'), button('關閉',()=>dialog.close()));
    const tabs = el('div','folio-tabs'); tabs.setAttribute('role','tablist');
    let tab = 'all', state = engine.snapshot();
    const allTab = button('所有書頁',()=>setTab('all'));
    const usedTab = button('本次取用',()=>setTab('used'));
    allTab.setAttribute('role','tab'); usedTab.setAttribute('role','tab');
    for (const b of [allTab,usedTab]) b.addEventListener('keydown',e=>{
        if (['ArrowLeft','ArrowRight'].includes(e.key)) { e.preventDefault(); setTab(tab==='all'?'used':'all'); (tab==='all'?allTab:usedTab).focus(); }
    });
    tabs.append(allTab,usedTab,info('「所有書頁」能搜尋摘要和正文，點開即可閱讀。「本次取用」顯示書頁插件最後提交的歷史；酒館之後仍可能按預設剩餘空間裁剪。釘選會優先取用，但仍受上下文容量限制。'));
    const search = el('input','folio-search'); search.type='search'; search.placeholder='找人物、約定或某段情節'; search.setAttribute('aria-label','搜尋記憶');
    search.addEventListener('input',()=>{shown=60; renderList();});
    const live = el('p','folio-catalogue-status'), list = el('div','folio-list'); list.setAttribute('role','tabpanel');
    const footer = el('footer','folio-footer');
    footer.append(model, info('向量模型已內建，在這個瀏覽器本機運行，不使用 Ollama。摘要與選頁是額外的短模型請求，沿用酒館現有連線，可能產生該連線的費用；未提供可用的小模型時會沿用目前模型。只在你開著酒館時自動整理。'));
    dialog.append(top,tabs,search,live,list,footer); document.body.append(dialog);
    dialog.addEventListener('click',e=>{ if(e.target===dialog && (e.offsetX<0 || e.offsetY<0 || e.offsetX>dialog.clientWidth || e.offsetY>dialog.clientHeight)) dialog.close(); });
    let shown = 60;
    function setTab(value) {
        tab=value; shown=60; allTab.setAttribute('aria-selected',String(tab==='all')); usedTab.setAttribute('aria-selected',String(tab==='used'));
        allTab.tabIndex=tab==='all'?0:-1; usedTab.tabIndex=tab==='used'?0:-1; renderList();
    }
    function renderList() {
        const expanded = new Set([...list.querySelectorAll('details[open]')].map(n=>n.dataset.key));
        const scroll = list.scrollTop;
        const q = search.value.trim().toLocaleLowerCase();
        let entries = tab === 'used' ? (state.last?.items ?? []) : state.entries;
        entries = entries.filter(e => [e.name,e.summary,e.body].some(s=>String(s??'').toLocaleLowerCase().includes(q)));
        const fragment = document.createDocumentFragment();
        if (!entries.length) fragment.append(el('p','folio-empty',q ? '沒有找到；試試人物名字或事件中的詞。' : tab==='used' ? '下一次發送後，這裡會列出取用的正文。' : '開啟一段聊天，正文就會自動出現在這裡。'));
        for (const e of entries.slice(0,shown)) {
            const row = el('details','folio-page'); row.dataset.key=String(e.index); row.open=expanded.has(row.dataset.key);
            const summary=el('summary','folio-page-summary'), number=el('span','folio-page-number',e.index >= 0 ? String(e.index+1) : '—');
            const copy=el('span','folio-page-copy');
            copy.append(el('span','folio-page-heading',`${e.name || '正文'}${e.pinned?' · 已釘選':''}`));
            copy.append(el('span','folio-page-excerpt',tab==='used' ? e.reason : e.summary || '尚在排隊整理；正文已保留'));
            summary.append(number,copy); row.append(summary);
            const body=el('div','folio-page-body');
            if(tab==='all' && e.summary) { body.append(el('h4','','小摘要'),el('p','folio-summary-text',e.summary)); }
            body.append(el('h4','','正文'),el('div','folio-original',e.body));
            const actions=el('div','folio-page-actions');
            if(e.index>=0) actions.append(button('回到聊天',()=>{
                const message=document.querySelector(`#chat .mes[mesid="${e.index}"]`);
                if(message){dialog.close();message.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});}
                else live.textContent='這則尚未載入畫面；請在聊天中載入較早的訊息。';
            }));
            if(tab==='all') {
                const run = task => async event => { event.currentTarget.disabled=true; try { await task(); } catch { live.textContent='這次操作沒有保存成功，請稍後再試。'; } finally { renderList(); } };
                actions.append(button(e.pinned?'取消釘選':'釘選',run(()=>engine.pin(e.index))),button('重新整理這一則',run(()=>engine.refresh(e.index))));
            }
            body.append(actions);row.append(body);fragment.append(row);
        }
        if(entries.length>shown) fragment.append(button(`再看 ${Math.min(60,entries.length-shown)} 則`,()=>{shown+=60;renderList();}));
        list.replaceChildren(fragment);list.scrollTop=scroll;
        live.textContent=tab==='used' && state.last ? `插件帶入 ${state.last.items.length} 則，約 ${state.last.tokens.toLocaleString()} tokens${state.last.skipped?.length ? `；${state.last.skipped.length} 則因容量不足未帶入` : ''}。` : `${entries.length} 則書頁；${state.ready}/${state.total} 則已整理。`;
    }
    function update(next) {
        state=next;toggle.checked=next.enabled;status.textContent=next.status;
        progress.textContent=next.total ? `${next.ready} / ${next.total} 則已整理${next.last ? `　上次帶入 ${next.last.items.length} 則正文` : ''}` : '從下一則故事開始記住。';
        warning.textContent=next.warning;warning.hidden=!next.warning;
        takeover.hidden=!next.conflict;
        model.textContent=next.model ? `摘要 / 選頁：${next.model}　向量：內建、本機運行` : '向量：內建、本機運行　摘要：自動沿用酒館連線';
        if(dialog.open)renderList();
    }
    setTab('all');update(state);
    return {update,dispose(){root.remove();dialog.remove();}};
}
