#!/usr/bin/env node
/**
 * End-to-end test of a PS2 game in the real app, in headless Chrome on the real GPU (the PS2 core
 * needs WebGL2 in a worker; SwiftShader works but is far too slow to judge anything).
 *
 *   node tools/ps2-test.mjs [--url http://localhost:5173] [--game thps4] [--code <invite>]
 *        [--play "60:Enter,75:Enter,90:KeyX"] [--secs 120] [--shots work/shots/ps2] [--quick]
 *        [--min-fps 45] require the last 30 samples to sustain this delivered picture rate
 *        [--state-file path.sav] start the lifecycle check from a local gameplay state
 *
 * Boots the UI, signs in, picks/creates the "Smoke" profile, launches the game single player, sends
 * the --play key presses (seconds after boot : key code; the keyboard player uses the profile's
 * bindings, by default Enter = Start, X = Cross), samples frames per second for --secs, then goes
 * through the pause menu (save, load), quits (suspend) and continues the suspended game.
 * --quick skips the long play-through and only checks boot + menu + suspend/continue.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const URL = arg('url', 'http://localhost:5173');
const GAME = arg('game', 'thps4');
const STATE_FILE = arg('state-file', '');
const SHOTS = arg('shots', 'work/shots/ps2');
const QUICK = process.argv.includes('--quick');
const SECS = Number(arg('secs', QUICK ? 25 : 300));
const MIN_FPS = Number(arg('min-fps', '0'));
if (!Number.isFinite(MIN_FPS) || MIN_FPS < 0) throw new Error('--min-fps must be a nonnegative number');
const PLAY = arg('play', QUICK ? '' : '60:Enter,75:Enter,90:KeyX,106:Enter,120:KeyX,135:KeyX,150:KeyX,165:KeyX,180:KeyX,195:KeyX,210:KeyX,225:KeyX');
fs.mkdirSync(SHOTS, { recursive: true });

function firstInviteCode() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'invites.json'), 'utf8'));
    return list.find((i) => !i.revokedAt)?.code ?? null;
  } catch {
    return null;
  }
}

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: [
    '--use-gl=angle',
    '--use-angle=d3d11',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,800',
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
  defaultViewport: { width: 1280, height: 800 },
  protocolTimeout: 60000,
  // --user-data <dir>: keep the browser profile (IndexedDB caches) between runs
  ...(arg('user-data', '') ? { userDataDir: arg('user-data', '') } : {}),
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => {
  const t = m.text();
  logs.push(t);
  if ((/error|Error|failed/.test(t) && !/favicon|Wake Lock|Registered function/.test(t)) || t.startsWith('[ps2]')) console.log('  console:', t.slice(0, 220));
});
page.on('pageerror', (e) => console.log('  pageerror:', e.message));
page.on('workercreated', (w) => w.on('console', (m) => /error|Error|abort/.test(m.text()) && console.log('  worker:', m.text().slice(0, 220))));

const step = (s) => console.log(`\n== ${s}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const p = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: p });
  console.log(`   screenshot -> ${p}`);
};
const clickText = async (text, sel = 'button') => {
  const ok = await page.evaluate(
    (text, sel) => {
      const el = [...document.querySelectorAll(sel)].find((b) => b.textContent.trim().includes(text));
      if (!el) return false;
      el.click();
      return true;
    },
    text,
    sel,
  );
  if (!ok) throw new Error(`No ${sel} with text "${text}"`);
};
const tap = async (code, ms = 120) => {
  await page.focus('canvas.game-canvas');
  await page.keyboard.down(code);
  await wait(ms);
  await page.keyboard.up(code);
};
const openGame = async (click = true) => {
  const sel = `.game-card[data-game="${GAME}"]`;
  await page.waitForSelector(sel, { timeout: 10000 });
  // Walk the shelf with the arrow keys until the game is the front case, then play it.
  for (const key of ['ArrowRight', 'ArrowLeft']) {
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate((s) => document.querySelector(s)?.classList.contains('selected'), sel)) break;
      await page.keyboard.press(key);
      await wait(120);
    }
  }
  if (!(await page.evaluate((s) => document.querySelector(s)?.classList.contains('selected'), sel))) throw new Error(`Could not bring ${GAME} to the front`);
  await wait(1400);
  await shot('00-front-case');
  if (click) await page.click(`${sel}.selected`);
};
/** Frames per second presented by the core, sampled once a second for `secs`. */
const audioLog = [];
const sampleFps = async (secs, presses = [], t0 = Date.now()) => {
  const out = [];
  const pending = presses.map((p) => ({ ...p, done: false }));
  await page.evaluate(() => window.__wsx.session.module.clearStats());
  const readFrames = () => page.evaluate(() => ({ count: window.__wsx.session.presentedFrames, at: performance.now() }));
  let previous = await readFrames();
  for (let i = 0; i < secs; i++) {
    await wait(1000);
    const s = (Date.now() - t0) / 1000;
    for (const p of pending) {
      if (!p.done && s >= p.at) {
        p.done = true;
        await tap(p.key);
      }
    }
    audioLog.push(await page.evaluate(() => window.__wsx.session.audio));
    const current = await readFrames();
    // Input presses and screenshots also consume time between samples.
    out.push(Number(((current.count - previous.count) * 1000 / (current.at - previous.at)).toFixed(1)));
    previous = current;
    if (i % 15 === 14) await shot(`play-${String(Math.round(s)).padStart(3, '0')}`);
  }
  return out;
};
/** Samples every thread (page + workers) with the V8 profiler; prints the hottest functions per thread. */
async function cpuProfile(secs) {
  const main = await page.createCDPSession();
  const targets = [{ name: 'main', client: main }, ...page.workers().map((w, i) => ({ name: `worker${i}`, client: w.client }))];
  for (const t of targets) {
    await t.client.send('Profiler.enable');
    await t.client.send('Profiler.setSamplingInterval', { interval: 250 });
    await t.client.send('Profiler.start');
  }
  await wait(secs * 1000);
  for (const t of targets) {
    const { profile } = await t.client.send('Profiler.stop');
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map();
    for (const id of profile.samples) {
      const f = byId.get(id).callFrame.functionName || '(anonymous)';
      self.set(f, (self.get(f) ?? 0) + 1);
    }
    const total = profile.samples.length;
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top[0] && /idle|futex_wait|timedwait/.test(top[0][0]) && top[0][1] / total > 0.97) continue;
    console.log(`   [${t.name}] ` + top.map(([f, c]) => `${((c / total) * 100).toFixed(0)}% ${f.slice(0, 60)}`).join(' | '));
  }
}
const launchSingle = async (resume) => {
  await openGame();
  await wait(500);
  if (await page.$('.resume-pick')) {
    await clickText(resume ? 'Continue' : 'Start from the disc');
    await wait(400);
  }
  if (await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Single Player'))))
    await clickText('Single Player');
  const t0 = Date.now();
  await page.waitForFunction(() => window.__wsx?.session?.status === 'running', { timeout: 120000 });
  console.log(`   running after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return t0;
};

let failed = false;
try {
  step('Boot');
  await page.goto(URL, { waitUntil: 'networkidle0' });
  console.log('   crossOriginIsolated:', await page.evaluate(() => crossOriginIsolated));
  await wait(1200);
  await page.keyboard.press('Enter');
  await wait(800);

  step('Sign in');
  await page.waitForFunction(() => document.querySelector('.login, .profile-card, .library'), { timeout: 15000 });
  if (await page.$('.login')) {
    const code = arg('code', firstInviteCode());
    if (!code) throw new Error('Sign-in screen shown but no invite code: pass --code or create one with npm run invite');
    await page.keyboard.type(code, { delay: 30 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.login'), {
      timeout: 10000,
    });
  }

  step('Profile');
  await page.waitForFunction(() => document.querySelector('.profile-card, .game-card'), { timeout: 10000 });
  // A kept profile (--user-data) may go straight to the library.
  if (await page.$('.profile-card')) {
    const hasSmoke = await page.evaluate(() => [...document.querySelectorAll('.profile-card')].some((c) => c.textContent.includes('Smoke')));
    if (hasSmoke) await clickText('Smoke', '.profile-card');
    else {
      await clickText('New profile', '.profile-card');
      await page.waitForSelector('.osk-input');
      await page.type('.osk-input', 'Smoke');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.avatar-pick');
      await page.click('.avatar-pick');
    }
  }
  await page.waitForSelector('.game-card', { timeout: 10000 });
  // Don't click: a 1-player game launches straight from the case (2-player ones open a picker).
  await openGame(false);
  await wait(1500);
  await shot('01-library');

  step(`Launch ${GAME}`);
  // Start fresh: drop earlier saves of the test profile for this game.
  let t0 = await launchSingle(false);
  if (STATE_FILE) {
    await page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      await window.__wsx.session.loadState(new Blob([bytes]));
    }, fs.readFileSync(STATE_FILE).toString('base64'));
    t0 = Date.now();
  }
  await wait(3000);
  await shot('02-booting');

  step('Audio + memory card');
  const audio = await page.evaluate(() => window.__wsx.session.audio);
  console.log('   audio:', JSON.stringify(audio));
  if (audio.state !== 'running') throw new Error(`Audio context is ${audio.state}`);
  // Round-trip a fake save through the card packer and the core's filesystem.
  const card = await page.evaluate(async () => {
    const m = window.__wsx.session.module;
    const root = m.getMemoryCardPath(0);
    const dir = `${root}/BASLUS-TEST`;
    if (!m.FS.analyzePath(dir).exists) m.FS.mkdir(dir);
    m.FS.writeFile(`${dir}/save.bin`, new Uint8Array([1, 2, 3, 4, 250]));
    const blob = await window.__wsx.session.saveMemcard();
    m.FS.unlink(`${dir}/save.bin`);
    m.FS.rmdir(dir);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let back;
    try {
      // Dev server: unpack with the app's own code. A production build has no /src, so there we
      // just find the file's bytes right after its name in the packed card.
      const { unpackCard } = await import('/src/emu/ps2/memcard.ts');
      unpackCard(m.FS, root, bytes);
      back = [...m.FS.readFile(`${dir}/save.bin`)];
      m.FS.unlink(`${dir}/save.bin`);
      m.FS.rmdir(dir);
    } catch {
      const name = new TextEncoder().encode('BASLUS-TEST/save.bin');
      const at = bytes.findIndex((_, i) => name.every((c, k) => bytes[i + k] === c));
      back = at < 0 ? [] : [...bytes.subarray(at + name.length + 5, at + name.length + 10)];
    }
    return { size: blob.size, back };
  });
  console.log('   memory card round trip:', JSON.stringify(card));
  if (card.back.join(',') !== '1,2,3,4,250') throw new Error('memory card round trip failed');

  step(`Play for ${SECS} s`);
  const presses = PLAY.split(',')
    .filter(Boolean)
    .map((p) => ({ at: Number(p.split(':')[0]), key: p.split(':')[1] }));
  const fps = await sampleFps(SECS, presses, t0);
  console.log('   fps per second:', fps.join(' '));
  const tail = fps.slice(-30);
  const tailFps = tail.reduce((a, b) => a + b, 0) / tail.length;
  console.log(`   last 30 s: avg ${tailFps.toFixed(1)}, min ${Math.min(...tail)}`);
  await shot('03-playing');
  if (!fps.some((value) => Number.isFinite(value) && value > 0)) throw new Error('No frames presented');
  if (MIN_FPS > 0 && (!Number.isFinite(tailFps) || tailFps < MIN_FPS))
    throw new Error(`Delivered picture rate ${tailFps.toFixed(1)} fps is below ${MIN_FPS}; game may have stalled after boot`);
  const disc = await page.evaluate(() => {
    const d = window.__wsx.session.disc;
    return d ? { ...d.stats, sizeMB: Math.round(d.size / 1048576) } : null;
  });
  console.log('   disc:', JSON.stringify(disc));
  console.log('   audio underruns per second:', audioLog.map((a, i) => (i ? a.underruns - audioLog[i - 1].underruns : 0)).join(' '));
  console.log('   audio min buffer per second (ms):', audioLog.map((a) => a.minFillMs).join(' '));
  console.log('   audio after play:', JSON.stringify(await page.evaluate(() => window.__wsx.session.audio)));

  step('Pause menu + save');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.pause-menu', { timeout: 5000 });
  const heldStatus = await page.evaluate(() => window.__wsx.session.status);
  console.log('   status while menu open:', heldStatus);
  await shot('04-pause');
  await clickText('Save progress');
  await page.waitForFunction(() => !document.querySelector('.pause-menu'), {
    timeout: 30000,
  });
  console.log('   toast:', await page.evaluate(() => document.querySelector('.toast')?.textContent));
  await wait(1500);

  step('Load progress');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.pause-menu');
  await clickText('Load progress');
  await page.waitForSelector('.save-item', { timeout: 10000 });
  await shot('05-load-list');
  // The dialog animates over the pause menu. A coordinate click while it is
  // moving can hit Resume underneath and never exercise the load operation.
  await page.$eval('.save-item', (el) => el.click());
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent === 'Progress loaded', { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.pause-menu'), {
    timeout: 30000,
  });
  console.log('   toast:', await page.evaluate(() => document.querySelector('.toast')?.textContent));
  const afterLoad = await sampleFps(5);
  console.log('   fps after load:', afterLoad.join(' '));
  if (!afterLoad.some((fps) => Number.isFinite(fps) && fps > 0)) {
    // What the core is doing, for the report: a paused VM, a stuck thread and a game that draws nothing look the same from outside.
    const dump = await page.evaluate(async () => {
      const s = window.__wsx.session;
      const m = s.module;
      const pcs = [];
      const v0 = m.getVblankCount();
      for (let i = 0; i < 5; i++) {
        pcs.push(new Uint32Array(m.HEAPU8.buffer, m.getEePcAddress(), 1)[0].toString(16));
        await new Promise((r) => setTimeout(r, 200));
      }
      return { status: s.status, vmStatus: m.getVmStatus(), vblanksIn1s: m.getVblankCount() - v0, pcs, ee: m.getEeStats?.(), vpu1: m.getVpu1Stats?.(), pipeline: [m.getPipelineState?.(), await new Promise((r) => setTimeout(() => r(m.getPipelineState?.()), 500))] };
    });
    console.log('   core after load:', JSON.stringify(dump));
    throw new Error('No pictures after loading');
  }

  step('Quit (suspend) and continue');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.pause-menu');
  await clickText('Quit to library');
  await page.waitForSelector('.library', { timeout: 60000 });
  await wait(2000);
  await shot('06-library-after');
  console.log('   suspended save shown:', await page.evaluate(() => document.querySelector('.detail')?.textContent.includes('Suspended')));
  await launchSingle(true);
  if (process.argv.includes('--profile-continue')) await cpuProfile(5);
  const cont = await sampleFps(10);
  console.log('   fps after continue:', cont.join(' '));
  await shot('07-continued');
  if (!cont.some((value) => Number.isFinite(value) && value > 0)) throw new Error('No frames after continuing');

  step('Quit again');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.pause-menu');
  await clickText('Quit to library');
  await page.waitForSelector('.library', { timeout: 60000 });
  console.log('\nPASS');
} catch (e) {
  failed = true;
  console.log('\nFAIL:', e.message);
  console.log('   session:', await page.evaluate(() => {
    const s = window.__wsx?.session;
    return s ? { status: s.status, holds: [...(s.holds ?? [])], frames: s.presentedFrames, vblanks: s.module?.getVblankCount?.() } : null;
  }).catch(() => null));
  await shot('zz-failure').catch(() => {});
  console.log(
    logs
      .filter((l) => !/Registered function/.test(l))
      .slice(-25)
      .join('\n'),
  );
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
