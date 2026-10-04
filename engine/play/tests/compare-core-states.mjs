// Compare fixed emulated-frame workloads, with host-time catch-up disabled.
// Start bench/server.mjs with DISC_DIR=library first. Requires local discs/states.
// node engine/play/tests/compare-core-states.mjs --candidate accuracy-memory
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  assert(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `Missing --${name} value`);
  return process.argv[i + 1];
};
const candidate = arg('candidate');
assert(candidate, '--candidate must name a work/cores-trial build');
const reference = arg('reference', ''); // empty = installed core
const url = arg('url', 'http://localhost:8344/');
const seconds = Number(arg('secs', '20'));
assert(Number.isFinite(seconds) && seconds >= 10, '--secs must be at least 10');
const output = path.resolve(root, arg('out', 'work/core-state-comparison'));
const fixtures = {
  thps: ['thps4/game.chd', 'thps4-foundry.st'],
  mirra: ['dave-mirra-freestyle-bmx-2/game.chd', 'mirra-fixed-gameplay.st'],
  atv: ['atv-offroad-fury-2/game.chd', 'atv2-race.st'],
};
const cases = arg('cases', 'thps,mirra,atv').split(',');
const modes = arg('modes', 'off,sync').split(',');
for (const name of cases) assert(fixtures[name], `Unknown fixture ${name}`);
for (const mode of modes) assert(['off', 'sync'].includes(mode), 'Use off or sync for deterministic comparisons');
fs.mkdirSync(output, { recursive: true });

async function run(name, mode, label, core) {
  const [disc, state] = fixtures[name];
  const query = new URLSearchParams({ state, vu1thread: mode, catchup: '0', hash: '120' });
  if (core) query.set('core', core);
  const out = path.join(output, `${name}-${mode}-${label}`);
  const logPath = `${out}.log`;
  const args = ['engine/play/bench/probe.mjs', '--url', url, '--disc', disc,
    '--query', query.toString(), '--secs', String(seconds), '--out', out];
  console.log(`${name} ${mode} ${label}: 120 emulated frames`);
  let log = '';
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { log += data; });
  child.stderr.on('data', data => { log += data; });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  fs.writeFileSync(logPath, log);
  assert.equal(code, 0, `Probe failed: ${logPath}`);
  const browserLog = fs.readFileSync(path.join(out, 'console.log'), 'utf8');
  assert.match(browserLog, /state load true/, `State did not load: ${out}/console.log`);
  assert.doesNotMatch(log, /pageerror:|worker exception:/, `Browser exception: ${logPath}`);
  const match = log.match(/^state hash: (\{[^\r\n]+\})/m);
  assert(match, `No completed fingerprint; increase --secs and inspect ${logPath}`);
  const { ms, ...hash } = JSON.parse(match[1]);
  for (const key of ['eeRam', 'spr', 'eeGpr', 'eePc', 'vu0Mem', 'vu1Mem', 'vu1Regs', 'iopRam']) {
    assert.equal(typeof hash[key], 'string', `Missing ${key}: ${logPath}`);
    assert(hash[key].length > 0, `Empty ${key}: ${logPath}`);
  }
  return hash;
}

const results = [];
let failed = false;
for (const name of cases) for (const mode of modes) {
  try {
    const before = await run(name, mode, 'reference', reference);
    const after = await run(name, mode, 'candidate', candidate);
    const differences = Object.keys(before).filter(key => before[key] !== after[key]);
    results.push({ name, mode, before, after, differences, passed: !differences.length });
    if (differences.length) failed = true;
    console.log(differences.length ? `DIFF: ${differences.join(', ')}` : 'PASS: all machine fields match');
  } catch (error) {
    failed = true;
    results.push({ name, mode, passed: false, error: String(error) });
    console.error(String(error));
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ candidate, reference: reference || 'installed', results }, null, 2));
}
process.exitCode = failed ? 1 : 0;
