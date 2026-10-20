// Runs the signal detector off the main thread: a reading takes about a second of number crunching, which would
// otherwise freeze taps and the screen reader. Messages: in, the RGBA pixels of an INPUT x INPUT square; out, its
// best walk and stop scores. The first message out is 'ready', or 'failed' if this browser cannot run the model.
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import modelUrl from './assets/signal-model.onnx?url';
import { CLASSES, INPUT, bestScores, toTensorData } from './signalModel';

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which GitHub Pages cannot turn on

const session = ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
session.then(
  () => postMessage('ready'),
  () => postMessage('failed'),
);

onmessage = async (e: MessageEvent<ArrayBuffer>) => {
  try {
    const s = await session;
    const input = new ort.Tensor('float32', toTensorData(new Uint8ClampedArray(e.data)), [1, 3, INPUT, INPUT]);
    const out = (await s.run({ [s.inputNames[0]]: input }))[s.outputNames[0]];
    if (out.dims[1] !== 4 + CLASSES) throw new Error('unexpected model output');
    postMessage(bestScores(out.data as Float32Array, out.dims[2]));
  } catch {
    postMessage({ walk: 0, stop: 0 }); // a failed reading is the same as seeing nothing
  }
};
