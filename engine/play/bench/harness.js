// Boots a disc from /disc/<name> in the Play! core, streaming it with HTTP range requests.
//   http://localhost:8123/?disc=<file>
// ?core=<name>: a trial build from work/cores-trial/<name> (engine/play/build-dev.sh)
const trialCore = new URLSearchParams(location.search).get('core');
const CORE = trialCore ? `/cores/${trialCore}` : new URLSearchParams(location.search).has('jit') ? '/corejit' : '/core';
const { default: Play } = await import(`${CORE}/Play.js`);

const params = new URLSearchParams(location.search);
const discName = params.get('disc');
const stats = document.getElementById('stats');

const BLOCK = 1 << 20; // 1 MiB range blocks
class RangeDiscDevice {
  constructor(module, url, size) {
    this.module = module;
    this.url = url;
    this.size = size;
    this.blocks = new Map(); // block index -> Promise<Uint8Array>
    this.bytesFetched = 0;
    this.reads = 0;
    this.waitMs = 0; // summed time from block request to data (overlaps the VM when read ahead)
  }
  block(i) {
    let p = this.blocks.get(i);
    if (!p) {
      const start = i * BLOCK;
      const end = Math.min(this.size, start + BLOCK) - 1;
      p = fetch(this.url, { headers: { Range: `bytes=${start}-${end}` } })
        .then((r) => r.arrayBuffer())
        .then((b) => {
          this.bytesFetched += b.byteLength;
          return new Uint8Array(b);
        });
      this.blocks.set(i, p);
    }
    return p;
  }
  // Called by the core (Js_DiscImageDeviceStream) for every 1 MiB block it needs or reads ahead.
  async fetchBlock(i) {
    this.reads++;
    const t = performance.now();
    const data = await this.block(i);
    this.waitMs += performance.now() - t;
    return data;
  }
  // Protocol of cores before the block cache (work/core-base): read into the heap, then poll isDone.
  read(dstPtr, offset, size) {
    this.done = false;
    const first = Math.floor(offset / BLOCK);
    const last = Math.floor((offset + size - 1) / BLOCK);
    const t = performance.now();
    this.reads++;
    const parts = [];
    for (let i = first; i <= last; i++) parts.push(this.block(i));
    Promise.all(parts).then((blocks) => {
      const heap = this.module.HEAPU8;
      let written = 0;
      for (let k = 0; k < blocks.length; k++) {
        const bStart = (first + k) * BLOCK;
        const from = Math.max(offset, bStart) - bStart;
        const to = Math.min(offset + size, bStart + blocks[k].length) - bStart;
        heap.set(blocks[k].subarray(from, to), dstPtr + written);
        written += to - from;
      }
      this.waitMs += performance.now() - t;
      this.done = true;
    });
  }
  isDone() {
    return this.done;
  }
  getFileSize() {
    return this.size;
  }
}

