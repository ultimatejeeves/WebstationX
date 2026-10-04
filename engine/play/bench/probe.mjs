// Drives the PS2 bench page in headless Chrome (real GPU) and records fps, screenshots and profiles.
//   node engine/play/bench/probe.mjs [--disc name] [--secs 180] [--press "60:Enter,..."] [--out dir]
//        [--query "state=x.st&nolimit&ee=3/4"] [--savestate at:name] [--cpuprof at:secs] [--pcprof at:secs]
//        [--android [--android-serial S] [--android-port P]]   run on a USB-connected phone/tablet's Chrome (adb + CDP)
//        [--min-fps N] fail when the last 10 samples of delivered pictures average below N
// See README.md next to it.
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const DISC = arg('disc', 'Tony Hawks Pro Skater 4 (USA) (v1.02).chd');
const SECS = Number(arg('secs', 180));
const OUT = arg('out', 'work/shots/ps2-bench');
const BASE = arg('url', 'http://localhost:8123/');
const PRESS = arg('press', '');
const PROFILE = arg('profile', ''); // "at:secs" -> Chrome trace
const QUERY = arg('query', '');
fs.mkdirSync(OUT, { recursive: true });

const ANDROID = process.argv.includes('--android');
const ADB_SERIAL = arg('android-serial', '');
const ADB_PORT = Number(arg('android-port', 9222));
if (ANDROID && (arg('chrome-flags', '') || process.argv.includes('--gpumem'))) console.log('note: --chrome-flags and --gpumem do not apply with --android; ignored');
// Chrome processes that aren't ours (for --gpumem), recorded before launching.
const chromeBefore = new Set(process.argv.includes('--gpumem') && !ANDROID ? chromePidsNow() : []);
function chromePidsNow() {
  return execSync('powershell -NoProfile -Command "@(Get-Process chrome -ErrorAction SilentlyContinue) | % { $_.Id }; exit 0"')
    .toString()
    .split(/\s+/)
    .filter(Boolean);
}
function launchDesktop() {
  return puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: [
      '--use-gl=angle',
      '--use-angle=d3d11',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      // --chrome-flags "--js-flags=--no-liftoff --foo": extra switches for A/B runs (V8 flags, GPU switches)
      ...arg('chrome-flags', '').split(/\s+/).filter(Boolean),
    ],
    defaultViewport: { width: 900, height: 620 },
    protocolTimeout: 60000,
  });
}
// --android: the device's own Chrome over adb. The page URL stays http://localhost:<port>/ (adb reverse), which the
// bench server needs for cross-origin isolation; DevTools is forwarded from Chrome's abstract socket.
let adbExe = '';
let androidReady = false;
const adb = (...a) =>
  execFileSync(adbExe, [...(ADB_SERIAL ? ['-s', ADB_SERIAL] : []), ...a], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
const tryAdb = (...a) => {
  try {
    return adb(...a);
  } catch {
    return null;
  }
};
function androidFail(msg) {
  console.log(msg);
  process.exit(1);
}
async function connectAndroid() {
  const sdkAdb = path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
  for (const cand of ['adb', sdkAdb]) {
    try {
      execFileSync(cand, ['version'], { stdio: 'ignore', timeout: 15000 });
      adbExe = cand;
      break;
    } catch {}
  }
  if (!adbExe) androidFail('adb not found: put adb on PATH or install Android platform-tools (%LOCALAPPDATA%/Android/Sdk/platform-tools)');
  let devices = '';
  try {
    devices = execFileSync(adbExe, ['devices'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    androidFail(`adb devices failed: ${String(e.message).split('\n')[0]}`);
  }
  const rows = devices.split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/)).filter((r) => r.length >= 2);
  const ready = rows.filter((r) => r[1] === 'device' && (!ADB_SERIAL || r[0] === ADB_SERIAL));
  if (!ready.length) {
    const other = rows.map((r) => `${r[0]} ${r[1]}`).join(', ');
    androidFail(
      `No Android device ready${other ? ` (adb sees: ${other})` : ''}: plug it in over USB, enable USB debugging and accept the authorization prompt on the device.`,
    );
  }
  const port = new URL(BASE).port || '80';
  adb('reverse', `tcp:${port}`, `tcp:${port}`);
  adb('forward', `tcp:${ADB_PORT}`, 'localabstract:chrome_devtools_remote');
  androidReady = { port };
  tryAdb('shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main', '-d', 'about:blank');
  const version = `http://127.0.0.1:${ADB_PORT}/json/version`;
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    try {
      up = (await fetch(version)).ok;
    } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) {
    cleanupAndroid();
    androidFail(`Chrome DevTools did not answer on ${version}: is Chrome installed and running on the device?`);
  }
  return puppeteer.connect({ browserURL: `http://127.0.0.1:${ADB_PORT}`, defaultViewport: null, protocolTimeout: 60000 });
}
function cleanupAndroid() {
  if (!androidReady) return;
  tryAdb('reverse', '--remove', `tcp:${androidReady.port}`);
  tryAdb('forward', '--remove', `tcp:${ADB_PORT}`);
  androidReady = false;
}
const browser = ANDROID
  ? await connectAndroid().catch((e) => {
      cleanupAndroid();
      throw e;
    })
  : await launchDesktop();
