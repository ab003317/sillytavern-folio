// SillyTavern's prompt manager rebuilds the entire prompt - world info scan,
// recursion and token counting included - after every received, edited or
// deleted message and on chat load, only to refresh the token counts shown in
// its panel. It does so even while the panel is closed; with a large lorebook
// that is seconds of main-thread work per reply on a phone. Real generations
// call Generate directly and are not affected by this deferral.
export function deferPromptDryRuns(promptManager, enabled, {document = globalThis.document, Observer = globalThis.IntersectionObserver} = {}) {
    if (!promptManager || typeof promptManager.tryGenerate !== 'function') return null;
    if (promptManager.folioDeferral) return promptManager.folioDeferral;
    const original = promptManager.tryGenerate;
    const state = { pending: false, skipped: 0 };
    const container = () => document?.getElementById(promptManager.configuration?.containerIdentifier ?? 'completion_prompt_manager');
    const visible = () => { const el = container(); return !!el && el.getClientRects().length > 0; };
    const wrapper = function (...args) {
        if (enabled() && !visible()) { state.pending = true; state.skipped++; return Promise.resolve(); }
        state.pending = false;
        return original.apply(this, args);
    };
    promptManager.tryGenerate = wrapper;
    // Opening the panel shows fresh counts: run the one deferred dry run then.
    let observer = null, watched = null;
    const watch = () => {
        const el = container();
        if (!Observer || !el || el === watched) return;
        observer?.disconnect(); watched = el;
        observer = new Observer(entries => {
            if (state.pending && entries.some(e => e.isIntersecting)) { state.pending = false; promptManager.render?.(true); }
        });
        observer.observe(el);
    };
    watch();
    const deferral = {
        state, watch,
        dispose() { observer?.disconnect(); if (promptManager.tryGenerate === wrapper) promptManager.tryGenerate = original; delete promptManager.folioDeferral; },
    };
    promptManager.folioDeferral = deferral;
    return deferral;
}

// Rendered message HTML (status bars) runs in same-origin iframes. One infinite
// decorative animation there kept a phone repainting ~40% of the time while
// idle. Infinite animations play one cycle and stop; one-shot ones are untouched.
export const CALM_CSS = '*,*::before,*::after{animation-iteration-count:1!important}';
export function calmFrameAnimations(enabled, {document = globalThis.document} = {}) {
    if (!document) return null;
    const apply = frame => {
        let d; try { d = frame.contentDocument; } catch { return; }
        const root = d?.head ?? d?.documentElement; if (!root) return;
        const style = d.getElementById('folio-calm');
        if (enabled() && !style) { const s = d.createElement('style'); s.id = 'folio-calm'; s.textContent = CALM_CSS; root.append(s); }
        else if (!enabled() && style) style.remove();
    };
    const scan = () => { for (const frame of document.querySelectorAll('#chat iframe')) apply(frame); };
    // load does not bubble, but capture listeners on the document still see it.
    const onLoad = event => { if (event.target?.tagName === 'IFRAME' && event.target.closest?.('#chat')) apply(event.target); };
    document.addEventListener('load', onLoad, true);
    scan();
    return { scan, dispose() { document.removeEventListener('load', onLoad, true); } };
}
