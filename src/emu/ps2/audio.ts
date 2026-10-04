/**
 * PS2 sound output: the core's VM thread writes samples into a ring in the shared wasm heap
 * (CSH_WsxRing in engine/play), and an AudioWorklet plays them from the browser's audio thread.
 *
 * The page's main thread is never involved, so UI work can't starve the sound. The worklet keeps a
 * cushion buffered: it waits for that much before playing, nudges its playback rate by up to half a
 * percent to hold the level against clock drift (emulation is paced by the performance clock, sound by
 * the audio clock), and fades out on an underrun (the VM stalled) instead of clicking. The cushion
 * adapts: 60 ms while things run smoothly, growing by 20 ms after each underrun (up to 120 ms) so
 * stall-prone stretches (loading, first visits compiling code) cut out less, and shrinking back by
 * 10 ms after every 4 s without one.
 *
 * The context is created through window.AudioContext, which audio-tap.ts wraps, so online play can
 * still stream it.
 */

// Ring layout (CSH_WsxRing::RING): u32 writePos, readPos, capacity, sampleRate, overflows, 3 reserved,
// then int16 stereo frames.
const RING_HEADER_BYTES = 32;

const PROCESSOR = `
class WsxPs2Audio extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { buffer, ring } = options.processorOptions;
    this.header = new Int32Array(buffer, ring, 8);
    this.capacity = this.header[2] >>> 0;
    this.samples = new Int16Array(buffer, ring + ${RING_HEADER_BYTES}, this.capacity * 2);
    this.srcRate = (this.header[3] >>> 0) || 44100;
    this.minTarget = Math.round(this.srcRate * 0.06);
    this.maxTarget = Math.round(this.srcRate * 0.12);
    this.target = this.minTarget;
    this.calmUntil = currentTime + 4;
    this.playing = false;
    this.frac = 0;
    this.env = 0;
    this.lastL = 0;
    this.lastR = 0;
    this.underruns = 0;
    this.minFill = Infinity;
    this.nextReport = currentTime + 1;
  }
  process(_inputs, outputs) {
    const left = outputs[0][0];
    const right = outputs[0][1] || left;
    const n = left.length;
    const cap = this.capacity;
    const s = this.samples;
    const write = Atomics.load(this.header, 0) >>> 0;
    let read = Atomics.load(this.header, 1) >>> 0;
    let fill = (write - read) >>> 0;
    if (fill > cap) {
      // The core reset its ring (new boot): start over.
      read = write;
      fill = 0;
      this.playing = false;
      this.frac = 0;
      this.env = 0;
    }
    if (!this.playing && fill >= this.target) this.playing = true;
    if (fill > this.target * 4) {
      // Far behind (the context was suspended while the core ran): jump close to live.
      read = (write - this.target) >>> 0;
      fill = this.target;
    }
    const srcRate = (this.header[3] >>> 0) || 44100;
    if (this.playing) this.minFill = Math.min(this.minFill, fill);
    const drift = Math.max(-0.005, Math.min(0.005, ((fill - this.target) / this.target) * 0.005));
    const step = (srcRate / sampleRate) * (1 + drift);
    let frac = this.frac;
    for (let i = 0; i < n; i++) {
      let l = this.lastL;
      let r = this.lastR;
      if (this.playing && ((write - read) >>> 0) >= Math.max(2, Math.floor(frac + step) + 1)) {
        const i0 = (read % cap) * 2;
        const i1 = ((read + 1) % cap) * 2;
        l = (s[i0] + (s[i1] - s[i0]) * frac) / 32768;
        r = (s[i0 + 1] + (s[i1 + 1] - s[i0 + 1]) * frac) / 32768;
        frac += step;
        const whole = Math.floor(frac);
        frac -= whole;
        read = (read + whole) >>> 0;
        this.env = Math.min(1, this.env + 1 / 64);
      } else {
        if (this.playing) {
          this.playing = false;
          this.underruns++;
          this.target = Math.min(this.maxTarget, this.target + Math.round(srcRate * 0.02));
          this.calmUntil = currentTime + 4;
        }
        this.env = Math.max(0, this.env - 1 / 64);
      }
      this.lastL = l;
      this.lastR = r;
      left[i] = l * this.env;
      right[i] = r * this.env;
    }
    this.frac = frac;
    Atomics.store(this.header, 1, read | 0);
    if (currentTime >= this.calmUntil) {
      this.calmUntil = currentTime + 4;
      this.target = Math.max(this.minTarget, this.target - Math.round(srcRate * 0.01));
    }
    if (currentTime >= this.nextReport) {
      this.nextReport = currentTime + 1;
      this.port.postMessage({
        fillMs: Math.round((((write - read) >>> 0) / srcRate) * 1000),
        minFillMs: this.minFill === Infinity ? -1 : Math.round((this.minFill / srcRate) * 1000),
        underruns: this.underruns,
        targetMs: Math.round((this.target / srcRate) * 1000),
      });
      this.minFill = Infinity;
    }
    return true;
  }
}
registerProcessor('wsx-ps2-audio', WsxPs2Audio);
`;

export type Ps2AudioStats = { fillMs: number; minFillMs: number; underruns: number; targetMs?: number };

export class Ps2Audio {
  readonly context: AudioContext;
  private readonly gain: GainNode;
  /** Latest numbers from the worklet (once a second). */
  stats: Ps2AudioStats = { fillMs: 0, minFillMs: -1, underruns: 0 };

  private constructor(context: AudioContext, gain: GainNode) {
    this.context = context;
    this.gain = gain;
  }

  static async create(memory: ArrayBufferLike, ringAddress: number): Promise<Ps2Audio> {
    const context = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
    const url = URL.createObjectURL(new Blob([PROCESSOR], { type: 'text/javascript' }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(context, 'wsx-ps2-audio', {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: { buffer: memory, ring: ringAddress },
    });
    const gain = context.createGain();
    node.connect(gain).connect(context.destination);
    const audio = new Ps2Audio(context, gain);
    node.port.onmessage = (e) => (audio.stats = e.data as Ps2AudioStats);
    return audio;
  }

  setVolume(volume: number) {
    this.gain.gain.value = Math.max(0, Math.min(1, volume));
  }
}
