// Condenses a bench run's frame timings: node engine/play/bench/frames-summary.cjs <probe --out dir>
const f = require(require('path').resolve(process.argv[2], 'frames.json'));
const vm = f.vm.slice(600), gs = f.gs.slice(600);
const avg = (a, k) => (a.reduce((s, x) => s + x[k], 0) / a.length).toFixed(2);
const pct = (a, k, p) => { const v = a.map((x) => x[k]).sort((x, y) => x - y); return v[Math.floor(v.length * p)].toFixed(1); };
const iv = f.gs.slice(601).map((g, i) => g[0] - f.gs[600 + i][0]).filter((x) => x < 100);
console.log(process.argv[2].padEnd(28), 'VM work', (vm.reduce((s, x) => s + x[1] - x[2], 0) / vm.length).toFixed(2), 'VM>18ms', vm.filter((x) => x[1] > 18).length + '/' + vm.length,
  '| GS busy', avg(gs, 1), 'p90', pct(gs, 1, 0.9), 'p99', pct(gs, 1, 0.99), '>16.7', gs.filter((x) => x[1] > 16.7).length + '/' + gs.length,
  '| present off>4ms', iv.filter((x) => Math.abs(x - 16.67) > 4).length + '/' + iv.length);
