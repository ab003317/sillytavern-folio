import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../',import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
for(const file of [manifest.js,manifest.css,'src/embedding-worker.js','assets/bge-small-zh-v1.5/model_quantized.onnx','vendor/ort/ort-wasm-simd-threaded.wasm']) await stat(root+file);
for(const folder of ['','src/','tests/','tools/'])for(const name of await readdir(root+folder)) if(/\.(?:js|mjs)$/.test(name))execFileSync(process.execPath,['--check',root+folder+name],{stdio:'pipe'});
const model=await readFile(root+'assets/bge-small-zh-v1.5/model_quantized.onnx');
if(createHash('sha256').update(model).digest('hex')!=='15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc')throw Error('Bundled model checksum mismatch');
const assets={
    'assets/bge-small-zh-v1.5/vocab.txt':'45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c',
    'vendor/ort/ort.min.js':'6c5e8696a7993c8af6bbf7666a8acf7f3179165939d9dba459506a59c178061a',
    'vendor/ort/ort-wasm-simd-threaded.mjs':'d870a377322c3053fb97432d548423f165dd15e2af232947592fc07b0d2f3639',
    'vendor/ort/ort-wasm-simd-threaded.wasm':'1bf0b9ed7ad025cf9ca88ce6da29e54df3f128a169f8241d71823e81f078d578',
};
for(const [name,hash] of Object.entries(assets))if(createHash('sha256').update(await readFile(root+name)).digest('hex')!==hash)throw Error('Asset checksum mismatch: '+name);
console.log('Manifest, source syntax, bundled runtime and model SHA-256 verified.');
