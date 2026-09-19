/* Classic worker: compatible with plain HTTP LAN deployments, no SharedArrayBuffer. */
let ready;
async function load() {
    if (!ready) ready = (async () => {
        importScripts('../vendor/ort/ort.min.js');
        const { WordPiece } = await import('./tokenizer.js');
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
        ort.env.wasm.wasmPaths = new URL('../vendor/ort/', self.location.href).href;
        const response = await fetch(new URL('../assets/bge-small-zh-v1.5/vocab.txt', self.location.href));
        if (!response.ok) throw new Error('內建詞表載入失敗');
        const tokenizer = new WordPiece(await response.text());
        const session = await ort.InferenceSession.create(new URL('../assets/bge-small-zh-v1.5/model_quantized.onnx', self.location.href).href, { executionProviders: ['wasm'] });
        return { session, tokenizer };
    })().catch(error => { ready = null; throw error; });
    return ready;
}
let chain = Promise.resolve();
self.onmessage = ({data}) => {
    chain = chain.catch(() => {}).then(async () => {
        try {
            const { session, tokenizer } = await load();
            const vectors = [];
            for (const text of data.texts) {
                const ids = tokenizer.encode(text);
                const inputs = {
                    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
                    attention_mask: new ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length]),
                    token_type_ids: new ort.Tensor('int64', new BigInt64Array(ids.length), [1, ids.length]),
                };
                let outputs;
                try {
                    outputs = await session.run(Object.fromEntries(session.inputNames.map(name => [name, inputs[name]])));
                    const tensor = outputs[session.outputNames[0]], dim = tensor.dims.at(-1);
                    if (dim !== 512) throw new Error('內建模型維度不符');
                    const v = Array.from(tensor.data.slice(0, dim));
                    const norm = Math.sqrt(v.reduce((s,x) => s + x*x, 0)) || 1;
                    vectors.push(v.map(x => x / norm));
                } finally {
                    Object.values(inputs).forEach(t => t.dispose?.());
                    Object.values(outputs ?? {}).forEach(t => t.dispose?.());
                }
            }
            self.postMessage({id:data.id, vectors});
        } catch (error) { self.postMessage({id:data.id, error:String(error.message ?? error)}); }
    });
};
