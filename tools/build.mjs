// Builds the deployable site into dist/: only the files the browser needs (no tools, game data, docs).
//   node tools/build.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const INCLUDE = ['index.html', 'style.css', 'manifest.json', 'sw.js', 'src', 'icons', 'kenney', 'assets', 'i18n'];

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);
for (const item of INCLUDE) fs.cpSync(path.join(root, item), path.join(dist, item), { recursive: true });
fs.writeFileSync(path.join(dist, '.nojekyll'), '');

// New cache name on every build so installed copies pick up the update.
const version = (process.env.GITHUB_SHA || Date.now().toString(36)).slice(0, 8);
const swPath = path.join(dist, 'sw.js');
fs.writeFileSync(swPath, fs.readFileSync(swPath, 'utf8').replace(/another-world-v\w+/, `another-world-${version}`));

// Safety net: the copyrighted game data must never end up in the published site.
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(dist);
const leaked = files.filter((f) => /(^|[\\/])(memlist\.bin|bank[0-9a-f]{2})$/i.test(f));
if (leaked.length) { console.error('game data found in dist:', leaked); process.exit(1); }

console.log(`dist/ ready: ${files.length} files, ${(files.reduce((n, f) => n + fs.statSync(f).size, 0) / 1024).toFixed(0)} KB, cache ${version}`);
