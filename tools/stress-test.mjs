#!/usr/bin/env node
/**
 * Headless stability test: launches a game, then hammers the things that used to freeze it:
 * rapid pause-menu toggling, tab hide/show (with and without the menu open), window blur/focus,
 * and all of those interleaved. After every scenario it checks that the page still answers and
 * that the core is actually emulating (it queues audio and draws frames only while running).
 *
 *   node tools/stress-test.mjs [--url http://localhost:5173] [--game "Crash Bash"] [--rounds 3] [--keep]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const URL = arg('url', 'http://localhost:5173');
const GAME = arg('game', null);
const ROUNDS = Number(arg('rounds', 3));
const SHOTS = 'work/shots/stress';
fs.mkdirSync(SHOTS, { recursive: true });

function firstInviteCode() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'invites.json'), 'utf8'));
    return list.find((i) => !i.revokedAt)?.code ?? null;
  } catch {
    return null;
  }
}

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) =>
  fs.existsSync(p),
);
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  protocolTimeout: 20_000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800', '--no-sandbox'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => {
  const t = m.text();
  // The core logs a couple of harmless [ERROR] lines at boot; only real faults count.
  if (/RuntimeError|Aborted|unreachable|out of bounds|Uncaught/i.test(t)) {
    errors.push(t);
    console.log('  console:', t.slice(0, 200));
  }
});
page.on('pageerror', (e) => {
  errors.push(e.message);
  console.log('  pageerror:', e.message);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const step = (s) => console.log(`\n== ${s}`);
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

/** Resolves false if the main thread does not answer in time (a hung core loop). */
async function alive(ms = 4000) {
  return Promise.race([page.evaluate(() => true).catch(() => false), wait(ms).then(() => false)]);
}

/** Counts audio buffers queued and game-canvas draws over a window. Both only move while emulating. */
async function activity(ms = 1500) {
  return page.evaluate(async (ms) => {
    const p = window.__probe;
    const a0 = p.audio;
    const d0 = p.draws;
    await new Promise((r) => setTimeout(r, ms));
    return { audio: p.audio - a0, draws: p.draws - d0, status: window.__wsx?.session?.status, menu: !!document.querySelector('.pause-menu') };
  }, ms);
}