const page = await (ANDROID
  ? browser.newPage().catch((e) => {
      browser.disconnect();
      cleanupAndroid();
      throw e;
    })
  : browser.newPage());
// Android: leave the user's Chrome running; on any exit close our tab, disconnect and drop the adb reverse/forward.
async function shutdownAndroid() {
  await Promise.race([page.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  await Promise.resolve(browser.disconnect()).catch(() => {});
  cleanupAndroid();
}
if (ANDROID) {
  const die = async (e) => {
    if (e) console.log('error:', e?.stack ?? e);
    await shutdownAndroid();
    process.exit(1);
  };
  process.on('uncaughtException', die);
  process.on('unhandledRejection', die);
  process.on('SIGINT', () => die(null));
}
// --gpumem: dedicated video memory held by this browser's processes (Windows GPU counters), every 10 s.
const GPUMEM = process.argv.includes('--gpumem') && !ANDROID;
const gpuMemMB = () => {
  const mine = new Set(chromePidsNow().filter((pid) => !chromeBefore.has(pid)));
  const counters = execSync(`powershell -NoProfile -Command "(Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage').CounterSamples | % { $_.InstanceName + '=' + [int]($_.CookedValue/1MB) }"`).toString();
  let total = 0;
  for (const line of counters.split(/\r?\n/)) {
    const m = line.match(/^pid_(\d+)_.*=(\d+)$/);
    if (m && mine.has(m[1])) total += Number(m[2]);
  }
  return total;
};
const log = fs.createWriteStream(path.join(OUT, 'console.log'));
page.on('console', (m) => log.write(m.text() + '\n'));
page.on('pageerror', (e) => console.log('  pageerror:', e.message));
page.on('workercreated', (w) => {
  w.on('console', (m) => log.write(`[worker] ${m.text()}
`));
  w.client.on('Runtime.exceptionThrown', (e) => {
    const d = e.exceptionDetails;
    console.log('  worker exception:', d?.exception?.description?.slice(0, 2000) ?? d?.text);
    const frames = d?.stackTrace?.callFrames ?? [];
    if (frames.length) console.log('    at ' + frames.slice(0, 30).map((f) => f.functionName || `${f.url.split('/').pop()}:${f.lineNumber}`).join(String.fromCharCode(10) + '    at '));
  });
});
await page.goto(`${BASE}?disc=${encodeURIComponent(DISC)}${QUERY ? '&' + QUERY : ''}`, { waitUntil: 'load' });
const presses = PRESS.split(',').filter(Boolean).map((p) => {
  const [s, k] = p.split(':');
  return { at: Number(s), key: k, done: false };
});
const [profAt, profLen] = PROFILE ? PROFILE.split(':').map(Number) : [null, 0];
let profiling = false;
// --savestate at:name -> save a state through the harness at that time
const SAVE = arg('savestate', '');
const [saveAt, saveName] = SAVE ? [Number(SAVE.split(':')[0]), SAVE.split(':').slice(1).join(':')] : [null, null];
let saved = false;
// --cpuprof at:secs -> sample every thread (page + workers) with the V8 profiler, print hot functions
const CPUPROF = arg('cpuprof', '');
const [cpuAt, cpuLen] = CPUPROF ? CPUPROF.split(':').map(Number) : [0, 0];
let cpuDone = false;
// --pcprof at:secs -> guest EE PC histogram + disassembly around the hottest blocks
const PCPROF = arg('pcprof', '');
const [pcAt, pcLen] = PCPROF ? PCPROF.split(':').map(Number) : [0, 0];
let pcDone = false;
// --vuprof at:secs -> VU1 program counter histogram (VPU1 thread) and the microprogram disassembly
const VUPROF = arg('vuprof', '');
const [vuAt, vuLen] = VUPROF ? VUPROF.split(':').map(Number) : [0, 0];
let vuDone = false;
async function cpuProfile(secs) {
  const main = await page.createCDPSession();
  const targets = [{ name: 'main', client: main }, ...page.workers().map((w, i) => ({ name: `worker${i}`, client: w.client }))];
  for (const t of targets) {
    await t.client.send('Profiler.enable');
    await t.client.send('Profiler.setSamplingInterval', { interval: 200 });
    await t.client.send('Profiler.start');
  }
  console.log(`  cpu profiling ${targets.length} threads for ${secs}s`);
  await new Promise((r) => setTimeout(r, secs * 1000));
  const report = [];
  for (const t of targets) {
    const { profile } = await t.client.send('Profiler.stop');
    fs.writeFileSync(path.join(OUT, `${t.name}.cpuprofile`), JSON.stringify(profile));
    const self = new Map();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const counts = new Map();
    for (const id of profile.samples) counts.set(id, (counts.get(id) ?? 0) + 1);
    let total = 0;
    for (const [id, c] of counts) {
      const n = byId.get(id);
      const key = n.callFrame.functionName || `(${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber})`;
      self.set(key, (self.get(key) ?? 0) + c);
      total += c;
    }
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
    report.push(`\n## ${t.name} (${total} samples)`);
    for (const [k, c] of top) report.push(`${((c / total) * 100).toFixed(1).padStart(5)}%  ${k.slice(0, 110)}`);
  }
  const txt = report.join('\n');
  fs.writeFileSync(path.join(OUT, 'cpuprofile.txt'), txt);
  console.log(txt);
}
// --savejit at -> save the compiled code cache (?jitcache=name) at that second
const SAVEJIT = Number(arg('savejit', 0));
let savedJit = false;
// --losegs at -> make the browser drop the GS thread's WebGL context at that second (recovery test)
const LOSEGS = Number(arg('losegs', 0));
let lostGs = false;
// --eval "at:js" -> evaluate js in the page at that second (e.g. "40:Module.gsTrace(1)"); repeatable
const EVALS = process.argv
  .flatMap((a, i) => (a === '--eval' ? [process.argv[i + 1]] : []))
  .map((e) => ({ at: Number(e.split(':')[0]), js: e.split(':').slice(1).join(':'), done: false }));
// --vmprof at:secs -> share of VM thread time per emulated unit (window.__zoneProfile) over that window
const VMPROF = arg('vmprof', '');
if (VMPROF) {
  const [at, secs] = VMPROF.split(':').map(Number);
  EVALS.push({ at, js: `window.__zoneProfile(${secs * 1000})`, done: false });
}
const t0 = Date.now();
const all = [];
while ((Date.now() - t0) / 1000 < SECS) {
  await new Promise((r) => setTimeout(r, 1000));
  const s = Math.round((Date.now() - t0) / 1000);
  for (const p of presses) {
    if (!p.done && s >= p.at) {
      p.done = true;
      await page.focus('#outputCanvas');
      await page.keyboard.down(p.key);
      await new Promise((r) => setTimeout(r, 120));
      await page.keyboard.up(p.key);
      console.log(`  pressed ${p.key} @${s}s`);
    }
  }
  if (profAt !== null && !profiling && s >= profAt) {
    profiling = true;
    await page.tracing.start({
      path: path.join(OUT, 'trace.json'),
      categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'disabled-by-default-v8.cpu_profiler', 'gpu', 'toplevel'],
    });
    console.log(`  tracing started @${s}s`);
  }
  if (profiling && s >= profAt + profLen) {
    profiling = false;
    await page.tracing.stop();
    console.log(`  tracing stopped @${s}s`);
  }
  if (saveAt !== null && !saved && s >= saveAt) {
    saved = true;
    if (process.argv.includes('--require-state-hash') &&
        !(await page.evaluate(() => window.Module.getStateHash?.()))) {
      throw new Error('Refusing comparison snapshot before the fixed-frame fingerprint has completed');
    }
    console.log(`  saved state ${saveName}: ${await page.evaluate((n) => window.__saveState(n), saveName)} bytes`);
  }
  if (SAVEJIT && !savedJit && s >= SAVEJIT) {
    savedJit = true;
    console.log(`  saved jit cache: ${await page.evaluate(() => window.__saveJit())} bytes, ${JSON.stringify(await page.evaluate(() => window.__jitStats()))}`);
  }
  for (const e of EVALS) {
    if (!e.done && s >= e.at) {
      e.done = true;
      const value = await page.evaluate(e.js);
      // A PNG data URL (window.__gsTexPng) is saved next to the screenshots instead of printed.
      if (typeof value === 'string' && value.startsWith('data:image/png;base64,')) {
        const file = path.join(OUT, `eval-${s}.png`);
        fs.writeFileSync(file, Buffer.from(value.slice(22), 'base64'));
        console.log(`  eval @${s}s: saved ${file}`);
      } else console.log(`  eval @${s}s: ${JSON.stringify(value)}`);
    }
  }
  if (LOSEGS && !lostGs && s >= LOSEGS) {
    lostGs = true;
    await page.evaluate(() => window.__loseGs());
    console.log(`  GS context dropped @${s}s`);
  }
  if (PCPROF && !pcDone && s >= pcAt) {
    pcDone = true;
    const r = await page.evaluate((ms) => window.__pcProfile(ms), pcLen * 1000);
    const lines = [`samples: ${r.n}`];
    for (const t of r.top.slice(0, 40)) lines.push(`${t.pct.toFixed(2).padStart(6)}%  ${t.pc}`);
    // The whole histogram (pcprofile.json) and its share per 256 bytes of guest code, for code that is slow all over
    fs.writeFileSync(path.join(OUT, 'pcprofile.json'), JSON.stringify(r));
    const ranges = new Map();
    for (const t of r.top) {
      const k = t.pc.slice(0, 6);
      ranges.set(k, (ranges.get(k) ?? 0) + t.pct);
    }
    lines.push('', 'by 256 byte range:');
    for (const [k, v] of [...ranges.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)) lines.push(`${v.toFixed(2).padStart(6)}%  ${k}00`);
    for (const t of r.top.slice(0, 8)) {
      lines.push(`\n--- block @${t.pc} (${t.pct}%)`);
      lines.push(await page.evaluate((a) => window.__disasm(a, 24), parseInt(t.pc, 16)));
    }
    fs.writeFileSync(path.join(OUT, 'pcprofile.txt'), lines.join('\n'));
    console.log(lines.slice(0, 30).join('\n'));
  }
  if (VUPROF && !vuDone && s >= vuAt) {
    vuDone = true;
    const r = await page.evaluate((ms) => window.__vuProfile(ms), vuLen * 1000);
    const lines = [`VU1 samples: ${r.n} of ${r.all} (${((r.n / r.all) * 100).toFixed(1)}% of the time in VU1 code)`];
    for (const t of r.top.slice(0, 60)) lines.push(`${t.pct.toFixed(2).padStart(6)}%  ${t.pc}`);
    lines.push('', await page.evaluate(() => window.__disasmVu1(0, 4096)));
    fs.writeFileSync(path.join(OUT, 'vuprofile.txt'), lines.join('\n'));
    fs.writeFileSync(path.join(OUT, 'vuprofile.json'), JSON.stringify(r));
    console.log(lines.slice(0, 40).join('\n'));
  }
  if (CPUPROF && !cpuDone && s >= cpuAt) {
    cpuDone = true;
    await cpuProfile(cpuLen);
  }
  const fps = await page.evaluate(() => (window.__fps || []).slice(-1)[0] ?? '-');
  all.push(fps);
  if (s % 5 === 0) console.log(`t=${s}s fps=${fps} ${await page.evaluate(() => document.getElementById('stats').textContent)}`);
  if (GPUMEM && s % 10 === 0) console.log(`  t=${s}s GPU memory ${gpuMemMB()} MB`);
  if (s % 15 === 0) await page.screenshot({ path: path.join(OUT, `t${String(s).padStart(3, '0')}.png`) });
}
const pacing = await page.evaluate(() => window.__pacing || []);
const stateHash = await page.evaluate(() => window.Module.getStateHash?.() ?? '');
if (stateHash) console.log('state hash:', stateHash);
console.log('jit cache stats:', JSON.stringify(await page.evaluate(() => window.__jitStats?.())));
fs.writeFileSync(path.join(OUT, 'pacing.json'), JSON.stringify(pacing));
// Hitch attribution from the core's own per-frame timings (VM frames: [at, frameMs, sleepMs, jitMs, discMs, gsWaitMs]).
const frames = await page.evaluate(() => window.__frames);
fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify(frames));
if (frames.vm.length) {
  const t = (at) => ((at - frames.vm[0][0]) / 1000).toFixed(1);
  const slow = frames.vm.filter((f) => f[1] > 25);
  const cause = (f) => {
    const work = f[1] - f[2] - f[3] - f[4] - f[5];
    const parts = { jit: f[3], disc: f[4], 'gs wait': f[5], emulation: work };
    return Object.entries(parts).sort((a, b) => b[1] - a[1])[0][0];
  };
  const byCause = {};
  for (const f of slow) byCause[cause(f)] = (byCause[cause(f)] ?? 0) + 1;
  console.log(`VM frames: ${frames.vm.length}, over 25 ms: ${slow.length} (${Object.entries(byCause).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  for (const f of slow.filter((f) => f[1] > 50).slice(0, 25))
    console.log(`  t=${t(f[0])}s frame ${f[1].toFixed(0)} ms: jit ${f[3].toFixed(0)}, disc ${f[4].toFixed(0)}, gs wait ${f[5].toFixed(0)}, sleep ${f[2].toFixed(0)}`);
  const gsSlow = frames.gs.filter((g, i) => i > 0 && g[0] - frames.gs[i - 1][0] > 25);
  console.log(`GS presents: ${frames.gs.length}, gaps over 25 ms: ${gsSlow.length}; max GS busy per picture ${Math.max(...frames.gs.map((g) => g[1])).toFixed(0)} ms`);
  const intervals = frames.gs.slice(1).map((g, i) => g[0] - frames.gs[i][0]).filter((x) => x < 100);
  const jitter = intervals.filter((x) => Math.abs(x - 16.67) > 4).length;
  console.log(`present intervals off 16.7 ms by >4 ms: ${jitter}/${intervals.length}`);
}
if (pacing.some((p) => p.jitN)) {
  const n = pacing.reduce((a, p) => a + p.jitN, 0);
  const ms = pacing.reduce((a, p) => a + p.jitMs, 0);
  console.log('per-second JIT blocks compiled:', pacing.map((p) => p.jitN).join(' '));
  console.log('per-second JIT module compile ms:', pacing.map((p) => p.jitMs).join(' '));
  console.log(`JIT: ${n} blocks, ${ms} ms in WebAssembly.Module (${((ms * 1000) / Math.max(1, n)).toFixed(0)} us each)`);
}
console.log('per-second worst frame (ms):', pacing.map((p) => p.gapMax).join(' '));
console.log('per-second disc blocks:', pacing.map((p) => p.reads).join(' '));
console.log('per-second VM disc wait (ms):', pacing.map((p) => p.vmWait).join(' '));
const hitches = pacing.reduce((a, p) => a + p.hitches, 0);
const bad = pacing.filter((p) => p.gapMax > 50).length;
console.log(`hitches (>50 ms frames): ${hitches} total, in ${bad}/${pacing.length} seconds; disc reads ${pacing.reduce((a, p) => a + p.reads, 0)}`);
const nums = all.filter((x) => typeof x === 'number');
const tail = nums.slice(-60);
console.log('per-second fps:', nums.join(' '));
console.log(`avg fps last 60s: ${(tail.reduce((a, b) => a + b, 0) / tail.length).toFixed(1)}  min ${Math.min(...tail)} max ${Math.max(...tail)}`);
const finalSamples = pacing.slice(-10);
const deliveredFps = finalSamples.length ? finalSamples.reduce((sum, p) => sum + p.fps, 0) / finalSamples.length : 0;
console.log(`delivered pictures, last ${finalSamples.length} samples: ${deliveredFps.toFixed(1)} fps`);
if (deliveredFps < Number(arg('min-fps', 0))) {
  console.error('FAIL: delivered picture rate is below --min-fps');
  process.exitCode = 1;
}
if (ANDROID) await shutdownAndroid();
else await browser.close();
