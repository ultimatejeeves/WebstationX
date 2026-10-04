import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanGames } from '../server/games';
import { Auth } from '../server/auth';

test('drop folders discover discs, preserve stable IDs, and reject unsafe CUEs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsx-discovery-'));
  try {
    fs.mkdirSync(path.join(root, 'psx', 'Disc set'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ps2'));
    const put = (name: string, value = 'fixture') => fs.writeFileSync(path.join(root, name), value);
    put('psx/Example.chd'); put('ps2/Example.iso'); put('ps2/Ignore.zip');
    put('psx/Disc set/Game.cue', 'FILE "Track 1.bin" BINARY\n TRACK 01 MODE2/2352\n INDEX 01 00:00:00');
    put('psx/Disc set/Track 1.bin');
    put('psx/Unsafe.cue', 'FILE "../secret.bin" BINARY');
    put('psx/Missing.cue', 'FILE "missing.bin" BINARY');
    const first = scanGames(root);
    assert.equal(first.games.length, 3);
    assert.equal(first.games.find(g => g.disc.endsWith('.cue'))?.files.length, 2);
    assert.equal(new Set(first.games.map(g => g.id)).size, 3);
    const game = first.games.find(g => g.disc === 'Example.chd')!;
    put('psx/Example.chd', 'changed content');
    const updated = scanGames(root).games.find(g => g.disc === game.disc)!;
    assert.equal(updated.id, game.id, 'saves survive replacement');
    assert.notEqual(updated.discUrl, game.discUrl, 'disc cache invalidates after replacement');
    fs.unlinkSync(path.join(root, 'psx/Example.chd'));
    assert.equal(scanGames(root).games.length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('revoking all invites and malformed cookies cannot reopen access', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsx-auth-'));
  try {
    const auth = new Auth(root);
    assert.equal(auth.enabled, false);
    fs.writeFileSync(path.join(root, 'invites.json'), JSON.stringify([{ code: 'EXAMPLE1', name: 'Test', revokedAt: '2026-01-01' }]));
    assert.equal(auth.enabled, true);
    assert.equal(auth.find('EXAMPLE1'), null);
    assert.equal(Auth.cookieOf({ headers: { cookie: 'wsx_session=%invalid' } }), null);
    fs.writeFileSync(path.join(root, 'invites.json'), '[]');
    assert.equal(auth.enabled, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
