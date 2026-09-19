import { MODEL, fingerprint } from './core.js';

export class Embedder {
    constructor(cache, notify = () => {}) {
        this.cache = cache; this.notify = notify; this.worker = null; this.jobs = new Map(); this.next = 0;
        this.chain = Promise.resolve(); this.idle = null;
    }
    stop(reason = '向量工作已取消') {
        clearTimeout(this.idle); this.worker?.terminate(); this.worker = null;
        for (const job of this.jobs.values()) { clearTimeout(job.timer); job.reject(new Error(reason)); }
        this.jobs.clear();
    }
    async cached(texts) {
        const result=[];
        for(const text of texts){
            const entry=await this.cache.get('vectors',MODEL+':'+fingerprint(text)).catch(()=>null);
            if(entry?.text!==text || entry.vector?.length!==512)return null;
            result.push(entry.vector);
        }
        return result;
    }
    request(texts, signal) {
        signal?.throwIfAborted();
        clearTimeout(this.idle);
        if (!this.worker) {
            this.notify('正在載入內建向量模型');
            this.worker = new Worker(new URL('./embedding-worker.js', import.meta.url));
            this.worker.onerror = () => this.stop('內建向量模型啟動失敗；暫用文字檢索');
            this.worker.onmessage = ({data}) => {
                const job = this.jobs.get(data.id); if (!job) return;
                this.jobs.delete(data.id); clearTimeout(job.timer);
                data.error ? job.reject(new Error(data.error)) : job.resolve(data.vectors);
                if (!this.jobs.size) this.idle = setTimeout(() => this.stop(), 120000);
            };
        }
        return new Promise((resolve, reject) => {
            const id = ++this.next;
            const onAbort = () => this.stop('向量工作已取消');
            const finish = fn => value => { signal?.removeEventListener('abort', onAbort); fn(value); };
            const timer = setTimeout(() => this.stop('內建向量推理超時；暫用文字檢索'), 60000);
            this.jobs.set(id, { resolve:finish(resolve), reject:finish(reject), timer });
            signal?.addEventListener('abort', onAbort, {once:true});
            this.worker.postMessage({id, texts});
        });
    }
    async embed(texts, signal, query = false) {
        const run = async () => {
            const result = [];
            for (const text of texts) {
                signal?.throwIfAborted();
                const input = query ? '为这个句子生成表示以用于检索相关文章：' + text : text;
                const key = MODEL + ':' + fingerprint(input);
                const cached = await this.cache.get('vectors', key).catch(() => null);
                if (cached?.text === input && cached.vector?.length === 512) { result.push(cached.vector); continue; }
                const [vector] = await this.request([input], signal);
                await this.cache.put('vectors', key, { text:input, vector }).catch(() => {});
                result.push(vector);
            }
            return result;
        };
        const promise = this.chain.catch(() => {}).then(run);
        this.chain = promise; return promise;
    }
}
