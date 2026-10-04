#!/usr/bin/env node
/**
 * Does RetroArch read a virtual gamepad that is pinned to PORT 2 while port 1 is the keyboard?
 * This is exactly the host's configuration when a remote friend joins a keyboard host.
 *
 * Config override: player 1 = keyboard (joypad index 33), player 2 = joypad index 0 (our
 * virtual pad), RGUI menu on F8, and `input_all_users_control_menu` so a port-2 pad can move
 * the menu cursor. Success = the menu cursor moves when the virtual pad presses Down.
 *
 *   node tools/port2-probe.mjs [--url http://localhost:5173] [--port 1|2]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const URL = arg('url', 'http://localhost:5173');
const PORT = Number(arg('port', '2'));
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

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
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
  if (/autoconf|Autodetect|joypad|\[Input\]/i.test(t)) console.log('  console:', t.slice(0, 160));
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
const litRatio = async (name) => {
  const png = await page.screenshot({ path: path.join(SHOTS, `port2-${name}.png`) });
  const { data } = await sharp(png).resize(160, 120, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let lit = 0;
  for (let i = 0; i < data.length; i += 3) if (data[i] + data[i + 1] + data[i + 2] > 60) lit++;
  return +(lit / (data.length / 3)).toFixed(3);
};
const press = async (bit, ms = 150) => {
  await page.evaluate((bit) => window.__probePad.set(1 << bit, [0, 0, 0, 0], (window.__seq = ((window.__seq ?? 0) + 1) & 255)), bit);
  await wait(ms);
  await page.evaluate(() => window.__probePad.set(0, [0, 0, 0, 0], (window.__seq = ((window.__seq ?? 0) + 1) & 255)));
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
  await clickText('Smoke', '.profile-card');
  await page.waitForSelector('.game-card', { timeout: 10000 });
  await wait(400);

  const cfg = { input_menu_toggle: 'f8', menu_driver: 'rgui', input_all_users_control_menu: true };
  if (PORT === 2) {
    cfg.input_player1_joypad_index = Number(arg('p1idx', '33'));
    cfg.input_player2_joypad_index = 0;
    cfg.input_libretro_device_p2 = 1;
  } else cfg.input_player1_joypad_index = 0;
  if (process.argv.includes('--no-autodetect')) cfg.input_autodetect_enable = false;
  for (const kv of (arg('extra', '') || '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    cfg[k] = /^(true|false)$/.test(v) ? v === 'true' : /^-?\d+$/.test(v) ? Number(v) : v;
  }
  const TWO = process.argv.includes('--twopads');
  const PRESS_SLOT = Number(arg('press', TWO ? '1' : '0')); // which virtual pad we press: by slot
  if (TWO) {
    cfg.input_player1_joypad_index = 0;
    cfg.input_player2_joypad_index = 1;
    cfg.input_libretro_device_p2 = 1;
  }
  const alloc = await page.evaluate((cfg, two, pressSlot) => {
    window.__wsxCfgOverride = cfg;
    const pad = window.__wsxAllocVirtualPad('Probe');
    const pad2 = two ? window.__wsxAllocVirtualPad('Probe2') : null;
    window.__probePad = two && pressSlot === 1 ? pad2 : pad;
    return { index: pad?.index, index2: pad2?.index, pressing: window.__probePad?.index };
  }, cfg, TWO, PRESS_SLOT);
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
  await page.evaluate(() => document.querySelector('canvas:not(.fx-scene)')?.focus());
  const ports = await page.evaluate(() => {
    const fs = window.__wsx.session['inst'].getEmscriptenFS();
    const txt = new TextDecoder().decode(fs.readFile('/home/web_user/retroarch/userdata/retroarch.cfg'));
    return txt.split('\n').filter((l) => /^(input_player[12]_joypad_index|input_libretro_device_p[12]|input_all_users_control_menu) =/.test(l)).join(' | ');
  });
  console.log('cfg:', ports);

  if (process.argv.includes('--game')) {
    // Game-level check: does the title screen react to Start from the pad under test?
    console.log('waiting for the title screen...');
    await wait(Number(arg('title-wait', '45000')));
    const a = await page.screenshot({ path: path.join(SHOTS, 'port2-game-a.png') });
    await wait(3000);
    const b = await page.screenshot({ path: path.join(SHOTS, 'port2-game-b.png') });
    const idle = await pixelDiff(a, b);
    if (process.argv.includes('--kb')) {
      await page.keyboard.down('Enter');
      await wait(150);
      await page.keyboard.up('Enter');
    } else await press(9, 150); // Start
    await wait(3000);
    const c = await page.screenshot({ path: path.join(SHOTS, 'port2-game-c.png') });
    const reacted = await pixelDiff(b, c);
    console.log(`idle change ${idle} px, after Start ${reacted} px  ${reacted > idle * 3 + 300 ? 'GAME REACTED' : 'no reaction'}`);
    process.exitCode = reacted > idle * 3 + 300 ? 0 : 1;
    await browser.close();
    process.exit();
  }
  const g0 = await litRatio('0-game');
  await page.keyboard.down('F8');
  await wait(150);
  await page.keyboard.up('F8');
  await wait(1500);
  const g1 = await litRatio('1-menu');
  console.log(`F8 menu: lit ${g0} -> ${g1}  ${g1 > g0 + 0.3 ? 'MENU OPENED' : 'no menu (control failed)'}`);
  if (g1 <= g0 + 0.3) throw new Error('control failed: F8 did not open RGUI');

  const before = await page.screenshot();
  for (let i = 0; i < 3; i++) await press(13, 120); // D-pad Down x3
  await wait(700);
  const after = await page.screenshot({ path: path.join(SHOTS, `port2-2-after-down.png`) });
  const diff = await pixelDiff(before, after);
  console.log(`port ${PORT} virtual pad Down moved the menu cursor: ${diff} px differ  ${diff > 50 ? 'YES' : 'NO'}`);

  // Control: keyboard Down must also move it (proves the diff metric works).
  const before2 = await page.screenshot();
  await page.keyboard.down('ArrowDown');
  await wait(120);
  await page.keyboard.up('ArrowDown');
  await wait(700);
  const after2 = await page.screenshot();
  console.log(`keyboard Down moved the menu cursor: ${await pixelDiff(before2, after2)} px differ`);
  console.log(diff > 50 ? `\nPORT ${PORT} PROBE PASSED` : `\nPORT ${PORT} PROBE FAILED`);
  process.exitCode = diff > 50 ? 0 : 1;
} catch (e) {
  console.log('PROBE FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
