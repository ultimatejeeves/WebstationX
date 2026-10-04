import fs from 'node:fs';
import path from 'node:path';

const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
let text = '# Bundled npm dependency licenses\n\nGenerated from package-lock.json. Development-only tools are not bundled.\n';
for (const [dir, entry] of Object.entries(lock.packages)) {
  if (!dir || entry.dev) continue;
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) continue;
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const notices = fs.readdirSync(dir).filter(name => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name) && fs.statSync(path.join(dir, name)).isFile());
  text += `\n## ${pkg.name} ${pkg.version}\n\nLicense: ${pkg.license ?? entry.license ?? 'See upstream'}\n`;
  for (const name of notices) text += `\n### ${name}\n\n${fs.readFileSync(path.join(dir, name), 'utf8')}\n`;
}
fs.mkdirSync('licenses', { recursive: true });
fs.writeFileSync('licenses/npm-dependencies.md', text);
