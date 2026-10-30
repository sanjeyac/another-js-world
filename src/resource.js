import { readResource } from './bank.js';
import { PARTS, PART_FIRST, PART_LAST } from './tables.js';

export const STATE_NOT_NEEDED = 0;
export const STATE_LOADED = 1;
export const STATE_LOAD_ME = 2;

export const RT_SOUND = 0;
export const RT_MUSIC = 1;
export const RT_POLY_ANIM = 2;
export const RT_PALETTE = 3;
export const RT_BYTECODE = 4;
export const RT_POLY_CINEMATIC = 5;

/** Resource directory (memlist.bin) plus the currently loaded game part. */
export class Resource {
  /**
   * @param {Video} video
   * @param {(name: string) => Uint8Array} getFile  returns the raw bytes of a data file ("memlist.bin", "bank01", ...)
   */
  constructor(video, getFile) {
    this.video = video;
    this.getFile = getFile;
    this.memList = [];
    this.currentPartId = 0;
    this.requestedNextPart = 0;
    this.useSegVideo2 = false;
    this.segPalettes = this.segBytecode = this.segCinematic = this.segVideo2 = null;
  }

  readEntries() {
    const f = this.getFile('memlist.bin');
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
    for (let o = 0; o + 20 <= f.length; o += 20) {
      const state = dv.getUint8(o);
      if (state === 0xFF) break;
      this.memList.push({
        state,
        type: dv.getUint8(o + 1),
        buf: null,
        rankNum: dv.getUint8(o + 6),
        bankId: dv.getUint8(o + 7),
        bankOffset: dv.getUint32(o + 8),
        packedSize: dv.getUint16(o + 14),
        size: dv.getUint16(o + 18),
      });
    }
  }

  readBank(entry) {
    const name = 'bank' + entry.bankId.toString(16).padStart(2, '0');
    return readResource(this.getFile(name), entry);
  }

  loadMarkedAsNeeded() {
    for (;;) {
      let me = null;
      let maxNum = 0;
      for (const it of this.memList) {
        if (it.state === STATE_LOAD_ME && maxNum <= it.rankNum) {
          maxNum = it.rankNum;
          me = it;
        }
      }
      if (!me) break;

      if (me.bankId === 0) {
        me.state = STATE_NOT_NEEDED;
        continue;
      }
      const data = this.readBank(me);
      if (me.type === RT_POLY_ANIM) {
        this.video.copyPlanarPage(data);
        me.state = STATE_NOT_NEEDED;
      } else {
        me.buf = data;
        me.state = STATE_LOADED;
      }
    }
  }

  invalidateRes() {
    for (const me of this.memList) {
      if (me.type <= RT_POLY_ANIM || me.type > 6) me.state = STATE_NOT_NEEDED;
    }
  }

  invalidateAll() {
    for (const me of this.memList) me.state = STATE_NOT_NEEDED;
  }

  /** Either loads a resource, or (when the id is out of the memlist range) requests a part switch. */
  loadPartsOrMemoryEntry(id) {
    if (id > this.memList.length) {
      this.requestedNextPart = id;
    } else {
      const me = this.memList[id];
      if (me.state === STATE_NOT_NEEDED) {
        me.state = STATE_LOAD_ME;
        this.loadMarkedAsNeeded();
      }
    }
  }

  setupPart(partId) {
    if (partId === this.currentPartId) return;
    if (partId < PART_FIRST || partId > PART_LAST) throw new Error('invalid part ' + partId.toString(16));

    const [paletteIdx, codeIdx, cinematicIdx, video2Idx] = PARTS[partId - PART_FIRST];
    this.invalidateAll();
    this.memList[paletteIdx].state = STATE_LOAD_ME;
    this.memList[codeIdx].state = STATE_LOAD_ME;
    this.memList[cinematicIdx].state = STATE_LOAD_ME;
    if (video2Idx !== 0) this.memList[video2Idx].state = STATE_LOAD_ME;
    this.loadMarkedAsNeeded();

    this.segPalettes = this.memList[paletteIdx].buf;
    this.segBytecode = this.memList[codeIdx].buf;
    this.segCinematic = this.memList[cinematicIdx].buf;
    if (video2Idx !== 0) this.segVideo2 = this.memList[video2Idx].buf;
    this.currentPartId = partId;
  }
}
