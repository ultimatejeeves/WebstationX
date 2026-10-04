/**
 * Menu ambience, synthesised live with WebAudio: slow warm pad chords, a soft sub drone, glassy
 * bell notes through an echo and a long reverb, and a breath of filtered air. Nothing to download
 * or license, and it never repeats exactly. Fades out whenever a game starts.
 */

type Chord = { root: number; pad: number[]; bells: number[] };

// MIDI note numbers. Dmaj9 -> Bm11 -> Gmaj9#11 -> A6/9: warm, unresolved, early-2000s dashboard.
const CHORDS: Chord[] = [
  { root: 38, pad: [62, 66, 69, 73, 76], bells: [74, 76, 78, 81, 85, 88] },
  { root: 35, pad: [59, 62, 66, 69, 76], bells: [71, 74, 76, 78, 83, 86] },
  { root: 31, pad: [59, 62, 66, 69, 73], bells: [74, 78, 79, 81, 85, 86] },
  { root: 33, pad: [57, 61, 64, 66, 71], bells: [73, 76, 78, 81, 83, 88] },
];
const CHORD_SECONDS = 10.5;

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

class Music {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null; // user volume
  private duckGain: GainNode | null = null; // ducks under video clips
  private padBus: GainNode | null = null;
  private bellBus: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private timer = 0;
  private playing = false;
  private volume = 0.5;
  /** A menu screen wants music; it plays whenever the volume is above zero. */
  private wanted = false;
  private nextChordAt = 0;
  private chordIndex = 0;
  private nextBellAt = 0;
  private padVoices: { stop: (t: number) => void }[] = [];
  private air: AudioBufferSourceNode | null = null;
  private drone: OscillatorNode | null = null;

