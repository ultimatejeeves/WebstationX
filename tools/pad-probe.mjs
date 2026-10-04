#!/usr/bin/env node
/**
 * Does RetroArch read our virtual gamepads? Single page, no networking.
 *
 * Launches single player with RetroArch's menu toggle bound to F8 (keyboard) and to button 9
 * (Start) of the Player 1 joypad. Before launch we allocate a virtual pad (it lands in
 * gamepad slot 0) and point Player 1's joypad index at it. Then:
 *   1. F8 must open RGUI (control: hotkeys work at all)
 *   2. Pressing Start on the virtual pad must open RGUI (RetroArch reads the virtual pad)
 * RGUI is detected by counting green pixels in a page screenshot.
 *
 *   node tools/pad-probe.mjs [--url http://localhost:5174] [--no-vpad]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const URL = arg('url', 'http://localhost:5174');
const USE_VPAD = !process.argv.includes('--no-vpad');
const SHOTS = 'work/shots';
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
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800', '--no-sandbox'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  pageerror:', e.message));
page.on('console', (m) => {
  const t = m.text();
  if (/autoconf|configured|\[Input\]|joypad|pad /i.test(t) && !/port:/.test(t)) console.log('  console:', t.slice(0, 160));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
const pixelDiff = async (a, b) => {
  const [ra, rb] = await Promise.all([a, b].map((png) => sharp(png).resize(320, 200, { fit: 'fill' }).raw().toBuffer()));
  let n = 0;
  for (let i = 0; i < ra.length; i += 3) if (Math.abs(ra[i] - rb[i]) + Math.abs(ra[i + 1] - rb[i + 1]) + Math.abs(ra[i + 2] - rb[i + 2]) > 60) n++;
  return n;
};
const greenRatio = async (name) => {
  const png = await page.screenshot({ path: path.join(SHOTS, `probe-${name}.png`) });
  const { data } = await sharp(png).resize(160, 120, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let green = 0;
  for (let i = 0; i < data.length; i += 3) if (data[i] + data[i + 1] + data[i + 2] > 60) green++; // lit pixels: RGUI fills the screen
  return +(green / (data.length / 3)).toFixed(3);
};

try {
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await wait(600);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.login, .profile-card, .library'), { timeout: 15000 });
  if (await page.$('.login')) {
    await page.keyboard.type(firstInviteCode(), { delay: 20 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.login'), { timeout: 10000 });
  }
  await page.waitForSelector('.profile-card', { timeout: 10000 });
  if (await page.evaluate(() => [...document.querySelectorAll('.profile-card')].some((c) => c.textContent.includes('Smoke')))) await clickText('Smoke', '.profile-card');
  else {
    await clickText('New profile', '.profile-card');
    await page.waitForSelector('.osk-input');
    await page.type('.osk-input', 'Smoke');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.avatar-pick');
    await page.click('.avatar-pick');
  }
  await page.waitForSelector('.game-card', { timeout: 10000 });
  await wait(400);

  // Instrument gamepad listener registration and event dispatch order.
  await page.evaluate(() => {
    window.__evlog = [];
    const oa = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (t, l, o) {
      if (typeof t === 'string' && t.startsWith('gamepad')) window.__evlog.push(['add', t, Math.round(performance.now()), this === window ? 'window' : String(this)]);
      return oa.call(this, t, l, o);
    };
    const od = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (e) {
      if (e?.type?.startsWith('gamepad')) window.__evlog.push(['dispatch', e.type, Math.round(performance.now()), e.gamepad ? `${e.gamepad.index}:${e.gamepad.id?.slice(0, 12)}` : 'no-gamepad']);
      return od.call(this, e);
    };
  });
  const cfg = { input_menu_toggle: 'f8', menu_driver: 'rgui', input_menu_toggle_btn: 9 };
  if (USE_VPAD) cfg.input_player1_joypad_index = 0;
  const alloc = await page.evaluate((cfg, useVpad) => {
    window.__wsxCfgOverride = cfg;
    if (!useVpad) return null;
    const pad = window.__wsxAllocVirtualPad('Probe');
    window.__probePad = pad;
    return pad && { index: pad.index, id: pad.id };
  }, cfg, USE_VPAD);
  console.log('virtual pad:', alloc, '\noverride:', cfg);

  await page.click('.game-card.selected');
  await wait(400);
  if (await page.$('.resume-pick')) {
    await clickText('Start from the disc');
    await wait(400);
  }
  await clickText('Single Player');
  await page.waitForFunction(() => window.__wsx?.session?.status === 'running', { timeout: 120000 });
  console.log('emulator running');
  await wait(5000);
  console.log('gamepad event log:', await page.evaluate(() => window.__evlog));
  await page.evaluate(() => document.querySelector('canvas:not(.fx-scene)')?.focus());

  const g0 = await greenRatio('0-before');
  await page.keyboard.down('F8');
  await wait(150);
  await page.keyboard.up('F8');
  await wait(1500);
  const g1 = await greenRatio('1-after-f8');
  await page.keyboard.down('F8');
  await wait(150);
  await page.keyboard.up('F8');
  await wait(1500);
  const g2 = await greenRatio('2-after-f8-again');
  console.log(`keyboard F8: green ${g0} -> ${g1} -> ${g2}  ${g1 > g0 + 0.3 ? 'MENU OPENED' : 'no menu'}`);

  if (USE_VPAD) {
    const setStart = (on) => page.evaluate((on) => window.__probePad.set(on ? 1 << 9 : 0, [0, 0, 0, 0], (window.__seq = ((window.__seq ?? 0) + 1) & 255)), on);
    await setStart(true);
    await wait(150);
    await setStart(false);
    await wait(1500);
    const g3 = await greenRatio('3-after-vpad-start');
    await setStart(true);
    await wait(150);
    await setStart(false);
    await wait(1500);
    const g4 = await greenRatio('4-after-vpad-start-again');
    console.log(`virtual pad Start: green ${g2} -> ${g3} -> ${g4}  ${g3 > g2 + 0.3 ? 'MENU OPENED (RetroArch reads the virtual pad)' : 'no menu'}`);

    // Re-announce the pad now that RetroArch is definitely listening, then try again.
    await page.evaluate(() => window.dispatchEvent(new GamepadEvent('gamepadconnected', { gamepad: window.__probePad })));
    await wait(1000);
    console.log('event log after re-announce:', await page.evaluate(() => window.__evlog.slice(-3)));
    await setStart(true);
    await wait(150);
    await setStart(false);
    await wait(1500);
    const g5 = await greenRatio('5-after-reannounce-start');
    console.log(`after re-announce, virtual pad Start: green ${g4} -> ${g5}  ${g5 > g4 + 0.3 ? 'MENU OPENED' : 'no menu'}`);
    if (g5 > g4 + 0.3) {
      await setStart(true);
      await wait(150);
      await setStart(false);
      await wait(1000);
    }

    // Stronger check: open the menu with F8, then press D-pad Down (button 13) on the virtual pad.
    await page.keyboard.down('F8');
    await wait(150);
    await page.keyboard.up('F8');
    await wait(1200);
    const before = await page.screenshot();
    await page.evaluate(() => window.__probePad.set(1 << 13, [0, 0, 0, 0], (window.__seq = ((window.__seq ?? 0) + 1) & 255)));
    await wait(150);
    await setStart(false);
    await wait(800);
    const after = await page.screenshot({ path: path.join(SHOTS, 'probe-6-menu-after-vpad-down.png') });
    const diff = await pixelDiff(before, after);
    console.log(`menu cursor moved by virtual pad Down: ${diff} pixels differ  ${diff > 50 ? 'YES' : 'NO'}`);
  }
} catch (e) {
  console.log('PROBE FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
