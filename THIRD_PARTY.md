# Bundled third-party assets

No reference-project source code, stories, chat logs, credentials or settings are distributed.

## BGE small Chinese v1.5

- Original model: [BAAI/bge-small-zh-v1.5](https://huggingface.co/BAAI/bge-small-zh-v1.5), model card declares MIT.
- Quantized ONNX export: [Xenova/bge-small-zh-v1.5](https://huggingface.co/Xenova/bge-small-zh-v1.5/tree/main).
- `assets/bge-small-zh-v1.5/model_quantized.onnx`: 24,010,842 bytes.
- SHA-256: `15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc`; verified against the export repository's LFS object hash.
- `vocab.txt`: original export vocabulary, UTF-8, no modifications.
- License text from the model authors' FlagEmbedding repository: `vendor/licenses/bge.txt`.
- Runtime uses BERT WordPiece, CLS pooling, L2 normalization, 512 dimensions, maximum 512 input tokens. Query instruction is applied only to queries.
- Chinese-focused model; English-only recall quality is not promised.

## ONNX Runtime Web 1.19.2

- Source/package: [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime/tree/v1.19.2), `onnxruntime-web@1.19.2`.
- Unmodified `ort.min.js`, `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm` in `vendor/ort/`.
- MIT license and transitive notices: `vendor/licenses/onnxruntime.txt`, `vendor/licenses/onnxruntime-third-party.txt`.
- Single-thread WASM runs inside a dedicated worker. All resources are same-origin files shipped in this repository. No CDN or model download at runtime.

All above assets are ordinary Git files, not Git LFS pointers. SillyTavern's regular extension clone receives the real weights and runtime.
