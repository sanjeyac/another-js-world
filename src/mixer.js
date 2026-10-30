import { STATE_LOADED, RT_MUSIC, RT_SOUND } from './resource.js';

const NUM_CHANNELS = 4;

const addClamp = (a, b) => {
  const v = a + b;
  return v < -128 ? -128 : v > 127 ? 127 : v;
};

/**
 * Four-channel 8-bit sample mixer. It is driven by `render()`, called from the audio callback; the same
 * callback also fires the music sequencer events, so music timing is sample accurate.
 */
export class Mixer {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: NUM_CHANNELS }, () => ({
      active: false, volume: 0, chunk: null, pos: 0, inc: 0,
    }));
    this.timerCb = null; // returns the delay (ms) until the next call
    this.timerLeft = 0;  // samples left until the next timer event
  }

  /** @param {{data: Int8Array, len: number, loopPos: number, loopLen: number}} chunk */
  playChannel(channel, chunk, freq, volume) {
    const ch = this.channels[channel];
    ch.active = true;
    ch.volume = volume;
    ch.chunk = chunk;
    ch.pos = 0;
    ch.inc = Math.floor((freq << 8) / this.sampleRate);
  }

  stopChannel(channel) { this.channels[channel].active = false; }
  setChannelVolume(channel, volume) { this.channels[channel].volume = volume; }
  stopAll() { for (const ch of this.channels) ch.active = false; }

  setTimer(delayMs, cb) {
    this.timerCb = cb;
    this.timerLeft = delayMs * this.sampleRate / 1000;
  }
  clearTimer() { this.timerCb = null; }

  render(out, n) {
    let pos = 0;
    while (pos < n) {
      let chunk = n - pos;
      if (this.timerCb) chunk = Math.max(1, Math.min(chunk, Math.ceil(this.timerLeft)));
      this.mix(out, pos, chunk);
      pos += chunk;
      if (this.timerCb) {
        this.timerLeft -= chunk;
        if (this.timerLeft <= 0) {
          const next = this.timerCb();
          if (this.timerCb) this.timerLeft += Math.max(1, next) * this.sampleRate / 1000;
        }
      }
    }
  }

  mix(out, start, len) {
    const acc = this.acc && this.acc.length >= len ? this.acc : (this.acc = new Int16Array(len));
    acc.fill(0, 0, len);
    for (const ch of this.channels) {
      if (!ch.active) continue;
      const c = ch.chunk;
      for (let j = 0; j < len; j++) {
        const ilc = ch.pos & 0xFF;
        const p1 = ch.pos >> 8;
        ch.pos += ch.inc;
        let p2;
        if (c.loopLen !== 0) {
          if (p1 === c.loopPos + c.loopLen - 1) {
            ch.pos = p2 = c.loopPos;
          } else {
            p2 = p1 + 1;
          }
        } else if (p1 === c.len - 1) {
          ch.active = false;
          break;
        } else {
          p2 = p1 + 1;
        }
        const b1 = c.data[p1] | 0;
        const b2 = c.data[p2] | 0;
        const b = (b1 * (0xFF - ilc) + b2 * ilc) >> 8;
        acc[j] = addClamp(acc[j], Math.trunc(b * ch.volume / 0x40));
      }
    }
    for (let j = 0; j < len; j++) out[start + j] = acc[j] / 128;
  }
}

/** Music sequencer for the game's module format (Amiga-like patterns, 4 voices). */
export class SfxPlayer {
  constructor(mixer, res, setMarkVar) {
    this.mixer = mixer;
    this.res = res;
    this.setMarkVar = setMarkVar;
    this.delay = 0;
    this.resNum = 0;
    this.mod = null;
  }

  setEventsDelay(delay) {
    this.delay = Math.floor(delay * 60 / 7050);
  }

  loadSfxModule(resNum, delay, pos) {
    const me = this.res.memList[resNum];
    if (!(me.state === STATE_LOADED && me.type === RT_MUSIC)) return;
    const b = me.buf;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    this.resNum = resNum;
    const mod = this.mod = {
      curOrder: pos,
      numOrder: dv.getUint16(0x3E),
      orderTable: b.subarray(0x40, 0x40 + 0x80),
      data: b.subarray(0xC0),
      curPos: 0,
      samples: [],
    };
    this.delay = Math.floor((delay === 0 ? dv.getUint16(0) : delay) * 60 / 7050);
    for (let i = 0, p = 2; i < 15; i++, p += 4) {
      const sampleRes = dv.getUint16(p);
      if (sampleRes === 0) { mod.samples.push(null); continue; }
      const se = this.res.memList[sampleRes];
      if (!(se.state === STATE_LOADED && se.type === RT_SOUND)) throw new Error('missing instrument ' + sampleRes);
      se.buf.fill(0, 8, 12);
      mod.samples.push({ data: se.buf, volume: dv.getUint16(p + 2) });
    }
  }

  start() {
    this.mod.curPos = 0;
    this.mixer.setTimer(this.delay, () => { this.handleEvents(); return this.delay; });
  }

  stop() {
    if (this.resNum !== 0) {
      this.resNum = 0;
      this.mixer.clearTimer();
    }
  }

  handleEvents() {
    const m = this.mod;
    const order = m.orderTable[m.curOrder];
    let off = m.curPos + order * 1024;
    for (let ch = 0; ch < 4; ch++, off += 4) this.handlePattern(ch, off);
    m.curPos += 16;
    if (m.curPos >= 1024) {
      m.curPos = 0;
      const next = m.curOrder + 1;
      if (next === m.numOrder) {
        this.resNum = 0;
        this.mixer.clearTimer();
        this.mixer.stopAll();
      }
      m.curOrder = next;
    }
  }

  handlePattern(channel, off) {
    const d = this.mod.data;
    const note1 = (d[off] << 8) | d[off + 1];
    const note2 = (d[off + 2] << 8) | d[off + 3];
    let sample = null;
    let volume = 0;

    if (note1 !== 0xFFFD) {
      const idx = (note2 & 0xF000) >> 12;
      if (idx !== 0 && this.mod.samples[idx - 1]) {
        sample = this.mod.samples[idx - 1];
        let m = sample.volume;
        const effect = (note2 & 0x0F00) >> 8;
        if (effect === 5) m = Math.min(0x3F, m + (note2 & 0xFF));
        else if (effect === 6) m = Math.max(0, m - (note2 & 0xFF));
        this.mixer.setChannelVolume(channel, m);
        volume = m;
      }
    }

    if (note1 === 0xFFFD) {
      this.setMarkVar(note2);
    } else if (note1 !== 0) {
      if (note1 === 0xFFFE) {
        this.mixer.stopChannel(channel);
      } else if (sample) {
        const sb = sample.data;
        const len = ((sb[0] << 8) | sb[1]) * 2;
        const loopLen = ((sb[2] << 8) | sb[3]) * 2;
        const chunk = {
          data: new Int8Array(sb.buffer, sb.byteOffset + 8, sb.length - 8),
          len,
          loopPos: loopLen ? len : 0,
          loopLen,
        };
        this.mixer.playChannel(channel, chunk, Math.floor(7159092 / (note1 * 2)), volume);
      }
    }
  }
}
