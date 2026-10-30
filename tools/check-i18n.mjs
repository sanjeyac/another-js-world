// Verifies that every language file has the same keys and placeholders as English.
//   node tools/check-i18n.mjs
import fs from 'node:fs';
const dir = new URL('../i18n/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'));
const langs = read('languages.json');
const en = read('en.json');
const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
let bad = 0;
for (const code of Object.keys(langs)) {
  if (!fs.existsSync(new URL(code + '.json', dir))) { console.log(`${code}: file missing`); bad++; continue; }
  const d = read(code + '.json');
  for (const k of Object.keys(en)) {
    if (!(k in d)) { console.log(`${code}: missing "${k}" (falls back to English)`); bad++; }
    else if (ph(d[k]) !== ph(en[k])) { console.log(`${code}: placeholders differ in "${k}"`); bad++; }
  }
  for (const k of Object.keys(d)) if (!(k in en)) { console.log(`${code}: unknown key "${k}"`); bad++; }
}
console.log(bad ? `${bad} problem(s)` : `ok: ${Object.keys(langs).length} languages`);
process.exit(bad ? 1 : 0);
