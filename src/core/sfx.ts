/**
 * UI sound effects synthesised with WebAudio: no samples to license, instant to load,
 * and tuned to the crisp, glassy blips of turn-of-the-millennium console menus.
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;

function ensure(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 1, slideTo?: number, delay = 0) {
  const c = ensure();
  if (!c || !master) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export const sfx = {
  setEnabled(on: boolean) {
    enabled = on;
  },
  /** Unlock audio on first user gesture. */
  unlock() {
    ensure();
  },
  move() {
    tone(1320, 0.05, 'triangle', 0.5);
  },
  confirm() {
    tone(880, 0.07, 'triangle', 0.6);
    tone(1760, 0.12, 'sine', 0.5, undefined, 0.04);
  },
  back() {
    tone(660, 0.08, 'triangle', 0.5, 440);
  },
  error() {
    tone(220, 0.15, 'square', 0.25, 180);
  },
  join() {
    tone(523, 0.08, 'triangle', 0.5);
    tone(659, 0.08, 'triangle', 0.5, undefined, 0.07);
    tone(784, 0.16, 'triangle', 0.55, undefined, 0.14);
  },
  leave() {
    tone(784, 0.08, 'triangle', 0.45);
    tone(523, 0.14, 'triangle', 0.4, undefined, 0.08);
  },
  open() {
    tone(440, 0.06, 'sine', 0.4, 880);
  },
  close() {
    tone(880, 0.06, 'sine', 0.4, 440);
  },
  saved() {
    tone(988, 0.07, 'sine', 0.5);
    tone(1319, 0.07, 'sine', 0.5, undefined, 0.08);
    tone(1976, 0.2, 'sine', 0.5, undefined, 0.16);
  },
  /** Boot chime: a slow, airy chord swell. */
  boot() {
    const c = ensure();
    if (!c || !master) return;
    const notes = [130.81, 196, 261.63, 329.63, 392, 523.25];
    notes.forEach((f, i) => {
      const t0 = c.currentTime + i * 0.28;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = i % 2 ? 'sine' : 'triangle';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.28, t0 + 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.6);
      const filt = c.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.setValueAtTime(400, t0);
      filt.frequency.exponentialRampToValueAtTime(4000, t0 + 1.5);
      osc.connect(filt).connect(g).connect(master!);
      osc.start(t0);
      osc.stop(t0 + 3.8);
    });
  },
};