async function installProbe() {
  await page.evaluate(() => {
    const p = (window.__probe = { audio: 0, draws: 0 });
    const proto = (window.BaseAudioContext || window.AudioContext).prototype;
    const csrc = proto.createBufferSource;
    proto.createBufferSource = function (...a) {
      p.audio++;
      return csrc.apply(this, a);
    };
    const c = document.querySelector('canvas:not(.fx-scene)');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    for (const fn of ['drawArrays', 'drawElements']) {
      const o = gl[fn].bind(gl);
      gl[fn] = (...a) => {
        p.draws++;
        return o(...a);
      };
    }
    // Fake tab visibility so the app and the core both see a hidden page.
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    window.__setHidden = (v) => {
      hidden = v;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
}

const menuOpen = () => page.evaluate(() => !!document.querySelector('.pause-menu'));
const esc = () => page.keyboard.press('Escape');
const setHidden = (v) => page.evaluate((v) => window.__setHidden(v), v);
const blur = () => page.evaluate(() => (window.dispatchEvent(new Event('blur')), document.activeElement?.blur?.()));
const focus = () => page.evaluate(() => (window.dispatchEvent(new Event('focus')), document.querySelector('canvas:not(.fx-scene)')?.focus()));

/** Bring the game back to plain running (menu closed, visible) and demand it is emulating. */
async function settleAndCheck(label) {
  if (!(await alive())) throw new Error(`${label}: page stopped responding (main thread hung)`);
  await setHidden(false);
  await wait(300);
  if (await menuOpen()) {
    await esc();
    await wait(400);
  }
  await wait(1200);
  const a = await activity();
  const ok = a.audio > 20 && a.draws > 20 && !a.menu;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(a)}`);
  if (!ok) {
    await page.screenshot({ path: path.join(SHOTS, `fail-${label.replace(/\W+/g, '_')}.png`) }).catch(() => {});
    throw new Error(`${label}: emulator is not running after settling`);
  }
}

const scenarios = {
  async rapidMenu() {
    for (let i = 0; i < 40; i++) {
      await esc();
      await wait(rnd(15, 200));
    }
  },
  async menuHold() {
    for (let i = 0; i < 6; i++) {
      await esc();
      await wait(rnd(400, 900));
      await esc();
      await wait(rnd(50, 400));
    }
  },
  async hideWhilePlaying() {
    for (let i = 0; i < 8; i++) {
      await setHidden(true);
      await wait(rnd(50, 600));
      await setHidden(false);
      await wait(rnd(50, 400));
    }
  },
  async hideWithMenu() {
    for (let i = 0; i < 6; i++) {
      await esc();
      await wait(rnd(50, 300));
      await setHidden(true);
      await wait(rnd(50, 500));
      await setHidden(false);
      await wait(rnd(20, 200));
      await esc();
      await wait(rnd(50, 300));
    }
  },
  async blurFocus() {
    for (let i = 0; i < 10; i++) {
      await blur();
      await wait(rnd(20, 300));
      await focus();
      await wait(rnd(20, 300));
    }
  },
  async chaos() {
    const acts = [esc, esc, esc, () => setHidden(true), () => setHidden(false), blur, focus];
    for (let i = 0; i < 60; i++) {
      await acts[Math.floor(Math.random() * acts.length)]();
      await wait(rnd(0, 150));
    }
  },
  async settingsInMenu() {
    for (let i = 0; i < 4; i++) {
      await esc();
      await page.waitForSelector('.pause-menu', { timeout: 3000 });
      await clickText('Settings');
      await wait(rnd(100, 400));
      await esc(); // close settings
      await wait(rnd(50, 200));
      await esc(); // close pause menu
      await wait(rnd(100, 400));
    }
  },
};

try {
  step('Boot + sign in');
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await wait(1000);
  await page.keyboard.press('Enter');
  await wait(800);
  await page.waitForFunction(() => document.querySelector('.login, .profile-card, .library'), { timeout: 15000 });
  if (await page.$('.login')) {
    const code = arg('code', firstInviteCode());
    if (!code) throw new Error('Sign-in screen shown but no invite code: pass --code');
    await page.keyboard.type(code, { delay: 30 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.login'), { timeout: 10000 });
  }
  await page.waitForSelector('.profile-card', { timeout: 10000 });
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
  await page.waitForSelector('.game-card', { timeout: 10000 });
  await wait(600);

  step('Launch');
  if (GAME) {
    const front = await page.evaluate((t) => !!document.querySelector('.game-card.selected')?.textContent.includes(t), GAME);
    await clickText(GAME, '.game-card');
    if (!front) {
      await wait(900);
      await clickText(GAME, '.game-card');
    }
  } else await page.click('.game-card.selected');
  await wait(400);
  if (await page.$('.resume-pick')) {
    await clickText('Start from the disc');
    await wait(400);
  }
  if (await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Single Player')))) await clickText('Single Player');
  await page.waitForFunction(() => window.__wsx?.session?.status === 'running', { timeout: 120000 });
  await wait(3000);
  await installProbe();
  await settleAndCheck('baseline');

  // Sanity check the probe: with the menu open the core must be idle (no audio queued).
  await esc();
  await page.waitForSelector('.pause-menu', { timeout: 3000 });
  await wait(500);
  const held = await activity();
  console.log(`   ${held.audio === 0 ? 'ok  ' : 'FAIL'} menu pauses the core: ${JSON.stringify(held)}`);
  if (held.audio !== 0) throw new Error('Emulator keeps running with the pause menu open');
  await settleAndCheck('menu closes with Esc');

  const only = arg('only', null);
  for (let r = 1; r <= ROUNDS; r++) {
    step(`Round ${r}/${ROUNDS}`);
    for (const [name, fn] of Object.entries(scenarios)) {
      if (only && !only.split(',').includes(name)) continue;
      await fn();
      await settleAndCheck(`${name}#${r}`);
    }
  }
  if (errors.length) throw new Error(`${errors.length} page error(s) logged`);
  console.log('\nSTRESS TEST PASSED');
} catch (e) {
  console.error('\nSTRESS TEST FAILED:', e.message);
  process.exitCode = 1;
} finally {
  if (!process.argv.includes('--keep')) await browser.close().catch(() => {});
}
