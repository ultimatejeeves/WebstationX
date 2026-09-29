#!/usr/bin/env node
/**
 * Manage invite codes. Each friend gets one code; revoking it signs them out everywhere.
 *
 *   npm run invite -- add "Mike"            create a code for Mike
 *   npm run invite -- add "Me" --owner      create an owner code
 *   npm run invite -- list                  show all codes
 *   npm run invite -- revoke ABCD-EFGH      revoke a code (or a name)
 *   npm run invite -- restore ABCD-EFGH     un-revoke
 *
 * Works while the server is running: it re-reads invites.json whenever the file changes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.WSX_DATA_DIR ?? path.join(root, 'data');
const file = path.join(dataDir, 'invites.json');
fs.mkdirSync(dataDir, { recursive: true });

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
const write = (list) => fs.writeFileSync(file, JSON.stringify(list, null, 2));
const pretty = (code) => code.replace(/(.{4})(?=.)/g, '$1-');
const normalize = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

function generate(existing) {
  for (;;) {
    let code = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
    if (!existing.some((i) => i.code === code)) return code;
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const list = read();

switch (cmd) {
  case 'add': {
    const name = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
    if (!name) die('Usage: npm run invite -- add "Name" [--owner]');
    const code = generate(list);
    list.push({ code, name, createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null, owner: rest.includes('--owner') || undefined });
    write(list);
    console.log(`\nInvite for ${name}:\n\n    ${pretty(code)}\n\nThey enter it once on the sign-in screen; it stays valid until revoked.`);
    break;
  }
  case 'list': {
    if (list.length === 0) console.log('No invites yet. Access is open until you add one.');
    for (const i of list)
      console.log(
        `${pretty(i.code)}  ${i.name.padEnd(18)} ${i.revokedAt ? 'REVOKED' : i.owner ? 'owner  ' : 'active '}  created ${i.createdAt.slice(0, 10)}  last used ${i.lastUsedAt ? i.lastUsedAt.slice(0, 10) : 'never'}`,
      );
    break;
  }
  case 'revoke':
  case 'restore': {
    const key = rest.join(' ').trim();
    const target = list.find((i) => i.code === normalize(key)) ?? list.find((i) => i.name.toLowerCase() === key.toLowerCase());
    if (!target) die(`No invite matching "${key}"`);
    target.revokedAt = cmd === 'revoke' ? new Date().toISOString() : null;
    write(list);
    console.log(`${cmd === 'revoke' ? 'Revoked' : 'Restored'} ${pretty(target.code)} (${target.name})`);
    break;
  }
  default:
    die('Usage: npm run invite -- add "Name" [--owner] | list | revoke <code|name> | restore <code|name>');
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}
