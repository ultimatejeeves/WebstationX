import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const output = path.resolve('release/core-sources');
fs.mkdirSync(output, { recursive: true });
const sources = [
  ['RetroArch', 'libretro/RetroArch', 'a609b70'],
  ['PCSX-ReARMed', 'libretro/pcsx_rearmed', '228c14e'],
];
const sums = [];
for (const [name, repo, ref] of sources) {
  const response = await fetch(`https://codeload.github.com/${repo}/tar.gz/${ref}`);
  if (!response.ok) throw new Error(`Cannot retrieve ${name} sources: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const filename = `${name}-${ref}.tar.gz`;
  fs.writeFileSync(path.join(output, filename), buffer);
  sums.push(`${crypto.createHash('sha256').update(buffer).digest('hex')}  ${filename}`);
}
// Play! has submodules. Package the complete recursive tree, including licenses.
const checkout = path.resolve('work/release-play-source');
if (!fs.existsSync(checkout)) execFileSync('git', ['clone', '--no-checkout', 'https://github.com/jpd002/Play-.git', checkout], { stdio: 'inherit' });
execFileSync('git', ['-C', checkout, 'checkout', '--detach', '83700b2c31e593bc94e845b4b31b797be84dda59'], { stdio: 'inherit' });
execFileSync('git', ['-C', checkout, 'submodule', 'update', '--init', '--recursive'], { stdio: 'inherit' });
const playArchive = path.join(output, 'Play-83700b2c-with-dependencies.tar.gz');
execFileSync('tar', ['--exclude=.git', '-czf', playArchive, '-C', checkout, '.'], { stdio: 'inherit' });
sums.push(`${crypto.createHash('sha256').update(fs.readFileSync(playArchive)).digest('hex')}  ${path.basename(playArchive)}`);
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
fs.copyFileSync('THIRD_PARTY_NOTICES.md', path.join(output, 'THIRD_PARTY_NOTICES.md'));
console.log(`Sources ready: ${output}`);