const t0 = performance.now();
// Frame pacing: the longest gap between presented frames each second, and gaps over 50 ms (hitches).
let jit = { n: 0, ms: 0, max: 0 };
if (params.has('jit')) {
  new BroadcastChannel('wsx-jit').onmessage = (e) => {
    jit.n += e.data.n;
    jit.ms += e.data.ms;
    jit.max = Math.max(jit.max, e.data.max);
  };
}
let lastPresent = 0;
let gapMax = 0;
let hitches = 0;
let presentedFrames = 0;
// Establish the GPU channel on the main thread first: a worker creating the first WebGL context of the
// page needs the main thread, which is blocked while the VM spins up its GS thread.
{
  const warm = document.createElement('canvas').getContext('webgl2');
  warm?.getExtension('WEBGL_lose_context')?.loseContext();
}
const view = document.getElementById('outputCanvas').getContext('bitmaprenderer');
const mod = await Play({
  // Frames rendered by the GS worker arrive here as ImageBitmaps (zero-copy transfer).
  wsxPresent: (bitmap) => {
    presentedFrames++;
    view.transferFromImageBitmap(bitmap);
    const now = performance.now();
    if (lastPresent) {
      const gap = now - lastPresent;
      gapMax = Math.max(gapMax, gap);
      if (gap > 50) hitches++;
    }
    lastPresent = now;
  },
  locateFile: (p) => `${CORE}/${p}`,
  mainScriptUrlOrBlob: `${CORE}/Play.js`,
  wsxGsEvent: (name) => console.log(`GS event: ${name}`),
  print: (s) => console.log(s),
  printErr: (s) => console.warn(s),
});
window.Module = mod;
// Debug: a PNG data URL of GS memory read as a direct-colour texture (CT32 psm 0, CT16 psm 2); see gstex.mjs
// for paletted ones. probe.mjs --eval "34:window.__gsTexPng(0x2700,512,0,512,256)" + the eval-png option.
window.__gsTexPng = (tbp, tbw, psm, w, h, alpha = false) => {
  const px = new Uint32Array(mod.HEAPU8.buffer, mod.debugReadGsTexture(tbp, tbw, psm, w, h), w * h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < px.length; i++) {
    let v = px[i];
    if (psm === 2) v = ((v & 31) << 3) | (((v >> 5) & 31) << 11) | (((v >> 10) & 31) << 19);
    if (alpha) {
      const a = Math.min(255, (v >>> 24) * 2);
      v = a | (a << 8) | (a << 16);
    }
    img.data[i * 4] = v & 255;
    img.data[i * 4 + 1] = (v >> 8) & 255;
    img.data[i * 4 + 2] = (v >> 16) & 255;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
};

mod.FS.mkdir('/work');
// ?vu1thread=sync|async: VIF1, VU1 and the GIF on their own thread (CVpu1Thread).
if (params.get('vu1thread') && mod.setVpu1ThreadMode) mod.setVpu1ThreadMode({ off: 0, sync: 1, async: 2 }[params.get('vu1thread')] ?? 0);
// ?swraster=1: draw downloaded render targets in software (GsSwRaster.h; off by default since it broke ATV2's terrain)
if (params.get('swraster') === '1' && mod.setSwRaster) mod.setSwRaster(true);
// ?log=1|2: core log on the console (1: warnings about unimplemented things, 2: every call the core logs)
if (params.get('log') && mod.debugSetLogLevel) mod.debugSetLogLevel(Number(params.get('log')));
// ?gswatch=<hex block>: name the GS transfers after which that block of GS memory changed (GSWATCH lines)
if (params.get('gswatch') && mod.debugWatchGsBlock) mod.debugWatchGsBlock(parseInt(params.get('gswatch'), 16));
// ?jittrace=1: log every statement list before code generation (huge; for a hang inside the compiler)
if (params.get('jittrace') && mod.debugSetJitTrace) mod.debugSetJitTrace(true);
if (params.get('locals') && mod.debugSetLocalsAsRegisters) mod.debugSetLocalsAsRegisters(params.get('locals') !== '0');
// ?spin=N: how long each side of an EE/VPU1 hand-over looks for the other before sleeping (0: sleep at once)
if (params.get('spin') && mod.setVpu1SpinCount) mod.setVpu1SpinCount(Number(params.get('spin')));
mod.initVmHosted(640, 480, Number(params.get('res') ?? 1));

// Keyboard -> pad 0 (same layout as Play!.js so the probe scripts keep working).
const KEYS = { ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7, Backspace: 8, Enter: 9, KeyA: 10, KeyS: 11, KeyX: 12, KeyZ: 13, Digit1: 14, Digit2: 15, Digit3: 16, Digit8: 17, Digit9: 18, Digit0: 19 };
let buttons = 0;
const canvas = document.getElementById('outputCanvas');
const onKey = (e) => {
  const bit = KEYS[e.code];
  if (bit === undefined) return;
  e.preventDefault();
  buttons = e.type === 'keydown' ? buttons | (1 << bit) : buttons & ~(1 << bit);
  mod.setPadState(0, buttons, 0x80808080);
};
canvas.addEventListener('keydown', onKey);
canvas.addEventListener('keyup', onKey);

const waitStateOp = async () => {
  for (;;) {
    const r = mod.pollStateOp();
    if (r >= 0) return r === 1;
    await new Promise((res) => setTimeout(res, 20));
  }
};
window.__saveState = async (name) => {
  const p = `/work/${name}`;
  mod.saveState(p);
  if (!(await waitStateOp())) throw new Error('save failed');
  const data = mod.FS.readFile(p);
  const res = await fetch(`/states/${encodeURIComponent(name)}`, { method: 'PUT', body: data, headers: { 'Content-Type': 'application/octet-stream' } });
  if (!res.ok) throw new Error('upload failed');
  return data.length;
};
window.__loadState = async (name) => {
  const data = new Uint8Array(await (await fetch(`/states/${encodeURIComponent(name)}`)).arrayBuffer());
  const p = `/work/${name}`;
  mod.FS.writeFile(p, data);
  mod.loadState(p);
  return waitStateOp();
};
// Like the app's pause menu: pause, load a state, sit paused for a while, resume.
window.__pauseLoadResume = async (name, pausedMs = 1200) => {
  mod.pauseVm();
  await new Promise((r) => setTimeout(r, 400));
  const ok = await window.__loadState(name);
  await new Promise((r) => setTimeout(r, pausedMs));
  mod.resumeVm();
  return ok;
};
// Like the app's pause menu "Save progress" then "Load progress": pause, save, resume, play a little, pause, load, resume.
window.__saveLoadCycle = async (name) => {
  mod.pauseVm();
  await new Promise((r) => setTimeout(r, 300));
  const size = await window.__saveState(name).catch(() => -1);
  mod.resumeVm();
  await new Promise((r) => setTimeout(r, 1500));
  mod.pauseVm();
  await new Promise((r) => setTimeout(r, 300));
  const ok = await window.__loadState(name);
  await new Promise((r) => setTimeout(r, 300));
  mod.resumeVm();
  return `${size > 0 ? 'saved' : 'SAVE FAILED'} ${ok ? 'loaded' : 'LOAD FAILED'}`;
};
console.log(`core ready in ${Math.round(performance.now() - t0)} ms`);

if (discName) {
  const url = `/disc/${encodeURIComponent(discName)}`;
  const head = await fetch(url, { method: 'HEAD' });
  const size = Number(head.headers.get('Content-Length'));
  mod.discImageDevice = new RangeDiscDevice(mod, url, size);
  // ?jitcache=name: compiled code cache kept in work/ps2-bench-states/<name>.jit (see WsxJitCache.h).
  const jitName = params.get('jitcache');
  if (jitName && mod.jitCacheLoad) {
    const res = await fetch(`/states/${encodeURIComponent(jitName)}.jit`);
    const blob = res.ok ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array(0);
    window.__jitBlob = [blob];
    if (blob.length) {
      const ptr = mod.jitCacheAlloc(blob.length);
      mod.HEAPU8.set(blob, ptr);
      mod.jitCacheLoad(ptr, blob.length);
    }
    console.log(`jit cache: loaded ${(blob.length / 1048576).toFixed(1)} MiB`);
    if (params.has('jitverify')) mod.jitCacheSetVerify(true);
    // ?precompile=N: instantiate up to N cached entries ahead of use, in VM idle time.
    if (params.get('precompile') && mod.jitCacheSetPrecompile) mod.jitCacheSetPrecompile(Number(params.get('precompile')));
    window.__saveJit = async () => {
      window.__jitBlob.push(mod.jitCacheTakeNew());
      const all = new Blob(window.__jitBlob);
      await fetch(`/states/${encodeURIComponent(jitName)}.jit`, { method: 'PUT', body: all, headers: { 'Content-Type': 'application/octet-stream' } });
      return all.size;
    };
  }
  window.__jitStats = () => (mod.jitCacheStats ? JSON.parse(mod.jitCacheStats()) : null);
  // ?warm=ms: like the app resuming a save state, let the paused VM precompile before booting.
  if (params.get('warm')) {
    mod.pauseVm();
    const t = performance.now();
    await new Promise((r) => setTimeout(r, Number(params.get('warm'))));
    console.log(`warm: ${window.__jitStats()?.precompiled} precompiled in ${Math.round(performance.now() - t)} ms`);
  }
  mod.bootDiscImage(discName);
  // ?hash=N without a state: fingerprint N frames after boot.
  if (params.get('hash') && !params.get('state')) {
    mod.setStateHashFrames(Number(params.get('hash')));
    mod.armStateHash();
  }
  if (params.has('nolimit')) mod.setFrameLimit(false);
  // ?catchup=0: a machine that can't keep up slows the console down instead of skipping EE cycles (CPS2VM::TakeCatchUpTicks)
  if (params.get('catchup') === '0' && mod.setCatchUp) mod.setCatchUp(false);
  if (params.get('ee')) {
    const [n, d] = params.get('ee').split('/').map(Number);
    mod.setEeFrequencyScale(n, d);
  }
  document.getElementById('outputCanvas').focus();
  const st = params.get('state');
  if (st) {
    // Give the boot a moment to set up the VM, then restore.
    await new Promise((r) => setTimeout(r, 1500));
    // ?hash=N: fingerprint the machine N frames after the load and pause (determinism check).
    if (params.get('hash')) mod.setStateHashFrames(Number(params.get('hash')));
    // ?gstrace=N / ?viftrace=N: trace the first frames after the load (comparable between runs and threading modes)
    if (params.get('gstrace')) mod.gsTrace(Number(params.get('gstrace')));
    if (params.get('viftrace') && mod.vifTrace) mod.vifTrace(Number(params.get('viftrace')));
    console.log('state load', await window.__loadState(st));
  }
}

// Per-frame timings from the core (WsxFrameStats rings in shared memory): every VM frame and every
// presented picture, collected here so the probe can attribute each hitch.
window.__frames = { vm: [], gs: [] };
if (mod.getFrameStatsAddress) {
  const base = mod.getFrameStatsAddress();
  const RING = 512;
  let vmSeen = 0;
  let gsSeen = 0;
  setInterval(() => {
    const view = new DataView(mod.HEAPU8.buffer);
    const vmCount = view.getUint32(base, true);
    const gsCount = view.getUint32(base + 4, true);
    const vmBase = base + 16;
    const gsBase = vmBase + RING * 32;
    for (vmSeen = Math.max(vmSeen, vmCount - RING); vmSeen < vmCount; vmSeen++) {
      const o = vmBase + (vmSeen % RING) * 32;
      window.__frames.vm.push([view.getFloat64(o, true), view.getFloat32(o + 8, true), view.getFloat32(o + 12, true), view.getFloat32(o + 16, true), view.getFloat32(o + 20, true), view.getFloat32(o + 24, true)]);
    }
    for (gsSeen = Math.max(gsSeen, gsCount - RING); gsSeen < gsCount; gsSeen++) {
      const o = gsBase + (gsSeen % RING) * 16;
      window.__frames.gs.push([view.getFloat64(o, true), view.getFloat32(o + 8, true), view.getFloat32(o + 12, true)]);
    }
  }, 250);
}
window.__loseGs = () => mod.debugLoseGsContext();

// Guest PC sampler: a worker reads the EE program counter straight out of the shared wasm memory.
window.__pcProfile = (ms) =>
  new Promise((resolve) => {
    const src = `onmessage = (e) => {
      const { buffer, index, ms } = e.data;
      const u32 = new Uint32Array(buffer);
      const counts = new Map();
      const end = performance.now() + ms;
      let n = 0;
      while (performance.now() < end) {
        const pc = Atomics.load(u32, index);
        counts.set(pc, (counts.get(pc) || 0) + 1);
        n++;
        for (let k = 0; k < 200; k++); // ~ a few microseconds between samples
      }
      postMessage({ n, top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4000) });
    };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = (e) => {
      w.terminate();
      const { n, top } = e.data;
      resolve({ n, top: top.map(([pc, c]) => ({ pc: pc.toString(16).padStart(8, '0'), pct: +((c / n) * 100).toFixed(2) })) });
    };
    w.postMessage({ buffer: mod.HEAPU8.buffer, index: mod.getEePcAddress() >>> 2, ms });
  });
// Share of VM thread time per emulated unit (WsxProfile.h), sampled like __pcProfile.
const ZONES = ['other', 'ee', 'vu0', 'vif0', 'vif1', 'vu1', 'gif', 'ipu', 'iop', 'spu', 'jit', 'wait', 'idle'];
window.__zoneProfile = (ms) =>
  new Promise((resolve) => {
    const src = `onmessage = (e) => {
      const { buffer, index, index2, ms } = e.data;
      const u32 = new Uint32Array(buffer);
      const counts = new Uint32Array(64);
      const counts2 = new Uint32Array(64);
      const end = performance.now() + ms;
      let n = 0;
      while (performance.now() < end) {
        counts[Atomics.load(u32, index) & 63]++;
        if (index2) counts2[Atomics.load(u32, index2) & 63]++;
        n++;
        for (let k = 0; k < 200; k++);
      }
      postMessage({ n, counts: [...counts], counts2: [...counts2] });
    };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = (e) => {
      w.terminate();
      const { n, counts, counts2 } = e.data;
      const out = {};
      ZONES.forEach((z, i) => counts[i] && (out[z] = +((counts[i] / n) * 100).toFixed(1)));
      if (counts2.some((c) => c)) {
        out.vpu1Thread = {};
        ZONES.forEach((z, i) => counts2[i] && (out.vpu1Thread[z] = +((counts2[i] / n) * 100).toFixed(1)));
        out.vpu1Stats = JSON.parse(mod.getVpu1Stats());
        if (mod.getGsStats) out.gsStats = JSON.parse(mod.getGsStats());
      }
      if (mod.getEeStats) out.eeStats = JSON.parse(mod.getEeStats());
      resolve(out);
    };
    const threaded = mod.getVpu1ZoneAddress && JSON.parse(mod.getVpu1Stats()).mode;
    w.postMessage({ buffer: mod.HEAPU8.buffer, index: mod.getVmZoneAddress() >>> 2, index2: threaded ? mod.getVpu1ZoneAddress() >>> 2 : 0, ms });
  });
// Memory watch: a worker polls words of EE RAM and notes the EE pc/ra each time one changes (who writes this?).
window.__watch = (offsets, ms, max = 400) =>
  new Promise((resolve) => {
    const src = `onmessage = (e) => {
      const { buffer, ram, pc, offsets, ms, max } = e.data;
      const u32 = new Uint32Array(buffer);
      const idx = offsets.map((o) => (ram + o) >>> 2);
      const last = idx.map((i) => Atomics.load(u32, i));
      const hits = [];
      const end = performance.now() + ms;
      while (performance.now() < end && hits.length < max) {
        for (let k = 0; k < idx.length; k++) {
          const v = Atomics.load(u32, idx[k]);
          if (v !== last[k]) {
            hits.push([Math.round(performance.now()), offsets[k].toString(16), last[k].toString(16), v.toString(16), Atomics.load(u32, pc).toString(16), Atomics.load(u32, pc + 128).toString(16)]);
            last[k] = v;
          }
        }
      }
      postMessage(hits);
    };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = (e) => {
      w.terminate();
      resolve(e.data.map((h) => h.join(' ')));
    };
    w.postMessage({ buffer: mod.HEAPU8.buffer, ram: mod.getEeRamAddress(), pc: mod.getEePcAddress() >>> 2, offsets, ms, max });
  });
window.__disasm = (addr, count) => mod.disassembleEe(addr, count);
// VU1 program counter histogram, counting only samples taken while the VPU1 thread runs VU1 code (its zone word).
window.__vuProfile = (ms) =>
  new Promise((resolve) => {
    const src = `onmessage = (e) => {
      const { buffer, index, zone, ms } = e.data;
      const u32 = new Uint32Array(buffer);
      const counts = new Map();
      const end = performance.now() + ms;
      let n = 0, all = 0;
      while (performance.now() < end) {
        all++;
        if ((Atomics.load(u32, zone) & 63) === 5) {
          const pc = Atomics.load(u32, index);
          counts.set(pc, (counts.get(pc) || 0) + 1);
          n++;
        }
        for (let k = 0; k < 200; k++);
      }
      postMessage({ n, all, top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400) });
    };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = (e) => {
      w.terminate();
      const { n, all, top } = e.data;
      resolve({ n, all, top: top.map(([pc, c]) => ({ pc: pc.toString(16).padStart(4, '0'), pct: +((c / n) * 100).toFixed(2) })) });
    };
    w.postMessage({ buffer: mod.HEAPU8.buffer, index: mod.getVu1PcAddress() >>> 2, zone: mod.getVpu1ZoneAddress() >>> 2, ms });
  });
