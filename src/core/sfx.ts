/**
 * UI sound effects synthesised with WebAudio: no samples to license, instant to load, and tuned
 * to the soft, airy ticks and shimmering swells of turn-of-the-millennium console menus. Every
 * sound gets a little of the same hall reverb so the menu feels like one space.
 */
import { impulse } from './music';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let verb: GainNode | null = null;
let enabled = true;

function ensure(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
      const conv = ctx.createConvolver();
      conv.buffer = impulse(ctx, 2.8, 3);
      verb = ctx.createGain();
      verb.gain.value = 0.35;
      verb.connect(conv).connect(master);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

type ToneOpts = { type?: OscillatorType; gain?: number; slideTo?: number; delay?: number; attack?: number; wet?: number };

function tone(freq: number, dur: number, o: ToneOpts = {}) {
  const c = ensure();
  if (!c || !master) return;
  const t0 = c.currentTime + (o.delay ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.gain ?? 0.5, t0 + (o.attack ?? 0.006));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  if (verb && (o.wet ?? 0.5) > 0) {
    const send = c.createGain();
    send.gain.value = o.wet ?? 0.5;
    g.connect(send).connect(verb);
  }
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

/** Band-passed noise sweep: whooshes, air, and the disc motor. */
function swish(from: number, to: number, dur: number, gain = 0.3, delay = 0, q = 1.2) {
  const c = ensure();
  if (!c || !master) return;
  const t0 = c.currentTime + delay;
  const len = Math.ceil(c.sampleRate * (dur + 0.05));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = q;
  bp.frequency.setValueAtTime(from, t0);
  bp.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(bp).connect(g).connect(master);
  if (verb) g.connect(verb);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

export const sfx = {
  setEnabled(on: boolean) {
    enabled = on;
  },
  /** Unlock audio on first user gesture. */
  unlock() {
    ensure();
  },
  /** Cursor: a soft glassy tick. */
  move() {
    tone(2637, 0.045, { gain: 0.16, wet: 0.6 });
    tone(1318, 0.06, { type: 'triangle', gain: 0.1, wet: 0.4 });
  },
  /** Carousel step: a rounder "whum" with a little air. */
  select() {
    tone(587, 0.16, { type: 'sine', gain: 0.22, slideTo: 880, wet: 0.7 });
    swish(1200, 3000, 0.18, 0.05);
  },
  confirm() {
    tone(880, 0.25, { gain: 0.28, slideTo: 1320, wet: 0.8 });
    tone(1760, 0.4, { gain: 0.16, delay: 0.05, wet: 0.9 });
    swish(800, 6000, 0.3, 0.06);
  },
  back() {
    tone(784, 0.2, { type: 'triangle', gain: 0.22, slideTo: 392, wet: 0.7 });
  },
  error() {
    tone(196, 0.18, { type: 'square', gain: 0.12, slideTo: 165, wet: 0.3 });
    tone(185, 0.22, { type: 'square', gain: 0.1, delay: 0.1, wet: 0.3 });
  },
  join() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.35, { type: 'triangle', gain: 0.22, delay: i * 0.07, wet: 0.8 }));
  },
  leave() {
    [784, 659, 523].forEach((f, i) => tone(f, 0.3, { type: 'triangle', gain: 0.2, delay: i * 0.08, wet: 0.8 }));
  },
  open() {
    swish(500, 3500, 0.28, 0.12);
    tone(1175, 0.3, { gain: 0.1, delay: 0.05, wet: 1 });
  },
  close() {
    swish(3500, 500, 0.24, 0.1);
  },
  saved() {
    [988, 1319, 1976].forEach((f, i) => tone(f, 0.4, { gain: 0.25, delay: i * 0.08, wet: 0.9 }));
  },
  /** The disc is taken: tray motor spin-up, a click, and a bright swell. */
  discIn() {
    const c = ensure();
    if (!c || !master) return;
    swish(250, 2200, 0.9, 0.18, 0, 3);
    const t0 = c.currentTime;
    const motor = c.createOscillator();
    motor.type = 'sawtooth';
    motor.frequency.setValueAtTime(40, t0);
    motor.frequency.exponentialRampToValueAtTime(190, t0 + 0.9);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.0);
    motor.connect(lp).connect(g).connect(master);
    motor.start(t0);
    motor.stop(t0 + 1.05);
    tone(3000, 0.03, { type: 'square', gain: 0.08, delay: 0.12, wet: 0.2 });
    [587, 880, 1175, 1760].forEach((f, i) => tone(f, 1.4, { gain: 0.12, delay: 0.55 + i * 0.06, attack: 0.08, wet: 1 }));
  },
  /** Power-on: a slow chord swell with sparkles on top. */
  boot() {
    const c = ensure();
    if (!c || !master) return;
    const notes = [73.42, 146.83, 220, 293.66, 369.99, 440, 554.37];
    notes.forEach((f, i) => {
      const t0 = c.currentTime + 0.2 + i * 0.22;
      for (const det of [-6, 6]) {
        const osc = c.createOscillator();
        osc.type = i < 2 ? 'sine' : 'sawtooth';
        osc.frequency.value = f;
        osc.detune.value = det;
        const filt = c.createBiquadFilter();
        filt.type = 'lowpass';
        filt.frequency.setValueAtTime(200, t0);
        filt.frequency.exponentialRampToValueAtTime(2600, t0 + 2.2);
        filt.frequency.exponentialRampToValueAtTime(600, t0 + 5);
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(i < 2 ? 0.2 : 0.07, t0 + 1.6);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 5.5);
        osc.connect(filt).connect(g).connect(master!);
        if (verb) g.connect(verb);
        osc.start(t0);
        osc.stop(t0 + 5.6);
      }
    });
    [1760, 2217, 2637, 3520, 2960].forEach((f, i) => tone(f, 1.6, { gain: 0.06, delay: 1.6 + i * 0.18, wet: 1 }));
    swish(300, 5000, 2.4, 0.05, 0.2, 0.6);
  },
};
