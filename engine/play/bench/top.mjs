// Self-time ranking of a V8 .cpuprofile: node engine/play/bench/top.mjs <file.cpuprofile> [count] [--busy]
// --busy: percentages of the time the thread wasn't waiting.
import fs from 'node:fs';
const profile = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const count = Number(process.argv[3] ?? 40);
const busyOnly = process.argv.includes('--busy');
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
let total = 0;
for (const id of profile.samples) {
  const n = byId.get(id);
  const key = n.callFrame.functionName || `(${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber})`;
  if (busyOnly && /cond_timedwait|\(idle\)|futex_wait|__timedwait/.test(key)) continue;
  self.set(key, (self.get(key) ?? 0) + 1);
  total++;
}
console.log(`${total} samples${busyOnly ? ' (busy only)' : ''} of ${profile.samples.length}`);
for (const [k, c] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, count)) console.log(`${((c / total) * 100).toFixed(1).padStart(5)}%  ${k.slice(0, 130)}`);
