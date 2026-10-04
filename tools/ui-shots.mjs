#!/usr/bin/env node
/**
 * Screenshots of the animated menus for eyeballing the look: boot sequence, library, carousel
 * moves, and the disc-in launch. Headless Chrome with SwiftShader, like the smoke test.
 *
 *   node tools/ui-shots.mjs [--url http://localhost:5173] [--code XXXX-XXXX] [--shots work/shots/ui] [--launch]
 *        [--viewport 844x390] [--mobile]
 *
 * --viewport sets the window size (a phone in landscape is about 844x390); --mobile also emulates a touch
 * screen (pointer: coarse), which switches the UI to its touch layout. Both add shots of the filters,
 * the settings dialog and a device-check dialog.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const URL = arg('url', 'http://localhost:5173');
const SHOTS = arg('shots', 'work/shots/ui');
fs.mkdirSync(SHOTS, { recursive: true });

const firstInviteCode = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'invites.json'), 'utf8')).find((i) => !i.revokedAt)?.code ?? null;
  } catch {
    return null;
  }
};
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const [VW, VH] = arg('viewport', '1600x900').split('x').map(Number);
const MOBILE = process.argv.includes('--mobile');
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', `--window-size=${VW},${VH}`, '--no-sandbox'],
  defaultViewport: { width: VW, height: VH, isMobile: MOBILE, hasTouch: MOBILE, isLandscape: VW > VH },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  pageerror:', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|Wake Lock/.test(m.text())) console.log('  console error:', m.text().slice(0, 200));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const p = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: p });
  console.log('  ', p);
};
const clickText = (text, sel) =>
  page.evaluate(
    (text, sel) => {
      const el = [...document.querySelectorAll(sel)].find((b) => b.textContent.includes(text));
      el?.click();
      return !!el;
    },
    text,
    sel,
  );

try {
  await page.evaluateOnNewDocument(() => sessionStorage.clear());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  for (const t of [300, 1300, 2600, 4200]) {
    await wait(t - (t === 300 ? 0 : [300, 1300, 2600, 4200][[300, 1300, 2600, 4200].indexOf(t) - 1]));
    await shot(`boot-${t}`);
  }
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.login, .profile-card, .library'), { timeout: 15000 });
  if (await page.$('.login')) {
    await wait(1500);
    await shot('login');
    await page.keyboard.type(arg('code', firstInviteCode()) ?? '', { delay: 30 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.login'), { timeout: 10000 });
  }
  await page.waitForSelector('.profile-card', { timeout: 10000 });
  await wait(1200);
  await shot('profiles');
  if (!(await clickText('Smoke', '.profile-card'))) await page.click('.profile-card');
  await page.waitForSelector('.game-card', { timeout: 10000 });
  await wait(2500);
  await shot('library-1');
  await wait(3500);
  await shot('library-2');
  await page.keyboard.press('ArrowRight');
  await wait(350);
  await shot('library-moving');
  await wait(2500);
  await shot('library-3');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await wait(3000);
  await shot('library-4');
  const info = await page.evaluate(() => ({
    selected: document.querySelector('.game-card.selected')?.dataset.game,
    accent: getComputedStyle(document.querySelector('.library')).getPropertyValue('--accent'),
    scene: document.body.dataset.scene,
    backdrop: document.querySelectorAll('.bd-img.show').length,
    slides: document.querySelectorAll('.media-slide').length,
  }));
  console.log('  ', info);
  // Filters: PS2 tab (E = R1), then the layout facts that matter on small screens.
  await page.keyboard.press('e');
  await wait(1800);
  await shot('library-ps2');
  const fit = await page.evaluate(() => {
    const box = (sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] : null;
    };
    return {
      viewport: [innerWidth, innerHeight],
      tabs: [...document.querySelectorAll('.sys-tab')].map((t) => t.textContent + (t.classList.contains('active') ? '*' : '')),
      cards: document.querySelectorAll('.game-card').length,
      flagged: [...document.querySelectorAll('.game-card[data-verdict]')].map((c) => `${c.dataset.game}:${c.dataset.verdict}`),
      topbar: box('.topbar'),
      filterbar: box('.filterbar'),
      detail: box('.detail'),
      frontCase: box('.game-card.selected .case-float'),
      offscreen: [...document.querySelectorAll('.topbar [data-focus], .filterbar [data-focus]')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1;
      }).length,
    };
  });
  console.log('  ', JSON.stringify(fit));
  await page.keyboard.press('q');
  await page.keyboard.press('q');
  await wait(1500);
  await shot('library-ps1');
  await page.keyboard.press('e');
  await wait(800);
  await page.keyboard.press('F1');
  await wait(900);
  await shot('settings');
  const dlg = await page.evaluate(() => {
    const d = document.querySelector('.dialog')?.getBoundingClientRect();
    const a = document.querySelector('.dialog-actions')?.getBoundingClientRect();
    return d ? { dialog: [Math.round(d.top), Math.round(d.bottom)], actionsBottom: Math.round(a.bottom), viewport: innerHeight } : null;
  });
  console.log('  ', 'settings dialog', JSON.stringify(dlg));
  await page.keyboard.press('Escape');
  await wait(500);
  if (process.argv.includes('--launch')) {
    await page.keyboard.press('Enter');
    await wait(500);
    if (await page.$('.resume-pick')) {
      await clickText('Start from the disc', 'button');
      await wait(400);
    }
    if (await clickText('Single Player', 'button')) await wait(10);
    for (const t of [250, 550, 850, 1100]) {
      await wait(t === 250 ? 250 : 300);
      await shot(`launch-${t}`);
    }
  }
  console.log('UI SHOTS DONE');
} catch (e) {
  console.error('UI SHOTS FAILED:', e.message);
  await shot('ui-failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
