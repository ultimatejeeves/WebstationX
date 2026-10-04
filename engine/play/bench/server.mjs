// Cross-origin-isolated static server for the PS2 core bench page (see README.md).
//   node engine/play/bench/server.mjs [port]
// Serves /            -> this folder
//        /core/*      -> $CORE_DIR (default public/cores/play: the shipped core)
//        /corejit/*   -> the same core with jitwrap.js in front (JIT compile counters)
//        /cores/<n>/* -> work/cores-trial/<n> (trial builds, harness ?core=<n>)
//        /disc/*      -> $DISC_DIR (default PS2/), with range requests ($DISC_DELAY_MS delays each one,
//                        to act like the app's server across a network)
//        /states/*    -> work/ps2-bench-states (PUT to save)
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2] ?? 8123);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const app = express();
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
const coreDir = process.env.CORE_DIR ?? path.resolve(here, '../../../public/cores/play');
app.use('/core', express.static(coreDir));
// The core with jitwrap.js in front (JIT compile counters); its workers load this same URL.
app.get('/corejit/Play.js', (_req, res) => {
  res.type('text/javascript').send(fs.readFileSync(path.join(here, 'jitwrap.js'), 'utf8') + fs.readFileSync(path.join(coreDir, 'Play.js'), 'utf8'));
});
app.use('/corejit', express.static(coreDir));
// Trial builds side by side: /cores/<name>/ -> work/cores-trial/<name> (harness ?core=<name>)
app.use('/cores', express.static(path.resolve(here, '../../../work/cores-trial')));
const discDelay = Number(process.env.DISC_DELAY_MS ?? 0);
if (discDelay) app.use('/disc', (_req, _res, next) => setTimeout(next, discDelay));
app.use('/disc', express.static(process.env.DISC_DIR ?? path.resolve(here, '../../../PS2'), { acceptRanges: true }));
const stateDir = path.resolve(here, '../../../work/ps2-bench-states');
fs.mkdirSync(stateDir, { recursive: true });
app.put('/states/:name', express.raw({ type: '*/*', limit: '512mb' }), (req, res) => {
  fs.writeFileSync(path.join(stateDir, path.basename(req.params.name)), req.body);
  res.json({ ok: true, size: req.body.length });
});
app.use('/states', express.static(stateDir));
app.use('/', express.static(here));
app.listen(port, () => console.log(`harness on http://localhost:${port}`));
