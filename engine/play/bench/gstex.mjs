// Dumps textures out of the emulated GS memory as PNGs (needs a core with debugReadGsTexture).
//
//   node engine/play/bench/gstex.mjs --disc <id>/game.chd --query "state=x.st" --at 8 --out work/shots/tex
//        --tex "2700:512:T8:512x256:3dcc" [--tex ...] [--times 4] [--url http://localhost:8123/]
//
// --tex tbp:tbw:psm:WxH[:cbp[:csa]] (hex tbp/cbp, as the GS trace prints them). Paletted textures are written
// twice: <name>-idx.png (indices as grey) and <name>.png (through the CT32 palette at cbp, CSM1 order).
// --times N samples N times 50 ms apart (games reuse VRAM within a frame, so one sample may catch another texture).
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const all = (n) => process.argv.flatMap((a, i) => (a === `--${n}` ? [process.argv[i + 1]] : []));
const BASE = arg('url', 'http://localhost:8123/');
const OUT = arg('out', 'work/shots/gstex');
const AT = Number(arg('at', 8));
const TIMES = Number(arg('times', 1));
const PSM = { CT32: 0, CT16: 2, T8: 0x13, T4: 0x14 };
const texs = all('tex').map((t) => {
  const [tbp, tbw, psm, size, cbp, csa] = t.split(':');
  const [w, h] = size.split('x').map(Number);
  return { name: `${tbp}-${psm}-${size}${cbp ? '-' + cbp : ''}`, tbp: parseInt(tbp, 16), tbw: Number(tbw), psm: PSM[psm], w, h, cbp: cbp ? parseInt(cbp, 16) : null, csa: Number(csa ?? 0) };
});
fs.mkdirSync(OUT, { recursive: true });

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  defaultViewport: { width: 900, height: 620 },
});
const page = await browser.newPage();
const query = [`disc=${encodeURIComponent(arg('disc', ''))}`, arg('query', '')].filter(Boolean).join('&');
await page.goto(`${BASE}?${query}`, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, AT * 1000));

for (let n = 0; n < TIMES; n++) {
  for (const t of texs) {
    const res = await page.evaluate((t) => {
      const M = window.Module ?? window.mod;
      const u32 = (addr, count) => new Uint32Array(M.HEAPU8.buffer, addr, count).slice();
      const px = u32(M.debugReadGsTexture(t.tbp, t.tbw, t.psm, t.w, t.h), t.w * t.h);
      const paletted = t.psm === 0x13 || t.psm === 0x14;
      let pal = null;
      if (paletted && t.cbp !== null) {
        const raw = u32(M.debugReadGsTexture(t.cbp, 64, 0, 16, 16), 256);
        pal = new Uint32Array(256);
        if (t.psm === 0x13) {
          // CSM1, 8-bit: entries 8-15 and 16-23 of every 32 are swapped.
          for (let i = 0; i < 256; i++) pal[i] = raw[(i & 0xe7) | ((i & 0x08) << 1) | ((i & 0x10) >> 1)];
        } else {
          // 4-bit: an 8x2 block; csa picks which 16 entries of the CLUT buffer it lands in (the block itself starts at cbp).
          for (let i = 0; i < 16; i++) pal[i] = raw[(i >> 3) * 16 + (i & 7)];
        }
      }
      const hist = new Array(paletted ? (t.psm === 0x13 ? 256 : 16) : 0).fill(0);
      const render = (colour) => {
        const c = document.createElement('canvas');
        c.width = t.w;
        c.height = t.h;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(t.w, t.h);
        for (let i = 0; i < px.length; i++) {
          let v = px[i];
          if (paletted) {
            if (!colour) hist[v]++;
            v = colour ? pal[v] : (t.psm === 0x13 ? v : v * 17) * 0x010101;
          } else if (t.psm === 2) {
            v = ((v & 31) << 3) | (((v >> 5) & 31) << 11) | (((v >> 10) & 31) << 19);
          }
          img.data[i * 4] = v & 255;
          img.data[i * 4 + 1] = (v >> 8) & 255;
          img.data[i * 4 + 2] = (v >> 16) & 255;
          img.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return c.toDataURL('image/png');
      };
      const used = hist.filter((x) => x > 0).length;
      return { idx: render(false), col: pal ? render(true) : null, used, top: hist.map((c, i) => [c, i]).sort((a, b) => b[0] - a[0]).slice(0, 6), pal: pal ? [...pal.slice(0, 8)].map((x) => x.toString(16)) : null };
    }, t);
    const save = (url, file) => fs.writeFileSync(path.join(OUT, file), Buffer.from(url.split(',')[1], 'base64'));
    const suffix = TIMES > 1 ? `-${n}` : '';
    const paletted = t.psm === 0x13 || t.psm === 0x14;
    save(res.idx, `${t.name}${suffix}${paletted ? '-idx' : ''}.png`);
    if (res.col) save(res.col, `${t.name}${suffix}.png`);
    console.log(`${t.name}${suffix}: ${paletted ? `${res.used} indices used, top ${JSON.stringify(res.top)}, palette ${res.pal ? res.pal.join(' ') : '-'}` : 'saved'}`);
  }
  await new Promise((r) => setTimeout(r, 50));
}
await browser.close();
