import { FONT, STRING_LIST } from './tables.js';

export const SCREEN_W = 320;
export const SCREEN_H = 200;
const PAGE_SIZE = SCREEN_W * SCREEN_H / 2; // 4 bits per pixel
const NO_PALETTE_CHANGE = 0xFF;

const STRINGS = new Map();
for (const [id, str] of STRING_LIST) if (!STRINGS.has(id)) STRINGS.set(id, str);

/** Software renderer working on four 4bpp pages, exactly like the original game. */
export class Video {
  constructor(res, sys) {
    this.res = res;
    this.sys = sys;
    this.paletteIdRequested = NO_PALETTE_CHANGE;
    this.currentPaletteId = 0;
    this.pages = [0, 1, 2, 3].map(() => new Uint8Array(PAGE_SIZE));
    // cur1 is the work buffer, cur2 and cur3 are the (swappable) display buffers.
    this.cur1 = this.cur2 = this.cur3 = null;
    this.points = new Int16Array(100); // x,y pairs of the polygon being drawn
    this.numPoints = 0;
    this.bbw = 0;
    this.bbh = 0;
    this.hliney = 0;
    this.interp = new Uint16Array(0x400);
    this.data = null; // polygon data buffer currently read
    this.pc = 0;
  }

  init() {
    this.paletteIdRequested = NO_PALETTE_CHANGE;
    this.cur3 = this.pages[1];
    this.cur2 = this.pages[2];
    this.changePagePtr1(0xFE);
    this.interp[0] = 0x4000;
    for (let i = 1; i < 0x400; i++) this.interp[i] = (0x4000 / i) | 0;
  }

  setDataBuffer(data, offset) {
    this.data = data;
    this.pc = offset;
  }

  readAndDrawPolygon(color, zoom, x, y) {
    const i = this.data[this.pc++];
    if (i >= 0xC0) {
      if (color & 0x80) color = i & 0x3F;
      this.readVertices(zoom);
      this.fillPolygon(color, x, y);
    } else if ((i & 0x3F) === 2) {
      this.readAndDrawPolygonHierarchy(zoom, x, y);
    }
  }

  readVertices(zoom) {
    const d = this.data;
    let p = this.pc;
    this.bbw = (d[p++] * zoom) >> 6;
    this.bbh = (d[p++] * zoom) >> 6;
    const n = this.numPoints = d[p++];
    for (let i = 0; i < n; i++) {
      this.points[i * 2] = (d[p++] * zoom) >> 6;
      this.points[i * 2 + 1] = (d[p++] * zoom) >> 6;
    }
  }

