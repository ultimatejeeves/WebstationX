#!/usr/bin/env node
/**
 * Headless test for the keyboard/mouse binding editor:
 * open Settings > Change bindings, rebind Cross to K and Circle to the right mouse button,
 * save, then confirm the RetroArch config written at launch uses the new bindings.
 *
 *   node tools/keybind-test.mjs [--url http://localhost:5173]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const URL = arg('url', 'http://localhost:5173');
const SHOTS = 'work/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  pageerror:', e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (n) => {
  const p = path.join(SHOTS, `${n}.png`);
  await page.screenshot({ path: p });
  console.log('   screenshot ->', p);
};
const clickText = async (text, sel = 'button') => {
  const ok = await page.evaluate(
    (text, sel) => {
      // Last match wins so a button inside the top-most (last) dialog is preferred.
      const el = [...document.querySelectorAll(sel)].filter((b) => b.textContent.trim().includes(text)).pop();
      if (!el) return false;
      el.click();
      return true;
    },
    text,
    sel,
  );
  if (!ok) throw new Error(`No ${sel} with text "${text}"`);
};

try {
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await wait(800);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.profile-card', { timeout: 10000 });
  const hasSmoke = await page.evaluate(() => [...document.querySelectorAll('.profile-card')].some((c) => c.textContent.includes('Smoke')));
  if (!hasSmoke) throw new Error('Run smoke-test first to create the Smoke profile');
  await clickText('Smoke', '.profile-card');
  await page.waitForSelector('.game-card', { timeout: 10000 });

  console.log('== Open settings > bindings');
  await clickText('Settings', '.chip');
  await page.waitForSelector('.settings');
  await clickText('Change bindings');
  await page.waitForSelector('.bind-editor');
  await wait(300);
  await shot('10-bind-editor');

  console.log('== Rebind Cross -> K');
  await page.click('[data-bind="b"] .bind-value');
  await wait(200);
  const capturing = await page.evaluate(() => document.querySelector('.bind-row.capturing')?.dataset.bind);
  console.log('   capturing:', capturing);
  await page.keyboard.press('KeyK');
  await wait(200);
  console.log('   Cross now:', await page.$eval('[data-bind="b"] kbd', (e) => e.textContent));

  console.log('== Rebind Circle -> right mouse button');
  await page.click('[data-bind="a"] .bind-value');
  await wait(200);
  await page.mouse.click(800, 450, { button: 'right' });
  await wait(200);
  console.log('   Circle now:', await page.$eval('[data-bind="a"] kbd', (e) => e.textContent));

  console.log('== Rebind L1 -> wheel up');
  await page.click('[data-bind="l"] .bind-value');
  await wait(200);
  await page.mouse.wheel({ deltaY: -100 });
  await wait(200);
  console.log('   L1 now:', await page.$eval('[data-bind="l"] kbd', (e) => e.textContent));

  console.log('== Reserved key is refused (Escape cancels capture instead)');
  await page.click('[data-bind="x"] .bind-value');
  await wait(150);
  await page.keyboard.press('F1');
  await wait(150);
  console.log('   status:', await page.$eval('.bind-status', (e) => e.textContent));
  await page.keyboard.press('Escape');
  await wait(150);
  console.log('   still open:', !!(await page.$('.bind-editor')), '| Triangle:', await page.$eval('[data-bind="x"] kbd', (e) => e.textContent));
  await shot('11-bind-changed');

  console.log('== Save');
  await clickText('Save');
  await wait(500);
  const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('wsx.prefs.smoke') || '{}').keymap);
  console.log('   saved keymap b/a/l:', prefs?.b, prefs?.a, prefs?.l);
  const server = await (await fetch(`${URL}/api/profiles`)).json();
  const sp = server.find((p) => p.id === 'smoke');
  console.log('   server keymap b/a/l:', sp?.prefs?.keymap?.b, sp?.prefs?.keymap?.a, sp?.prefs?.keymap?.l);
  console.log('   help grid:', await page.$$eval('.keyhelp-item', (a) => a.slice(0, 3).map((e) => e.textContent).join(' | ')));
  await clickText('Done');
  await wait(300);

  console.log('== Launch and inspect retroarch.cfg');
  await page.click('.game-card');
  await wait(400);
  if (await page.$('.resume-pick')) {
    await clickText('Start from the disc');
    await wait(400);
  }
  await clickText('Single Player');
  await page.waitForFunction(() => window.__wsx?.session?.status === 'running', { timeout: 120000 });
  await wait(1500);
  const cfg = await page.evaluate(() => {
    const fs = window.__wsx.session['inst'].getEmscriptenFS();
    const txt = new TextDecoder().decode(fs.readFile('/home/web_user/retroarch/userdata/retroarch.cfg'));
    return txt.split('\n').filter((l) => /^input_player1_(b|a|l|x)(_mbtn)? =/.test(l)).join('\n');
  });
  console.log(cfg);
  const ok = /input_player1_b = "k"/.test(cfg) && /input_player1_a_mbtn = "2"/.test(cfg) && /input_player1_l_mbtn = "4"/.test(cfg);

  console.log('== Restore defaults');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.pause-menu');
  await clickText('Controls');
  await page.waitForSelector('.controls-help');
  await clickText('Change bindings');
  await page.waitForSelector('.bind-editor');
  await clickText('Reset to defaults');
  await wait(300);
  await clickText('Reset');
  await wait(300);
  await clickText('Save');
  await wait(400);
  console.log('   apply button enabled:', await page.$eval('.controls-help', (el) => !el.closest('.dialog').querySelector('.dialog-actions .btn').disabled));
  await shot('12-controls-apply');

  console.log(ok ? '\nKEYBIND TEST PASSED' : '\nKEYBIND TEST FAILED: config mismatch');
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error('\nKEYBIND TEST FAILED:', e.message);
  await shot('99-keybind-failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
