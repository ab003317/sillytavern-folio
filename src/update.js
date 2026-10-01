// After an update the open page keeps running the old modules until it is
// reloaded, and a phone can keep a SillyTavern tab alive for days. Watch the
// manifest and reload once nothing would be interrupted, refreshing the cached
// module files first so the reload cannot pick up a stale copy.
export const FILES = ['index.js', 'style.css', 'manifest.json', 'src/api-ui.js', 'src/core.js', 'src/embedding-worker.js', 'src/embedding.js',
    'src/engine.js', 'src/hash.js', 'src/host.js', 'src/perf.js', 'src/providers.js', 'src/settings-ui.js', 'src/settings.js',
    'src/store.js', 'src/tokenizer.js', 'src/ui.js', 'src/update.js', 'src/usage.js'];

export function watchForUpdate({ base, isBusy, notify = () => {}, reload = () => globalThis.location.reload(), fetch = globalThis.fetch.bind(globalThis),
    document = globalThis.document, interval = 120000, retry = 5000 } = {}) {
    let loaded = null, pending = null, timer = null, waiting = null, disposed = false;
    const version = async () => (await (await fetch(`${base}manifest.json`, { cache: 'no-store' })).json()).version;
    const attempt = async () => {
        clearTimeout(waiting); waiting = null;
        if (disposed || !pending) return;
        if (isBusy()) { waiting = setTimeout(attempt, retry); return; }
        await Promise.all(FILES.map(file => fetch(base + file, { cache: 'reload' }).catch(() => {})));
        if (!disposed && !isBusy()) reload(); else waiting = setTimeout(attempt, retry);
    };
    const check = async () => {
        try {
            const current = await version();
            if (disposed || !current) return;
            if (loaded === null) { loaded = current; return; }
            if (current !== loaded && current !== pending) { pending = current; notify(current); }
            if (pending && !waiting) attempt();
        } catch { /* offline or restarting; try again later */ }
    };
    const onVisible = () => { if (document?.visibilityState === 'visible') check(); };
    const ready = check();
    timer = setInterval(check, interval);
    document?.addEventListener('visibilitychange', onVisible);
    return { ready, check, get pending() { return pending; }, dispose() { disposed = true; clearInterval(timer); clearTimeout(waiting); document?.removeEventListener('visibilitychange', onVisible); } };
}
