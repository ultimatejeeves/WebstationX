// Execute the real AudioWorklet processor with controlled source/output clocks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/emu/ps2/audio.ts', import.meta.url), 'utf8');
const processor = source.match(/const PROCESSOR = `([\s\S]*?)`;/)[1].replace('${RING_HEADER_BYTES}', '32');
for (const rate of [11025, 22050, 44100, 48000, 96000]) {
  let Processor;
  const ctx = vm.createContext({
    AudioWorkletProcessor: class { port = { postMessage() {} }; },
    sampleRate: rate, currentTime: 0,
    registerProcessor(_name, type) { Processor = type; },
  });
  vm.runInContext(processor, ctx);
  const buffer = new SharedArrayBuffer(32 + 8192 * 4);
  const header = new Int32Array(buffer, 0, 8);
  header[2] = 8192;
  header[3] = 44100;
  const p = new Processor({ processorOptions: { buffer, ring: 0 } });
  assert.equal(p.target, 2646, '60ms is measured in source frames at every output rate');
  new Int16Array(buffer, 32).fill(1000);
  header[0] = 4000;
  const outputs = [[new Float32Array(128), new Float32Array(128)]];
  for (let i = 0; i < 100; i++) {
    p.process([], outputs);
    assert.ok((header[1] >>> 0) <= header[0], 'consumer never passes producer');
    assert.ok(outputs[0][0].every(Number.isFinite));
    ctx.currentTime += 128 / rate;
  }
  // A downsampling step may consume more than two frames; don't advance beyond the writer.
  p.playing = true;
  p.frac = 0.9;
  header[1] = 0;
  header[0] = 2;
  p.process([], outputs);
  assert.ok((header[1] >>> 0) <= 2);
  // Reset/wrap detection must reset playback state rather than playing stale samples.
  p.playing = true;
  header[1] = 100;
  header[0] = 0;
  p.process([], outputs);
  assert.equal(p.playing, false);
  assert.equal(p.frac, 0);
}
console.log('PASS: PS2 audio resampling, buffer targets, underrun bounds and reset across five output rates');
