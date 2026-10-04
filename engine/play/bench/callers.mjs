// Who calls a hot function? Groups the samples that landed in a function by their call stacks.
//   node engine/play/bench/callers.mjs work/shots/ps2-bench/worker1.cpuprofile emscripten_futex_wait [depth]
import fs from 'node:fs';

const [file, fn, depth = 6] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const counts = new Map();
for (const id of p.samples) counts.set(id, (counts.get(id) ?? 0) + 1);
const stacks = new Map();
let total = 0;
for (const [id, c] of counts) {
  if (!(byId.get(id).callFrame.functionName || '').includes(fn)) continue;
  const names = [];
  for (let cur = id, k = 0; k < Number(depth) && cur; k++, cur = parent.get(cur)) names.push(byId.get(cur).callFrame.functionName.slice(0, 70) || '?');
  const key = names.join(' <- ');
  stacks.set(key, (stacks.get(key) ?? 0) + c);
  total += c;
}
for (const [k, c] of [...stacks].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(c, k);
console.log(`total ${total} of ${p.samples.length} samples`);