  /** 0..100; 0 stops it. */
  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v / 100));
    if (this.ctx && this.out && this.playing) this.out.gain.setTargetAtTime(this.volume * 0.5, this.ctx.currentTime, 0.4);
    if (this.volume === 0) this.halt();
    else if (this.wanted) this.start();
  }

  /** Call from a user gesture so the AudioContext may start. */
  unlock() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  play() {
    this.wanted = true;
    this.start();
  }

  stop(fade = 1.2) {
    this.wanted = false;
    this.halt(fade);
  }

  private start() {
    if (this.volume === 0 || this.playing) return;
    const c = this.ensure();
    if (!c) return;
    this.playing = true;
    const t = c.currentTime;
    this.out!.gain.cancelScheduledValues(t);
    this.out!.gain.setValueAtTime(this.out!.gain.value, t);
    this.out!.gain.linearRampToValueAtTime(this.volume * 0.5, t + 4);
    this.nextChordAt = t + 0.05;
    this.nextBellAt = t + 2.5;
    this.startBeds(t);
    this.timer = window.setInterval(() => this.schedule(), 250);
    this.schedule();
  }

  private halt(fade = 1.2) {
    if (!this.playing || !this.ctx || !this.out) return;
    this.playing = false;
    clearInterval(this.timer);
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + fade);
    for (const v of this.padVoices) v.stop(t + fade);
    this.padVoices = [];
    this.air?.stop(t + fade + 0.1);
    this.drone?.stop(t + fade + 0.1);
    this.air = null;
    this.drone = null;
  }

  /** Lower the music while a game clip plays its own sound. */
  duck(on: boolean) {
    if (!this.ctx || !this.duckGain) return;
    this.duckGain.gain.setTargetAtTime(on ? 0.15 : 1, this.ctx.currentTime, on ? 0.35 : 0.8);
  }

  private ensure(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    }
    try {
      const c = new AudioContext();
      this.ctx = c;
      this.out = c.createGain();
      this.out.gain.value = 0;
      this.duckGain = c.createGain();
      this.out.connect(this.duckGain).connect(c.destination);

      this.reverb = c.createConvolver();
      this.reverb.buffer = impulse(c, 5.5, 2.2);
      const wet = c.createGain();
      wet.gain.value = 0.9;
      this.reverb.connect(wet).connect(this.out);

      this.padBus = c.createGain();
      this.padBus.gain.value = 0.22;
      const padDry = c.createGain();
      padDry.gain.value = 0.55;
      this.padBus.connect(padDry).connect(this.out);
      this.padBus.connect(this.reverb);

      // Bells go through a dotted-eighth echo before the reverb.
      this.bellBus = c.createGain();
      this.bellBus.gain.value = 0.2;
      const delay = c.createDelay(2);
      delay.delayTime.value = 0.43;
      const fb = c.createGain();
      fb.gain.value = 0.38;
      const tone = c.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 3200;
      this.bellBus.connect(this.out);
      this.bellBus.connect(delay);
      delay.connect(tone).connect(fb).connect(delay);
      tone.connect(this.reverb);
      this.bellBus.connect(this.reverb);
      if (c.state === 'suspended') c.resume().catch(() => {});
      return c;
    } catch {
      return null;
    }
  }

  /** Continuous layers: sub drone and breathing air. */
  private startBeds(t: number) {
    const c = this.ctx!;
    const drone = c.createOscillator();
    drone.type = 'sine';
    drone.frequency.value = hz(CHORDS[this.chordIndex].root);
    const dg = c.createGain();
    dg.gain.value = 0;
    dg.gain.linearRampToValueAtTime(0.16, t + 6);
    drone.connect(dg).connect(this.out!);
    drone.start(t);
    this.drone = drone;

    const air = c.createBufferSource();
    air.buffer = noise(c, 4);
    air.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 0.7;
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoAmt = c.createGain();
    lfoAmt.gain.value = 500;
    lfo.connect(lfoAmt).connect(bp.frequency);
    const ag = c.createGain();
    ag.gain.value = 0;
    ag.gain.linearRampToValueAtTime(0.03, t + 8);
    air.connect(bp).connect(ag).connect(this.reverb!);
    air.start(t);
    lfo.start(t);
    air.onended = () => lfo.stop();
    this.air = air;
  }

  private schedule() {
    const c = this.ctx;
    if (!c || !this.playing) return;
    const ahead = c.currentTime + 0.6;
    while (this.nextChordAt < ahead) {
      this.playChord(this.nextChordAt, CHORDS[this.chordIndex]);
      this.nextChordAt += CHORD_SECONDS;
      this.chordIndex = (this.chordIndex + 1) % CHORDS.length;
    }
    while (this.nextBellAt < ahead) {
      const chord = CHORDS[(this.chordIndex + CHORDS.length - 1) % CHORDS.length];
      const n = chord.bells[Math.floor(Math.random() * chord.bells.length)];
      this.bell(this.nextBellAt, hz(n), 0.5 + Math.random() * 0.5);
      // Occasionally a soft answering note a fifth below.
      if (Math.random() < 0.3) this.bell(this.nextBellAt + 0.43 * 2, hz(n - 7), 0.35);
      this.nextBellAt += 1.7 + Math.random() * 2.6;
    }
  }

  private playChord(t: number, chord: Chord) {
    const c = this.ctx!;
    // Release the previous chord under the new one.
    for (const v of this.padVoices) v.stop(t + 3.5);
    this.padVoices = [];
    this.drone?.frequency.setTargetAtTime(hz(chord.root), t, 1.5);
    for (const note of chord.pad) {
      const f = hz(note);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.11, t + 3.2);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.8;
      lp.frequency.setValueAtTime(500, t);
      lp.frequency.linearRampToValueAtTime(1500 + Math.random() * 600, t + 5);
      lp.frequency.linearRampToValueAtTime(700, t + CHORD_SECONDS + 3);
      const oscs = [-7, 6].map((cents) => {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = cents + (Math.random() - 0.5) * 4;
        o.connect(lp);
        o.start(t);
        return o;
      });
      const sub = c.createOscillator();
      sub.type = 'triangle';
      sub.frequency.value = f;
      sub.connect(lp);
      sub.start(t);
      oscs.push(sub);
      const pan = c.createStereoPanner();
      pan.pan.value = (Math.random() - 0.5) * 0.8;
      lp.connect(g).connect(pan).connect(this.padBus!);
      this.padVoices.push({
        stop: (at: number) => {
          g.gain.cancelScheduledValues(at - 3.4 > c.currentTime ? at - 3.4 : c.currentTime);
          g.gain.setTargetAtTime(0, Math.max(c.currentTime, at - 3.4), 1.1);
          for (const o of oscs) o.stop(at + 2);
        },
      });
    }
  }

  /** FM bell: a sine carrier with an inharmonic modulator that decays faster than the tone. */
  private bell(t: number, f: number, vel: number) {
    const c = this.ctx!;
    const car = c.createOscillator();
    car.frequency.value = f;
    const mod = c.createOscillator();
    mod.frequency.value = f * 3.5;
    const modAmt = c.createGain();
    modAmt.gain.setValueAtTime(f * 1.6, t);
    modAmt.gain.exponentialRampToValueAtTime(1, t + 1.2);
    mod.connect(modAmt).connect(car.frequency);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25 * vel, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
    const pan = c.createStereoPanner();
    pan.pan.value = (Math.random() - 0.5) * 1.2;
    car.connect(g).connect(pan).connect(this.bellBus!);
    car.start(t);
    mod.start(t);
    car.stop(t + 3.3);
    mod.stop(t + 3.3);
  }
}

function noise(c: BaseAudioContext, seconds: number) {
  const buf = c.createBuffer(2, Math.floor(c.sampleRate * seconds), c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return buf;
}

/** Stereo exponentially decaying noise: a big soft hall. */
export function impulse(c: BaseAudioContext, seconds: number, decay: number) {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

export const music = new Music();
