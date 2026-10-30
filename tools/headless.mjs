// Headless smoke test: runs the VM with the original data files and dumps frames as PNG.
//   node tools/headless.mjs <data dir> <out dir> [frames] [dumpEvery]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Engine } from '../src/engine.js';

const [dataDir, outDir, framesArg = '300', everyArg = '100'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const files = new Map(fs.readdirSync(dataDir).map((f) => [f.toLowerCase(), path.join(dataDir, f)]));
const cache = new Map();
const getFile = (name) => {
  if (!cache.has(name)) cache.set(name, new Uint8Array(fs.readFileSync(files.get(name))));
  return cache.get(name);
};

let palette = new Uint8Array(16 * 3);
const sys = {
  input: { dirMask: 0, button: false, lastChar: 0, code: false, save: false, load: false },
  setPalette(p) {
    for (let i = 0; i < 16; i++) {
      palette[i * 3] = (p[i * 2] & 0x0F) * 17;
      palette[i * 3 + 1] = (p[i * 2 + 1] >> 4) * 17;
      palette[i * 3 + 2] = (p[i * 2 + 1] & 0x0F) * 17;
    }
  },
  updateDisplay(page) { last = Uint8Array.from(page); },
};
let last = null;

function png(page, file) {
  const w = 320, h = 200;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const b = page[y * 160 + (x >> 1)];
      const c = (x & 1) ? b & 15 : b >> 4;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = palette[c * 3]; raw[o + 1] = palette[c * 3 + 1]; raw[o + 2] = palette[c * 3 + 2];
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const engine = new Engine(sys, getFile);
engine.init(Number(process.env.PART) || undefined);
const frames = Number(framesArg), every = Number(everyArg);
for (let f = 1; f <= frames; f++) {
  // BUTTON_FROM=<frame>: tap the action button periodically from that frame on
  sys.input.button = process.env.BUTTON_FROM && f > Number(process.env.BUTTON_FROM) && f % 40 < 20;
  engine.runFrame();
  engine.showFrame();
  if (f % every === 0 && last) png(last, path.join(outDir, `frame${String(f).padStart(5, '0')}.png`));
}
console.log('ok, part', engine.res.currentPartId.toString(16));
