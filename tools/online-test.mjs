#!/usr/bin/env node
/**
 * Headless end-to-end test of online play: two browser profiles in one Chrome. The host opens
 * a multiplayer lobby, the remote player joins with the room code, takes a port, the host
 * starts the game, and we verify that video+audio arrive at the remote and that the remote's
 * button presses show up on the host's virtual gamepad.
 *
 *   node tools/online-test.mjs [--url http://localhost:5174] [--code INVITE] [--shots work/shots]
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
const SHOTS = arg('shots', 'work/shots');
fs.mkdirSync(SHOTS, { recursive: true });

function firstInviteCode() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'invites.json'), 'utf8'));
    return list.find((i) => !i.revokedAt)?.code ?? null;
  } catch {
    return null;
  }
}
const INVITE = arg('code', firstInviteCode());

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
    '--window-size=1280,800',
    '--no-sandbox',
  ],
  defaultViewport: { width: 1280, height: 800 },
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`\n== ${s}`);

async function newPlayer(name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${name}] pageerror:`, e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (name === 'Smoke') {
      hostLogs.push(t);
      allHostLogs.push(t);
    }
    if (/\[online\]|WebRTC|ICE|signal|error|autoconf|configured|joypad|rwebpad/i.test(t) && !/favicon|Wake Lock|BGRA|GLSL|Playlist|screen dimensions/.test(t))
      console.log(`  [${name}]`, t.slice(0, 160));
  });
  const shot = async (n) => {
    const p = path.join(SHOTS, `online-${n}.png`);
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
    if (!ok) throw new Error(`[${name}] No ${sel} with text "${text}"`);
  };
  // Boot -> sign in -> profile -> library
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await wait(800);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.login, .profile-card, .library'), { timeout: 15000 });
  if (await page.$('.login')) {
    if (!INVITE) throw new Error('No invite code available');
    await page.keyboard.type(INVITE, { delay: 20 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.login'), { timeout: 10000 });
  }
  await page.waitForSelector('.profile-card', { timeout: 10000 });
  const has = await page.evaluate((n) => [...document.querySelectorAll('.profile-card')].some((c) => c.textContent.includes(n)), name);
  if (has) await clickText(name, '.profile-card');
  else {
    await clickText('New profile', '.profile-card');
    await page.waitForSelector('.osk-input');
    await page.type('.osk-input', name);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.avatar-pick');
    await page.click('.avatar-pick');
  }
  await page.waitForSelector('.game-card', { timeout: 10000 });
  await wait(400);
  return { page, shot, clickText, name };
}

const hostLogs = [];
const allHostLogs = [];
let host, remote;
try {
  step('Two players sign in');
  host = await newPlayer('Smoke');
  remote = await newPlayer('Remote');

  step('Host opens a multiplayer lobby');
  await host.page.click('.game-card');
  await wait(400);
  if (await host.page.$('.resume-pick')) {
    await host.clickText('Start from the disc');
    await wait(400);
  }
  await host.clickText('Multiplayer');
  await host.page.waitForSelector('.online-code b', { timeout: 15000 });
  const code = await host.page.$$eval('.online-code b', (els) => els.map((e) => e.textContent).join(''));
  console.log('   room code:', code);
  await host.shot('01-host-lobby');

  step('Remote joins with the code');
  await remote.clickText('Join online', 'button');
  await remote.page.waitForSelector('.osk-input');
  await remote.page.type('.osk-input', code);
  await remote.page.keyboard.press('Enter');
  await remote.page.waitForSelector('.remote', { timeout: 15000 });
  await remote.page.waitForFunction(() => window.__wsx?.client?.connected === true, { timeout: 20000 });
  console.log('   data channel open');
  await wait(500);
  await remote.shot('02-remote-room');

  step('Remote takes a port');
  await remote.page.keyboard.press('KeyX'); // "any button" -> join with keyboard
  await host.page.waitForFunction(() => document.querySelectorAll('.port.filled').length >= 2, { timeout: 10000 });
  const labels = await host.page.$$eval('.port.filled .port-label', (els) => els.map((e) => e.textContent));
  console.log('   host ports:', labels);
  if (!labels.some((l) => l.includes('Remote'))) throw new Error('remote player not shown in host lobby');
  await remote.page.waitForFunction(() => document.querySelector('.port.mine'), { timeout: 5000 });
  await host.shot('03-host-lobby-joined');
  await remote.shot('03-remote-room-joined');

  step('Remote becomes Player 1 (host presses F1 to swap ports)');
  await host.page.keyboard.press('F1');
  await wait(300);
  const order = await host.page.$$eval('.port.filled .port-label', (els) => els.map((e) => e.textContent));
  console.log('   host ports now:', order);
  if (order[0] !== 'Remote') throw new Error('swap did not put the remote player in port 1');
  // Dev-only: bind RetroArch's screenshot hotkey to Start on the Player 1 pad. RetroArch reads
  // joypad hotkeys from port 1's device, so a remote Start making the core take a screenshot
  // proves the emulator itself is reading the virtual pad (not just our JS).
  await host.page.evaluate(() => (window.__wsxCfgOverride = { input_menu_toggle_btn: 9, input_menu_toggle: 'f8', menu_driver: 'rgui' }));

  step('Host starts the game');
  await host.clickText('Start');
  await host.page.waitForFunction(() => window.__wsx?.session?.status === 'running', { timeout: 120000 });
  console.log('   emulator running on host');
  await remote.page.waitForFunction(() => document.querySelector('.remote')?.dataset.phase === 'playing', { timeout: 30000 });
  await remote.page.waitForFunction(
    () => {
      const v = document.querySelector('video');
      return v && v.videoWidth > 0 && v.currentTime > 0.5;
    },
    { timeout: 30000 },
  );
  const vinfo = await remote.page.evaluate(async () => {
    const v = document.querySelector('video');
    const t0 = v.currentTime;
    await new Promise((r) => setTimeout(r, 2000));
    const c = window.__wsx.client;
    return {
      size: `${v.videoWidth}x${v.videoHeight}`,
      advanced: +(v.currentTime - t0).toFixed(2),
      tracks: c.stream.getTracks().map((t) => `${t.kind}:${t.readyState}`),
      rtt: c.rtt,
    };
  });
  console.log('   remote video:', vinfo);
  if (vinfo.advanced < 1) throw new Error('remote video is not advancing');
  if (!vinfo.tracks.some((t) => t.startsWith('audio'))) console.log('   WARNING: no audio track reached the remote');
  await wait(3000);
  await remote.shot('04-remote-playing');
  await host.shot('04-host-playing');

  step('Remote presses Cross; host virtual pad must see it');
  await remote.page.keyboard.down('KeyX'); // default keyboard binding for Cross
  await wait(300);
  const pressed = await host.page.evaluate(() => {
    const pads = window.__wsxVirtualPads?.() ?? [];
    return pads.map((p) => ({ index: p.index, cross: p.buttons[0].pressed, id: p.id }));
  });
  console.log('   host virtual pads:', pressed);
  await remote.page.keyboard.up('KeyX');
  if (!pressed.some((p) => p.cross)) throw new Error('host virtual pad did not register Cross');
  await wait(300);
  const released = await host.page.evaluate(() => (window.__wsxVirtualPads?.() ?? []).map((p) => p.buttons[0].pressed));
  console.log('   after release:', released);
  if (released.some(Boolean)) throw new Error('Cross stayed pressed after release');

  // Observable: RetroArch's RGUI menu fills the screen with a lit checkerboard; count lit pixels.
  const greenRatio = async () => {
    const png = await host.page.screenshot();
    const { data } = await sharp(png).resize(160, 120, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    let green = 0;
    for (let i = 0; i < data.length; i += 3) if (data[i] + data[i + 1] + data[i + 2] > 60) green++; // lit pixels: RGUI fills the screen
    return +(green / (data.length / 3)).toFixed(3);
  };
  const press = async (page, key) => {
    await page.keyboard.down(key);
    await wait(150);
    await page.keyboard.up(key);
    await wait(1200);
  };

  step('Control: RetroArch menu toggle from the host keyboard (F8)');
  await host.page.evaluate(() => document.querySelector('canvas')?.focus());
  const g0 = await greenRatio();
  await press(host.page, 'F8');
  const g1 = await greenRatio();
  await host.shot('04b-host-menu-kb');
  await press(host.page, 'F8'); // close it again
  const g2 = await greenRatio();
  console.log(`   green pixels: before ${g0} -> menu ${g1} -> closed ${g2}`);
  const kbWorks = g1 > g0 + 0.3 && g2 < g1 - 0.3;
  if (!kbWorks) throw new Error(`keyboard hotkey control failed (${g0} -> ${g1} -> ${g2})`);

  step('RetroArch must react to the remote pad: Start is bound to the menu toggle');
  await press(remote.page, 'Enter');
  const g3 = await greenRatio();
  await host.shot('04c-host-menu-remote');
  await press(remote.page, 'Enter'); // close it again
  const g4 = await greenRatio();
  console.log(`   green pixels: menu via remote Start ${g3} -> closed ${g4}`);
  if (!(g3 > g2 + 0.3 && g4 < g3 - 0.3)) throw new Error('RetroArch did not run the hotkey bound to the remote pad');
  console.log('   RetroArch reads the remote pad');

  step('Play a little from the remote (Cross; Start is the menu hotkey in this test)');
  await remote.page.keyboard.down('KeyX');
  await wait(150);
  await remote.page.keyboard.up('KeyX');
  await wait(3500);
  await host.shot('05-host-after-remote-input');
  await remote.shot('05-remote-after-input');

  step('Host pauses; remote shows the overlay');
  await host.page.keyboard.press('Escape');
  await host.page.waitForSelector('.pause-menu', { timeout: 5000 });
  await remote.page.waitForFunction(() => document.querySelector('.remote')?.dataset.phase === 'paused', { timeout: 5000 });
  await wait(700);
  await host.shot('06-host-pause');
  await remote.shot('06-remote-paused');
  console.log('   host pause stats:', await host.page.evaluate(() => document.querySelector('.pause-online')?.textContent));
  await host.clickText('Resume');
  await remote.page.waitForFunction(() => document.querySelector('.remote')?.dataset.phase === 'playing', { timeout: 5000 });

  step('Host quits; remote is told the session ended');
  await host.page.keyboard.press('Escape');
  await host.page.waitForSelector('.pause-menu');
  await host.clickText('Quit to library');
  await host.page.waitForSelector('.library', { timeout: 30000 });
  await remote.page.waitForFunction(() => [...document.querySelectorAll('.dialog-title')].some((d) => /Session ended/.test(d.textContent)), { timeout: 15000 });
  await remote.shot('07-remote-ended');
  await remote.clickText('Back to library');
  await remote.page.waitForSelector('.library', { timeout: 10000 });

  console.log('\nONLINE TEST PASSED');
} catch (e) {
  console.log('\nONLINE TEST FAILED:', e.message);
  try {
    if (host) await host.shot('99-host-failure');
    if (remote) await remote.shot('99-remote-failure');
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join('work', 'host-console.log'), allHostLogs.join(String.fromCharCode(10)));
  await browser.close();
}
