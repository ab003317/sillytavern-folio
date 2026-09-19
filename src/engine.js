import { KEY, MODEL, sourceOf, validRecord, newRecord, splitBody, summaryChunks, fingerprint, cleanBody,
    excerpt, parseSummary, parseSelection, rankCandidates, budgetFor, recentIndices, SUMMARY_SYSTEM, SELECT_SYSTEM } from './core.js';
import { uid } from './host.js';

export class Engine {
    constructor(host, cache, embedder, notify = () => {}) {
        Object.assign(this, {host, cache, embedder, notify});
        this.owner = uid(); this.timer = null; this.controller = null; this.selectController = null;
        this.running = false; this.generating = false; this.epoch = 0; this.failures = 0;
        this.vectors = new Map(); this.last = null; this.status = '等待開啟聊天'; this.warning = ''; this.disposed = false;
        this.currentIdentity = ''; this.vectorRetryAt = 0;
        this.conflict = '';
    }
    snapshot() {
        const c = this.host.context();
        const entries = (c.chat ?? []).map((message,index) => {
            if (message.is_system) return null;
            const {body} = sourceOf(message); if (!body) return null;
            const r = validRecord(message);
            return {index, name:message.name ?? (message.is_user ? '玩家' : '角色'), role:message.is_user ? '玩家' : '角色',
                body, summary:r?.summary || r?.parts?.join('\n') || '', ready:!!r?.done, pinned:!!r?.pinned};
        }).filter(Boolean);
        return {entries, ready:entries.filter(x=>x.ready).length, total:entries.length, status:this.status,
            warning:this.warning, last:this.last, model:this.host.model, enabled:this.host.settings().enabled, conflict:this.conflict};
    }
    emit() { this.notify(this.snapshot()); }
    setStatus(text) { this.status = this.conflict ? 'Anima 仍啟用；書頁暫停，避免重複處理歷史' : text; this.emit(); }
    schedule(ms = 1800) {
        clearTimeout(this.timer);
        if (!this.disposed) this.timer = setTimeout(() => { this.tick().catch(() => {}); }, ms);
    }
    cancel() { this.epoch++; this.controller?.abort(); this.selectController?.abort(); }
    changed() {
        this.cancel(); this.last = null; this.warning = ''; this.failures = 0;
        const identity = this.host.identity();
        if (identity !== this.currentIdentity) { this.vectors.clear(); this.currentIdentity = identity; }
        this.setStatus(this.host.identity() ? '正在檢查目錄' : '等待開啟聊天'); this.schedule();
    }
    generationStarted() { this.generating = true; this.controller?.abort(); }
    generationEnded() { this.generating = false; this.selectController?.abort(); this.schedule(); }
    toggle(enabled) {
        this.host.settings().enabled = enabled; this.host.context().saveSettingsDebounced();
        this.cancel(); if (!enabled) this.embedder.stop();
        this.setStatus(enabled ? '正在檢查目錄' : '已暫停；使用酒館原本的歷史'); this.schedule();
    }
    async pin(index) {
        const message = this.host.context().chat[index];
        if (!message) return;
        const r = validRecord(message) ?? newRecord(message);
        r.pinned = !r.pinned; message.extra ??= {}; message.extra[KEY] = r;
        await this.host.save(); this.emit();
    }
    async refresh(index) {
        this.cancel();
        const message = this.host.context().chat[index]; if (!message) return;
        const r = newRecord(message); r.pinned = !!validRecord(message)?.pinned;
        message.extra ??= {}; message.extra[KEY] = r;
        await this.cache.put('records', this.host.identity() + ':' + r.hash, r);
        await this.host.save(); this.failures = 0; this.warning = ''; this.schedule(100); this.emit();
    }
    vectorKey(record) { return MODEL + ':' + fingerprint(record.summary); }
    async tick() {
        if (this.conflict) return;
        if (this.disposed || this.running || this.generating || !this.host.settings().enabled) { this.schedule(); return; }
        const c = this.host.context(), identity = this.host.identity();
        if (!identity || !c.chat?.length) { this.setStatus('等待開啟聊天'); return; }
        if (c.mainApi !== 'openai') { this.setStatus('等待「聊天補全」連線'); return; }
        this.running = true;
        const controller = new AbortController(); this.controller = controller;
        const epoch = this.epoch, signal = controller.signal;
        let locked = false, renew = null, nextDelay = 700;
        const assertActive = (message, source) => {
            signal.throwIfAborted();
            if (this.disposed || epoch !== this.epoch || identity !== this.host.identity() || !this.host.settings().enabled ||
                !this.host.context().chat.includes(message) || sourceOf(message).source !== source) throw new DOMException('Changed', 'AbortError');
        };
        try {
            locked = await this.cache.lease(identity, this.owner);
            if (!locked) { this.setStatus('另一個視窗正在整理；這裡會自動更新'); nextDelay = 5000; return; }
            renew = setInterval(() => this.cache.lease(identity, this.owner).then(ok => { if (!ok) controller.abort(); }).catch(() => controller.abort()), 25000);
            let target = null;
            for (let i = 0; i < c.chat.length; i++) {
                const message = c.chat[i]; if (message.is_system || !sourceOf(message).body) continue;
                let r = validRecord(message);
                const s = sourceOf(message);
                const cached = !r?.done ? await this.cache.get('records', identity + ':' + s.hash) : null;
                assertActive(message, s.source);
                // The browser receipt closes the gap if a host chat-save was interrupted.
                if (cached?.source === s.source && !r?.done && (cached.done || cached.parts.length > (r?.parts.length ?? 0))) {
                    const pinned = r?.pinned ?? cached.pinned;
                    r = {...structuredClone(cached), pinned}; message.extra ??= {}; message.extra[KEY] = r;
                    await this.host.save(); assertActive(message, s.source);
                }
                if (!r?.done) { target = {message, index:i, record:r ?? newRecord(message), ...s}; break; }
                if (!this.vectors.has(this.vectorKey(r)) && Date.now() >= this.vectorRetryAt) {
                    this.setStatus(`正在建立第 ${i + 1} 則的本機索引`);
                    try {
                        const vectors = await this.embedder.embed(summaryChunks(r.summary), signal);
                        assertActive(message, s.source); this.vectors.set(this.vectorKey(r), vectors);
                        this.failures = 0; this.warning = '';
                    } catch (error) {
                        assertActive(message, s.source); this.vectorRetryAt = Date.now() + 60000;
                        this.warning = '向量暫不可用；摘要仍會整理，這段時間先用文字檢索';
                    }
                }
            }
            if (!target) { this.setStatus('已就緒；新正文會自動整理'); nextDelay = 15000; return; }
            const {message, index, record:r, body, source} = target;
            const parts = splitBody(body);
            this.setStatus(`正在整理第 ${index + 1} 則${parts.length > 1 ? `（${r.parts.length + 1}/${parts.length} 段）` : ''}`);
            assertActive(message, source);
            const part = parts[r.parts.length];
            if (part !== undefined) {
                const raw = await this.host.complete(SUMMARY_SYSTEM, JSON.stringify({speaker:message.name ?? '', role:message.is_user ? '玩家' : '角色', text:part}), {signal});
                assertActive(message, source);
                r.parts.push(parseSummary(raw));
            }
            r.summary = r.parts.join('\n'); r.done = r.parts.length === parts.length;
            await this.cache.put('records', identity + ':' + r.hash, structuredClone(r));
            assertActive(message, source);
            message.extra ??= {}; message.extra[KEY] = r;
            await this.host.save(); assertActive(message, source);
            this.failures = 0; this.warning = ''; this.emit();
        } catch (error) {
            if (!signal.aborted && error.name !== 'AbortError') {
                this.failures++; nextDelay = Math.min(300000, 10000 * 2 ** Math.min(this.failures, 5));
                this.warning = String(error.message ?? error); this.setStatus('暫時無法整理；會自動重試，聊天仍可使用');
            }
        } finally {
            clearInterval(renew);
            if (locked) await this.cache.lease(identity, this.owner, true).catch(() => {});
            if (this.controller === controller) this.controller = null;
            this.running = false; this.schedule(nextDelay);
        }
    }
    async intercept(chat, contextSize, abort, type) {
        if (this.conflict || this.host.context().mainApi !== 'openai' || !this.host.settings().enabled || ['quiet', 'impersonate'].includes(type) || !chat.length) return;
        if (chat.some(m => m.extra?.tool_invocations?.length || m.extra?.media?.length)) {
            this.warning = '這次含工具或多媒體訊息，保留酒館原本的歷史處理'; this.emit(); return;
        }
        this.controller?.abort(); this.selectController?.abort();
        const controller = new AbortController(); this.selectController = controller;
        const signal = controller.signal, identity = this.host.identity(), epoch = this.epoch;
        const unchanged = () => {
            signal.throwIfAborted();
            if (identity !== this.host.identity() || epoch !== this.epoch) throw new DOMException('Chat changed', 'AbortError');
        };
        // No mutation until the complete selection is ready. Any failure leaves host history intact.
        try {
            const original = [...chat];
            const costs = [];
            for (const m of original) { unchanged(); costs.push(await this.host.count(m.mes)); }
            const budget = budgetFor(contextSize), recent = recentIndices(original, costs, budget.recent);
            if (recent.picked.size === original.length) {
                this.last = {mode:'recent', items:original.map((m,i)=>({index:this.sourceIndex(m), name:m.name, body:cleanBody(m.mes), reason:'近期正文'})), tokens:costs.reduce((a,b)=>a+b,0), budget:budget.history};
                this.emit(); return;
            }
            const entries = original.map((m, i) => {
                if (recent.picked.has(i) || m.is_system || m.extra?.tool_invocations?.length || m.extra?.media?.length) return null;
                const index = this.sourceIndex(m), sourceMessage = this.host.context().chat[index];
                const r = sourceMessage ? validRecord(sourceMessage) : null;
                const body = cleanBody(m.mes); if (!body) return null;
                return {id:`p${i}`, i, index, body, name:m.name, summary:r?.summary || excerpt(body, 600), ready:!!r?.done,
                    vectors:r?.done ? this.vectors.get(this.vectorKey(r)) : [], pinned:!!r?.pinned};
            }).filter(Boolean);
            const lastUser = original.findLast(m => m.is_user);
            const currentInput = cleanBody(lastUser?.mes ?? original.at(-1).mes);
            const query = [excerpt(currentInput, 1200), excerpt(cleanBody(original.at(-2)?.mes ?? ''), 600)].join('\n');
            let queryVector = null, mode = 'hybrid', warning = '';
            this.setStatus('正在從目錄選擇這次需要的正文');
            try { [queryVector] = await this.embedder.embed([excerpt(currentInput, 400)], signal, true); }
            catch (e) { unchanged(); mode = 'lexical'; warning = '向量暫不可用，這次以文字匹配查頁'; }
            unchanged();
            const candidates = rankCandidates(entries, query, queryVector, 14);
            let ids = [];
            if (candidates.length) {
                try {
                    const raw = await this.host.complete(SELECT_SYSTEM, JSON.stringify({query,
                        catalogue:candidates.map(e=>({id:e.id, summary:excerpt(e.summary, 420), provisional:!e.ready}))}), {signal, selection:true});
                    ids = parseSelection(raw, candidates);
                } catch (e) {
                    unchanged(); mode = 'fallback'; warning = '選頁模型暫不可用，這次採用最相關的目錄匹配';
                    ids = candidates.filter(e => e.lexical > 0 || e.semantic > .5).slice(0,3).map(e=>e.id);
                }
            }
            unchanged();
            const chosen = new Set(recent.picked), reasons = new Map([...recent.picked].map(i => [i, '近期正文']));
            let used = recent.used;
            const picked = [...entries.filter(e=>e.pinned), ...ids.map(id=>candidates.find(e=>e.id===id)).filter(Boolean)];
            const skipped = [];
            for (const entry of picked) {
                if (chosen.has(entry.i)) continue;
                const cleanCost = await this.host.count(entry.body);
                if (used + cleanCost > Math.max(budget.history, recent.used)) { skipped.push(entry.index); continue; }
                chosen.add(entry.i); used += cleanCost; reasons.set(entry.i, entry.pinned ? '已釘選' : mode === 'fallback' ? '匹配備援' : '目錄選中');
            }
            unchanged();
            const ordered = [...chosen].sort((a,b)=>a-b);
            const result = ordered.map(i=>recent.picked.has(i) ? original[i] : {...original[i], mes:cleanBody(original[i].mes)});
            chat.splice(0, chat.length, ...result);
            this.last = { mode, tokens:used, budget:budget.history, skipped:[...new Set(skipped)],
                items:ordered.map(i=>({index:this.sourceIndex(original[i]), name:original[i].name, body:cleanBody(original[i].mes), reason:reasons.get(i)})) };
            this.warning = warning; this.setStatus('正文已放入這次的聊天歷史');
        } catch (error) {
            if (signal.aborted || error.name === 'AbortError') { abort?.(true); return; }
            this.warning = '這次記憶查頁未完成；保留酒館原本的歷史'; this.emit();
        } finally { if (this.selectController === controller) this.selectController = null; }
    }
    sourceIndex(message) {
        const chat = this.host.context().chat;
        const direct = chat.indexOf(message); if (direct >= 0) return direct;
        const matches = chat.map((m,i)=>({m,i})).filter(({m})=>m.send_date === message.send_date && m.name === message.name && !!m.is_user === !!message.is_user);
        if (matches.length === 1) return matches[0].i;
        return matches.find(({m})=>m.mes === message.mes)?.i ?? -1;
    }
    dispose() { this.disposed = true; clearTimeout(this.timer); this.cancel(); this.embedder.stop(); this.cache.close(); }
}