  fillPolygon(color, px, py) {
    const pts = this.points;
    if (this.bbw === 0 && this.bbh === 1 && this.numPoints === 4) {
      this.drawPoint(color, px, py);
      return;
    }

    let x1 = px - (this.bbw >> 1);
    let x2 = px + (this.bbw >> 1);
    const y1 = py - (this.bbh >> 1);
    const y2 = py + (this.bbh >> 1);
    if (x1 > 319 || x2 < 0 || y1 > 199 || y2 < 0) return;

    this.hliney = y1;

    let i = 0;
    let j = this.numPoints - 1;
    x2 = pts[i * 2] + x1;
    x1 = pts[j * 2] + x1;
    i++;
    j--;

    const drawLine = color < 0x10 ? this.drawLineN : color > 0x10 ? this.drawLineP : this.drawLineBlend;

    let cpt1 = (x1 << 16) | 0;
    let cpt2 = (x2 << 16) | 0;
    let remaining = this.numPoints;

    for (;;) {
      remaining -= 2;
      if (remaining === 0) break;

      // Edge 1 runs from points[j+1] to points[j], edge 2 from points[i-1] to points[i].
      // The scanline count of the original is the dy of the second edge.
      const e1dy = (pts[j * 2 + 1] - pts[(j + 1) * 2 + 1]) & 0xFFFF;
      const e1dx = pts[j * 2] - pts[(j + 1) * 2];
      const e2dy = (pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]) & 0xFFFF;
      const e2dx = pts[i * 2] - pts[(i - 1) * 2];
      const step1 = (e1dx * (this.interp[e1dy] || 0) * 4) | 0;
      const step2 = (e2dx * (this.interp[e2dy] || 0) * 4) | 0;
      let h = e2dy;

      i++;
      j--;

      cpt1 = ((cpt1 & 0xFFFF0000) | 0x7FFF) | 0;
      cpt2 = ((cpt2 & 0xFFFF0000) | 0x8000) | 0;

      if (h === 0) {
        cpt1 = (cpt1 + step1) | 0;
        cpt2 = (cpt2 + step2) | 0;
      } else {
        for (; h !== 0; h--) {
          if (this.hliney >= 0) {
            let a = cpt1 >> 16;
            let b = cpt2 >> 16;
            if (a <= 319 && b >= 0) {
              if (a < 0) a = 0;
              if (b > 319) b = 319;
              drawLine.call(this, a, b, color);
            }
          }
          cpt1 = (cpt1 + step1) | 0;
          cpt2 = (cpt2 + step2) | 0;
          this.hliney++;
          if (this.hliney > 199) return;
        }
      }
    }
  }

  readAndDrawPolygonHierarchy(zoom, pgx, pgy) {
    const d = this.data;
    const px = pgx - ((d[this.pc++] * zoom) >> 6);
    const py = pgy - ((d[this.pc++] * zoom) >> 6);
    let childs = d[this.pc++];

    for (; childs >= 0; childs--) {
      let off = (d[this.pc] << 8) | d[this.pc + 1];
      this.pc += 2;

      const x = px + ((d[this.pc++] * zoom) >> 6);
      const y = py + ((d[this.pc++] * zoom) >> 6);

      let color = 0xFF;
      const flags = off;
      off &= 0x7FFF;
      if (flags & 0x8000) {
        color = d[this.pc] & 0x7F;
        this.pc += 2;
      }

      const bak = this.pc;
      this.pc = off * 2;
      this.readAndDrawPolygon(color, zoom, x, y);
      this.pc = bak;
    }
  }

  drawString(color, x, y, stringId) {
    const str = STRINGS.get(stringId);
    if (str === undefined) return;
    const xOrigin = x;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c === 10) {
        y += 8;
        x = xOrigin;
        continue;
      }
      this.drawChar(c, x, y, color, this.cur1);
      x++;
    }
  }

  drawChar(c, x, y, color, buf) {
    if (x > 39 || y > 192) return;
    const base = (c - 32) * 8;
    if (base < 0 || base + 8 > FONT.length) return;
    let p = x * 4 + y * 160;
    for (let j = 0; j < 8; j++) {
      let ch = FONT[base + j];
      for (let i = 0; i < 4; i++) {
        let cmask = 0xFF;
        let colb = 0;
        if (ch & 0x80) {
          colb |= color << 4;
          cmask &= 0x0F;
        }
        ch = (ch << 1) & 0xFF;
        if (ch & 0x80) {
          colb |= color;
          cmask &= 0xF0;
        }
        ch = (ch << 1) & 0xFF;
        buf[p + i] = (buf[p + i] & cmask) | colb;
      }
      p += 160;
    }
  }

  drawPoint(color, x, y) {
    if (x < 0 || x > 319 || y < 0 || y > 199) return;
    const off = y * 160 + (x >> 1);
    let cmaskn, cmasko;
    if (x & 1) { cmaskn = 0x0F; cmasko = 0xF0; } else { cmaskn = 0xF0; cmasko = 0x0F; }
    let colb = ((color << 4) | color) & 0xFF;
    if (color === 0x10) {
      cmaskn &= 0x88;
      cmasko = ~cmaskn & 0xFF;
      colb = 0x88;
    } else if (color === 0x11) {
      colb = this.pages[0][off];
    }
    const b = this.cur1[off];
    this.cur1[off] = (b & cmasko) | (colb & cmaskn);
  }

  drawLineBlend(x1, x2) {
    const xmax = Math.max(x1, x2);
    const xmin = Math.min(x1, x2);
    const buf = this.cur1;
    let p = this.hliney * 160 + (xmin >> 1);
    let w = (xmax >> 1) - (xmin >> 1) + 1;
    let cmaske = 0;
    let cmasks = 0;
    if (xmin & 1) { w--; cmasks = 0xF7; }
    if (!(xmax & 1)) { w--; cmaske = 0x7F; }
    if (cmasks) { buf[p] = (buf[p] & cmasks) | 0x08; p++; }
    while (w-- > 0) { buf[p] = (buf[p] & 0x77) | 0x88; p++; }
    if (cmaske) { buf[p] = (buf[p] & cmaske) | 0x80; }
  }

  drawLineN(x1, x2, color) {
    const xmax = Math.max(x1, x2);
    const xmin = Math.min(x1, x2);
    const buf = this.cur1;
    let p = this.hliney * 160 + (xmin >> 1);
    let w = (xmax >> 1) - (xmin >> 1) + 1;
    let cmaske = 0;
    let cmasks = 0;
    if (xmin & 1) { w--; cmasks = 0xF0; }
    if (!(xmax & 1)) { w--; cmaske = 0x0F; }
    const colb = ((color & 0xF) << 4) | (color & 0xF);
    if (cmasks) { buf[p] = (buf[p] & cmasks) | (colb & 0x0F); p++; }
    while (w-- > 0) buf[p++] = colb;
    if (cmaske) { buf[p] = (buf[p] & cmaske) | (colb & 0xF0); }
  }

  drawLineP(x1, x2) {
    const xmax = Math.max(x1, x2);
    const xmin = Math.min(x1, x2);
    const off = this.hliney * 160 + (xmin >> 1);
    const buf = this.cur1;
    const src = this.pages[0];
    let p = off;
    let w = ((xmax >> 1) - (xmin >> 1) + 1) & 0xFF;
    let cmaske = 0;
    let cmasks = 0;
    if (xmin & 1) { w = (w - 1) & 0xFF; cmasks = 0xF0; }
    if (!(xmax & 1)) { w = (w - 1) & 0xFF; cmaske = 0x0F; }
    if (cmasks) { buf[p] = (buf[p] & cmasks) | (src[p] & 0x0F); p++; }
    while (w--) { buf[p] = src[p]; p++; }
    if (cmaske) { buf[p] = (buf[p] & cmaske) | (src[p] & 0xF0); }
  }

  getPage(page) {
    if (page <= 3) return this.pages[page];
    if (page === 0xFF) return this.cur3;
    if (page === 0xFE) return this.cur2;
    return this.pages[0];
  }

  changePagePtr1(pageId) {
    this.cur1 = this.getPage(pageId);
  }

  fillPage(pageId, color) {
    this.getPage(pageId).fill(((color << 4) | color) & 0xFF);
  }

  copyPage(srcPageId, dstPageId, vscroll) {
    if (srcPageId === dstPageId) return;
    if (srcPageId >= 0xFE || !((srcPageId &= 0xBF) & 0x80)) {
      this.getPage(dstPageId).set(this.getPage(srcPageId));
    } else {
      const src = this.getPage(srcPageId & 3);
      const dst = this.getPage(dstPageId);
      if (vscroll >= -199 && vscroll <= 199) {
        let h = 200;
        let sOff = 0;
        let dOff = 0;
        if (vscroll < 0) {
          h += vscroll;
          sOff = -vscroll * 160;
        } else {
          h -= vscroll;
          dOff = vscroll * 160;
        }
        dst.set(src.subarray(sOff, sOff + h * 160), dOff);
      }
    }
  }

  /** Convert a full-screen bitmap stored as four bit planes into page 0. */
  copyPlanarPage(src) {
    const dst = this.pages[0];
    let s = 0;
    let d = 0;
    for (let h = 0; h < 200; h++) {
      for (let w = 0; w < 40; w++) {
        const p = [src[s + 24000], src[s + 16000], src[s + 8000], src[s]];
        for (let j = 0; j < 4; j++) {
          let acc = 0;
          for (let i = 0; i < 8; i++) {
            acc = (acc << 1) | ((p[i & 3] & 0x80) ? 1 : 0);
            p[i & 3] = (p[i & 3] << 1) & 0xFF;
          }
          dst[d++] = acc;
        }
        s++;
      }
    }
  }

  changePal(palNum) {
    if (palNum >= 32) return;
    this.sys.setPalette(this.res.segPalettes.subarray(palNum * 32, palNum * 32 + 32));
    this.currentPaletteId = palNum;
  }

  updateDisplay(pageId) {
    if (pageId !== 0xFE) {
      if (pageId === 0xFF) {
        const t = this.cur2; this.cur2 = this.cur3; this.cur3 = t;
      } else {
        this.cur2 = this.getPage(pageId);
      }
    }
    if (this.paletteIdRequested !== NO_PALETTE_CHANGE) {
      this.changePal(this.paletteIdRequested);
      this.paletteIdRequested = NO_PALETTE_CHANGE;
    }
    this.sys.updateDisplay(this.cur2);
  }
}
