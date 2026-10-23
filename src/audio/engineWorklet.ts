// The modelled engine on the audio thread: one EngineModel per car or motorbike voice, steered by
// k-rate parameters, with three outputs: exhaust, intake and the engine block (with the starter).

import { ENGINE_PARAMS, EngineModel, type EngineShape } from './engineModel';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  constructor(options?: unknown);
  readonly port: MessagePort;
}

class EngineProcessor extends AudioWorkletProcessor {
  static parameterDescriptors = ENGINE_PARAMS.map((name) => ({ name, defaultValue: 0, minValue: 0, automationRate: 'k-rate' }));
  private model: EngineModel;
  private input = { rpm: 0, load: 0, fire: 0, misfire: 0, starter: 0, pops: 0 };
  /** told to stop when its voice is gone, so the processor can be freed */
  private stopped = false;
  constructor(options: { processorOptions: { shape: EngineShape } }) {
    super(options);
    this.model = new EngineModel(options.processorOptions.shape, sampleRate);
    this.port.onmessage = () => (this.stopped = true);
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    if (this.stopped) return false;
    for (const name of ENGINE_PARAMS) this.input[name] = params[name][0];
    this.model.render(this.input, outputs[0][0], outputs[1][0], outputs[2][0]);
    return true;
  }
}

registerProcessor('engine', EngineProcessor);
