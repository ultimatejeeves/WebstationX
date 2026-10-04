import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

// Run against a packaged build. All test data goes into a separate work directory.
const executable = path.resolve(process.argv[2] ?? 'release/win-unpacked/WebStationX.exe');
const home = path.resolve('work/desktop-smoke');
fs.mkdirSync(home, { recursive: true });
const debugPort = 19334;
const child = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
  env: { ...process.env, PORTABLE_EXECUTABLE_DIR: home }, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', data => { logs += data; });
child.stderr.on('data', data => { logs += data; });
let browser;
const waitInPage = async (page, predicate) => {
  for (let i = 0; i < 150; i++) {
    try { if (await page.evaluate(predicate)) return; } catch { /* Navigation replaces contexts. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await page.screenshot({ path: 'work/desktop-smoke-failure.png' });
  throw new Error(`Desktop condition timed out: ${predicate}; ${await page.evaluate(() => document.body.innerText.slice(0,500))}`);
};
try {
  for (let i = 0; i < 100; i++) {
    try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  assert.ok(browser, `Desktop debugger unavailable: ${logs}`);
  let page;
  for (let i = 0; i < 100; i++) {
    page = (await browser.pages())[0];
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(page, `Application did not load: ${logs}`);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await waitInPage(page, () => !!document.querySelector('#app > *'));
  const base = await page.evaluate(() => location.origin);
  const profile = await (await fetch(`${base}/api/profiles`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Smoke Test"}' })).json();
  await page.evaluate(id => { localStorage.setItem('wsx.profile', id); localStorage.setItem('wsx.booted', '1'); }, profile.id);
  await page.evaluate(() => { location.reload(); });
  await waitInPage(page, () => !!document.querySelector('.library'));
  const capabilities = await page.evaluate(() => ({ isolated: crossOriginIsolated, shared: typeof SharedArrayBuffer === 'function', node: typeof window.require }));
  assert.deepEqual(capabilities, { isolated: true, shared: true, node: 'undefined' });
  const actualGames = process.env.WSX_SMOKE_GAMES ?? path.join(home, 'Games');
  const fixture = path.join(actualGames, 'ps2', 'Discovery smoke fixture.iso');
  fs.writeFileSync(fixture, Buffer.alloc(2048));
  try {
    await waitInPage(page, () => document.body.innerText.includes('Discovery smoke fixture'));
    await page.screenshot({ path: 'work/desktop-smoke.png' });
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ ok: true, origin: base, capabilities, automaticDiscovery: true, screenshot: 'work/desktop-smoke.png' }));
  } finally { fs.unlinkSync(fixture); }
} finally {
  if (browser) await browser.close().catch(() => browser.disconnect());
  if (child.pid) {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch { /* Already closed. */ }
  }
}