window.__disasmVu1 = (addr, count) => mod.disassembleVu1(addr, count);

// fps readout, same metric as Play!.js (frames reported by the GS per second)
window.__fps = [];
window.__pacing = [];
let lastReads = 0;
let lastWait = 0;
setInterval(() => {
    const f = presentedFrames;
    presentedFrames = 0;
  mod.clearStats();
  window.__fps.push(f);
  const d = mod.discImageDevice;
  const reads = d ? d.reads - lastReads : 0;
  const wait = d ? d.waitMs - lastWait : 0;
  if (d) {
    lastReads = d.reads;
    lastWait = d.waitMs;
  }
  // Time the VM thread was actually blocked on disc data (the core's own counter).
  const vmWait = mod.takeDiscWaitMs ? Math.round(mod.takeDiscWaitMs()) : -1;
  window.__pacing.push({ fps: f, gapMax: Math.round(gapMax), hitches, reads, wait: Math.round(wait), vmWait, jitN: jit.n, jitMs: Math.round(jit.ms) });
  jit = { n: 0, ms: 0, max: 0 };
  stats.textContent =
    `${f} fps · worst frame ${Math.round(gapMax)} ms · ${hitches} hitches` +
    (d ? ` · disc ${(d.bytesFetched / 1048576).toFixed(0)} MiB fetched, ${reads} blocks, VM waited ${vmWait} ms` : '');
  gapMax = 0;
  hitches = 0;
}, 1000);
