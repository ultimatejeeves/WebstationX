import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('isolated server serves ranges, saves profiles, and rejects cross-origin writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsx-http-'));
  fs.mkdirSync(path.join(root, 'Games', 'ps2'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Games', 'ps2', 'Example.iso'), '0123456789');
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, WSX_PORT: '0', WSX_BIND: '127.0.0.1', WSX_TRUST_PROXY: '0',
      WSX_DATA_DIR: path.join(root, 'data'), WSX_GAMES_DIR: path.join(root, 'Games'),
      WSX_LIBRARY_DIR: path.join(root, 'library'), WSX_BIOS_DIR: path.join(root, 'bios'), WSX_DIST_DIR: path.join(root, 'dist') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server did not start')), 15000);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Server exited: ${code}`)));
      child.stdout.on('data', chunk => {
        const match = String(chunk).match(/http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
      });
    });
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const catalog = await (await fetch(`${base}/api/catalog`)).json();
    assert.equal(catalog.games.length, 1);
    const range = await fetch(`${base}${catalog.games[0].discUrl}`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), '2345');
    assert.equal(range.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
    const denied = await fetch(`${base}/api/profiles`, { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: '{"name":"Test"}' });
    assert.equal(denied.status, 403);
    const profile = await (await fetch(`${base}/api/profiles`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{"name":"Test"}' })).json();
    const saveUrl = `${base}/api/saves/${profile.id}/${catalog.games[0].id}/memcard`;
    assert.equal((await fetch(saveUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: 'save fixture' })).status, 200);
    assert.equal(await (await fetch(saveUrl)).text(), 'save fixture');
    fs.writeFileSync(path.join(root, 'data', 'invites.json'), '[]');
    assert.equal((await fetch(`${base}/api/catalog`)).status, 401);
    assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: 'wsx_session=%invalid' } })).status, 200);
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
