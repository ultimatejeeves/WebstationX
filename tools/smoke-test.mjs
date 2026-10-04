#!/usr/bin/env node
/**
 * Headless end-to-end smoke test: boots the UI, creates a profile, launches a game (the first one,
 * or --game <title>),
 * verifies the emulator actually draws frames, exercises save/load, and quits.
 *
 *   node tools/smoke-test.mjs [--url http://localhost:5173] [--game "Ape Escape"] [--keep] [--shots work/shots]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const URL = arg('url', 'http://localhost:5173');
const SHOTS = arg('shots', 'work/shots');
const GAME = arg('game', null);
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
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1600,900',
    '--no-sandbox',
  ],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => {
  const t = m.text();
  logs.push(t);
  if (/error|ERROR|WARN/.test(t) && !/Wake Lock|favicon/.test(t)) console.log('  console:', t.slice(0, 200));
});
page.on('pageerror', (e) => console.log('  pageerror:', e.message));

const step = (s) => console.log(`\n== ${s}`);
const shot = async (name) => {
  const p = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: p });
  console.log(`   screenshot -> ${p}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const openGame = async () => {
  // A click on a side case only brings it forward; clicking the front case plays it.
  if (!GAME) return page.click('.game-card.selected');
  const front = await page.evaluate((t) => !!document.querySelector('.game-card.selected')?.textContent.includes(t), GAME);
  await clickText(GAME, '.game-card');
  if (!front) {
    await wait(900);
    await clickText(GAME, '.game-card');
  }
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
const tap = async (key, ms = 120) => {
  await page.keyboard.down(key);
  await wait(ms);
  await page.keyboard.up(key);
};

try {
  step('Boot');
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await wait(1200);
  await shot('01-boot');
  await page.keyboard.press('Enter'); // skip boot
  await wait(800);

  step('Sign in');
  await page.waitForFunction(() => document.querySelector('.login, .profile-card, .library'), { timeout: 15000 });
  if (await page.$('.login')) {
    const code = arg('code', firstInviteCode());
    if (!code) throw new Error('Sign-in screen shown but no invite code: pass --code or create one with npm run invite');
    await shot('01b-login');
    await page.keyboard.type(code, { delay: 30 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.login'), { timeout: 10000 });
    console.log('   signed in');
  } else console.log('   no gate (open access or already signed in)');

  step('Profile');
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
  await shot('02-library');

  step('Launch single player');
  await openGame();
  await wait(400);
  if (await page.$('.resume-pick')) {
    await clickText('Start from the disc');
    await wait(400);
  }
  // One-player games launch straight away; the rest ask Single Player / Multiplayer first.
  const onePlayer = !(await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Single Player'))));
  if (!onePlayer) await clickText('Single Player');
  await page.waitForFunction(() => window.__wsx?.session?.status === 'running', { timeout: 120000 });
  console.log('   emulator running');
  await wait(6000);

  step('Verify frames are drawn');
  const stats = await page.evaluate(async () => {
    const c = document.querySelector('canvas:not(.fx-scene)');
    const gl = c.getContext('webgl') || c.getContext('webgl2');
    let draws = 0;
    let maxNon = 0;
    const oa = gl.drawArrays.bind(gl);
    const oe = gl.drawElements.bind(gl);
    const px = new Uint8Array(64 * 64 * 4);
    const check = () => {
      draws++;
      if (gl.getParameter(gl.FRAMEBUFFER_BINDING) === null) {
        gl.readPixels(gl.drawingBufferWidth / 2 - 32, gl.drawingBufferHeight / 2 - 32, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let non = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 30) non++;
        maxNon = Math.max(maxNon, non / (px.length / 4));
      }
    };
    gl.drawArrays = (...a) => {
      const r = oa(...a);
      check();
      return r;
    };
    gl.drawElements = (...a) => {
      const r = oe(...a);
      check();
      return r;
    };
    let rafs = 0;
    const id = (function loop() {
      rafs++;
      return requestAnimationFrame(loop);
    })();
    await new Promise((r) => setTimeout(r, 3000));
    cancelAnimationFrame(id);
    gl.drawArrays = oa;
    gl.drawElements = oe;
    return { draws, rafs, maxNon, vis: document.visibilityState };
  });
  console.log('  ', stats);
  await shot('03-game');
  if (stats.draws === 0) throw new Error('Emulator is not drawing frames');

  step('Send Start and Cross to the game');
  await tap('Enter');
  await wait(4000);
  await tap('KeyX');
  await wait(4000);
  await shot('04-after-input');

  step('Pause menu + save state');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.pause-menu', { timeout: 5000 });
  await shot('05-pause');
  await clickText('Save progress');
  await page.waitForFunction(() => !document.querySelector('.pause-menu'), { timeout: 20000 });
  console.log('   saved; toast:', await page.evaluate(() => document.querySelector('.toast')?.textContent));
  await wait(500);

  step('Load state list');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.pause-menu');
  await clickText('Load progress');
  await page.waitForSelector('.save-item', { timeout: 10000 });
  console.log('   save slots:', await page.$$eval('.save-item', (a) => a.length));
  await shot('06-load');
  await page.click('.save-item');
  await page.waitForFunction(() => !document.querySelector('.pause-menu'), { timeout: 20000 });
  console.log('   loaded');

  step('Quit to library (suspend)');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.pause-menu');
  await clickText('Quit to library');
  await page.waitForSelector('.library', { timeout: 30000 });
  await wait(1500);
  await shot('07-library-after');
  console.log('   suspended save visible:', await page.evaluate(() => document.querySelector('.detail')?.textContent.includes('Suspended')));

  // One-player games have no Multiplayer option, so there is no lobby to open.
  if (!onePlayer) {
    step('Multiplayer lobby');
    await openGame();
    await wait(400);
    if (await page.$('.resume-pick')) {
      await clickText('Continue');
      await wait(400);
    }
    await clickText('Multiplayer');
    await page.waitForSelector('.lobby', { timeout: 10000 });
    await wait(500);
    await shot('08-lobby');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.library', { timeout: 10000 });
  }

  console.log('\nSMOKE TEST PASSED');
} catch (e) {
  console.error('\nSMOKE TEST FAILED:', e.message);
  await shot('99-failure').catch(() => {});
  console.log('last core logs:\n' + logs.filter((l) => l.includes('[core]')).slice(-25).join('\n'));
  process.exitCode = 1;
} finally {
  if (!process.argv.includes('--keep')) await browser.close();
}
