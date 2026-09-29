/**
 * Captures the emulator's sound for streaming.
 *
 * The core creates its own AudioContext and connects every buffer straight to
 * `context.destination`. We replace the global AudioContext with a subclass that swaps the
 * instance's `destination` for a gain node feeding both the speakers and, when a stream is
 * requested, a MediaStreamDestination. Nothing in the core has to change.
 */

type Tapped = { ctx: AudioContext; tap: GainNode; msd: MediaStreamAudioDestinationNode | null };

const tapped: Tapped[] = [];
let installed = false;

export function installAudioTap() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const Real = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Real) return;
  class TappedAudioContext extends Real {
    constructor(options?: AudioContextOptions) {
      // Ask for the smallest output buffer the platform allows; the emulator paces itself.
      super({ latencyHint: 'interactive', ...options });
      try {
        const realDest = this.destination;
        const tap = this.createGain();
        tap.connect(realDest);
        Object.defineProperty(this, 'destination', { value: tap, configurable: true, enumerable: true });
        tapped.push({ ctx: this, tap, msd: null });
      } catch (e) {
        console.warn('audio tap failed', e);
      }
    }
  }
  window.AudioContext = TappedAudioContext as unknown as typeof AudioContext;
  (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext = TappedAudioContext;
}

/** Newest live audio context created since the tap was installed, if any. */
function current(): Tapped | null {
  for (let i = tapped.length - 1; i >= 0; i--) if (tapped[i].ctx.state !== 'closed') return tapped[i];
  return null;
}

/** A MediaStream carrying whatever the emulator is playing right now, or null if silent so far. */
export function captureAudioStream(): MediaStream | null {
  const t = current();
  if (!t) return null;
  if (!t.msd) {
    t.msd = t.ctx.createMediaStreamDestination();
    t.tap.connect(t.msd);
  }
  return t.msd.stream;
}

/** Called when a new context may have appeared (the core creates one on launch). */
export function onAudioContextCreated(cb: (ctx: AudioContext) => void): () => void {
  let seen = tapped.length;
  const iv = setInterval(() => {
    while (seen < tapped.length) cb(tapped[seen++].ctx);
  }, 250);
  return () => clearInterval(iv);
}
