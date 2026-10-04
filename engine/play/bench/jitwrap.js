// Prepended to the core by the bench server at /corejit/Play.js (?jit): wraps WebAssembly.Module so the
// bench can count JIT block compiles (every compiled block of guest code is a small module). The core's
// worker threads load the same URL, so they get it too; the VM worker never returns to its event loop,
// so the numbers go out over a BroadcastChannel instead of postMessage.
const Orig = WebAssembly.Module;
const channel = new BroadcastChannel('wsx-jit');
let stats = { n: 0, ms: 0, bytes: 0, max: 0 };
let last = performance.now();
WebAssembly.Module = function (bytes) {
  const t = performance.now();
  const module = new Orig(bytes);
  const dt = performance.now() - t;
  stats.n++;
  stats.ms += dt;
  stats.bytes += bytes.byteLength;
  stats.max = Math.max(stats.max, dt);
  if (t - last > 100) {
    channel.postMessage(stats);
    stats = { n: 0, ms: 0, bytes: 0, max: 0 };
    last = t;
  }
  return module;
};
WebAssembly.Module.prototype = Orig.prototype;
Object.setPrototypeOf(WebAssembly.Module, Orig);
