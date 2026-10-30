import { FREQUENCY_TABLE, PART_FIRST, PART_LAST } from './tables.js';
import { STATE_LOADED } from './resource.js';

const NUM_THREADS = 64;
const NO_SETVEC_REQUESTED = 0xFFFF;
const INACTIVE_THREAD = 0xFFFF;

// Script variables with a special meaning
const VAR_RANDOM_SEED = 0x3C;
const VAR_LAST_KEYCHAR = 0xDA;
const VAR_HERO_POS_UP_DOWN = 0xE5;
export const VAR_MUS_MARK = 0xF4;
const VAR_SCROLL_Y = 0xF9;
const VAR_HERO_ACTION = 0xFA;
const VAR_HERO_POS_JUMP_DOWN = 0xFB;
const VAR_HERO_POS_LEFT_RIGHT = 0xFC;
const VAR_HERO_POS_MASK = 0xFD;
const VAR_HERO_ACTION_POS_MASK = 0xFE;
export const VAR_PAUSE_SLICES = 0xFF;

export const DIR_LEFT = 1;
export const DIR_RIGHT = 2;
export const DIR_UP = 4;
export const DIR_DOWN = 8;

const CURR = 0;
const REQ = 1;
const s16 = (v) => (v << 16) >> 16;

/**
 * The Another World bytecode virtual machine. 64 cooperative threads run the game script.
 * Unlike the original, `runFrame()` returns when the script asks to display a frame (blit)
 * so the browser can pace the game; `completeBlit()` then performs the actual display.
 */
export class VirtualMachine {
  constructor(res, video, mixer, player, sys) {
    this.res = res;
    this.video = video;
    this.mixer = mixer;
    this.player = player;
    this.sys = sys;

    this.vars = new Int16Array(256);
    this.stackCalls = new Uint16Array(256);
    this.threadPc = new Uint16Array(NUM_THREADS);        // current pc of each thread
    this.threadReqPc = new Uint16Array(NUM_THREADS);     // pc requested through setVec
    this.active = [new Uint8Array(NUM_THREADS), new Uint8Array(NUM_THREADS)]; // 1 = paused
    this.pc = 0;
    this.sp = 0;
    this.gotoNextThread = false;
    this.yielded = false;
    this.pendingPage = 0;
    this.tid = -1;      // thread being run, -1 = a new frame has to be started
    this.inThread = false;
    this.onFrameStart = null; // hook called at every frame start (used for save states)
  }

  init({ bypassProtection = true } = {}) {
    this.vars.fill(0);
    this.vars[0x54] = 0x81;
    this.vars[VAR_RANDOM_SEED] = Math.floor(Date.now() / 1000);
    if (bypassProtection) {
      // These are set by the game code and the original executable once the code wheel has been passed.
      this.vars[0xBC] = 0x10;
      this.vars[0xC6] = 0x80;
      this.vars[0xF2] = 4000;
      this.vars[0xDC] = 33;
    }
  }

  initForPart(partId) {
    this.player.stop();
    this.mixer.stopAll();
    this.vars[0xE4] = 0x14;
    this.res.setupPart(partId);
    this.threadPc.fill(0xFFFF);
    this.threadReqPc.fill(0xFFFF);
    this.active[CURR].fill(0);
    this.active[REQ].fill(0);
    this.threadPc[0] = 0;
    this.tid = -1;
    this.inThread = false;
  }

  checkThreadRequests() {
    if (this.res.requestedNextPart !== 0) {
      this.initForPart(this.res.requestedNextPart);
      this.res.requestedNextPart = 0;
    }
    for (let t = 0; t < NUM_THREADS; t++) {
      this.active[CURR][t] = this.active[REQ][t];
      const n = this.threadReqPc[t];
      if (n !== NO_SETVEC_REQUESTED) {
        this.threadPc[t] = n === 0xFFFE ? INACTIVE_THREAD : n;
        this.threadReqPc[t] = NO_SETVEC_REQUESTED;
      }
    }
  }

  /** Run the script until it requests a frame to be displayed. */
  runFrame() {
    this.yielded = false;
    while (!this.yielded) {
      if (this.tid < 0) {
        this.checkThreadRequests();
        this.updatePlayerInput();
        if (this.onFrameStart) this.onFrameStart();
        this.tid = 0;
        this.inThread = false;
      }
      if (!this.inThread) {
        while (this.tid < NUM_THREADS &&
               (this.active[CURR][this.tid] || this.threadPc[this.tid] === INACTIVE_THREAD)) this.tid++;
        if (this.tid >= NUM_THREADS) { this.tid = -1; continue; }
        this.pc = this.threadPc[this.tid];
        this.sp = 0;
        this.gotoNextThread = false;
        this.inThread = true;
      }
      this.executeThread();
      if (this.gotoNextThread) {
        this.threadPc[this.tid] = this.pc;
        this.inThread = false;
        this.tid++;
      }
    }
  }

  /** Delay (ms) the script wants between the previous frame and the pending one. */
  get frameDelay() {
    return this.vars[VAR_PAUSE_SLICES] * 20;
  }

  completeBlit() {
    this.handleSpecialKeys();
    this.vars[0xF7] = 0;
    this.video.updateDisplay(this.pendingPage);
  }

  executeThread() {
    const res = this.res;
    const video = this.video;
    const code = res.segBytecode;
    const vars = this.vars;
    let pc = this.pc;
    const byte = () => code[pc++];
    const word = () => { const w = (code[pc] << 8) | code[pc + 1]; pc += 2; return w; };

    while (!this.gotoNextThread && !this.yielded) {
      const opcode = code[pc++];

      if (opcode & 0x80) {
        const off = (((opcode << 8) | byte()) * 2) & 0xFFFF;
        res.useSegVideo2 = false;
        let x = byte();
        let y = byte();
        const h = y - 199;
        if (h > 0) { y = 199; x += h; }
        video.setDataBuffer(res.segCinematic, off);
        video.readAndDrawPolygon(0xFF, 0x40, x, y);
        continue;
      }

      if (opcode & 0x40) {
        const off = (word() * 2) & 0xFFFF;
        let x = byte();
        res.useSegVideo2 = false;

        if (!(opcode & 0x20)) {
          if (!(opcode & 0x10)) x = s16((x << 8) | byte());
          else x = vars[x];
        } else if (opcode & 0x10) {
          x += 0x100;
        }

        let y = byte();
        if (!(opcode & 8)) {
          if (!(opcode & 4)) y = s16((y << 8) | byte());
          else y = vars[y];
        }

        let zoom = byte();
        if (!(opcode & 2)) {
          if (!(opcode & 1)) { pc--; zoom = 0x40; }
          else zoom = vars[zoom] & 0xFFFF;
        } else if (opcode & 1) {
          res.useSegVideo2 = true;
          pc--;
          zoom = 0x40;
        }
        video.setDataBuffer(res.useSegVideo2 ? res.segVideo2 : res.segCinematic, off);
        video.readAndDrawPolygon(0xFF, zoom, x, y);
        continue;
      }

      switch (opcode) {
        case 0x00: { // movConst
          const v = byte();
          vars[v] = word();
          break;
        }
        case 0x01: { // mov
          const d = byte();
          vars[d] = vars[byte()];
          break;
        }
        case 0x02: { // add
          const d = byte();
          vars[d] += vars[byte()];
          break;
        }
        case 0x03: { // addConst
          if (res.currentPartId === 0x3E86 && pc === 0x6D48) {
            // The script doesn't stop the looping gun sound by itself; play the 'stopping sound' like the others do.
            this.playSound(0x5B, 1, 64, 1);
          }
          const v = byte();
          vars[v] += word();
          break;
        }
        case 0x04: { // call
          const target = word();
          if (this.sp === 0xFF) throw new Error('VM stack overflow');
          this.stackCalls[this.sp++] = pc;
          pc = target;
          break;
        }
        case 0x05: // ret
          if (this.sp === 0) throw new Error('VM stack underflow');
          pc = this.stackCalls[--this.sp];
          break;
        case 0x06: // pauseThread
          this.gotoNextThread = true;
          break;
        case 0x07: // jmp
          pc = word();
          break;
        case 0x08: { // setVec
          const t = byte();
          this.threadReqPc[t] = word();
          break;
        }
        case 0x09: { // jnz
          const v = byte();
          vars[v]--;
          if (vars[v] !== 0) pc = word();
          else pc += 2;
          break;
        }
        case 0x0A: { // condJmp
          const op = byte();
          const b = vars[byte()];
          let a;
          if (op & 0x80) a = vars[byte()];
          else if (op & 0x40) a = s16(word());
          else a = byte();
          let expr = false;
          switch (op & 7) {
            case 0: expr = b === a; break;
            case 1: expr = b !== a; break;
            case 2: expr = b > a; break;
            case 3: expr = b >= a; break;
            case 4: expr = b < a; break;
            case 5: expr = b <= a; break;
          }
          if (expr) pc = word();
          else pc += 2;
          break;
        }
        case 0x0B: // setPalette
          video.paletteIdRequested = word() >> 8;
          break;
        case 0x0C: { // resetThread
          const threadId = byte();
          const last = byte() & (NUM_THREADS - 1);
          let n = last - threadId;
          const a = byte();
          if (n < 0) break;
          n++;
          if (a === 2) {
            for (let k = 0; k < n; k++) this.threadReqPc[threadId + k] = 0xFFFE;
          } else if (a < 2) {
            for (let k = 0; k < n; k++) this.active[REQ][threadId + k] = a;
          }
          break;
        }
        case 0x0D: // selectVideoPage
          video.changePagePtr1(byte());
          break;
        case 0x0E: { // fillVideoPage
          const page = byte();
          video.fillPage(page, byte());
          break;
        }
        case 0x0F: { // copyVideoPage
          const src = byte();
          video.copyPage(src, byte(), vars[VAR_SCROLL_Y]);
          break;
        }
        case 0x10: // blitFramebuffer
          this.pendingPage = byte();
          this.yielded = true;
          break;
        case 0x11: // killThread
          pc = 0xFFFF;
          this.gotoNextThread = true;
          break;
        case 0x12: { // drawString
          const id = word();
          const x = byte();
          const y = byte();
          video.drawString(byte(), x, y, id);
          break;
        }
        case 0x13: { // sub
          const d = byte();
          vars[d] -= vars[byte()];
          break;
        }
        case 0x14: { // and
          const v = byte();
          vars[v] = (vars[v] & 0xFFFF) & word();
          break;
        }
        case 0x15: { // or
          const v = byte();
          vars[v] = (vars[v] & 0xFFFF) | word();
          break;
        }
        case 0x16: { // shl
          const v = byte();
          vars[v] = (vars[v] & 0xFFFF) << word();
          break;
        }
        case 0x17: { // shr
          const v = byte();
          vars[v] = (vars[v] & 0xFFFF) >> word();
          break;
        }
        case 0x18: { // playSound
          const id = word();
          const freq = byte();
          const vol = byte();
          this.playSound(id, freq, vol, byte());
          break;
        }
        case 0x19: { // updateMemList
          const id = word();
          if (id === 0) {
            this.player.stop();
            this.mixer.stopAll();
            res.invalidateRes();
          } else {
            res.loadPartsOrMemoryEntry(id);
          }
          break;
        }
        case 0x1A: { // playMusic
          const resNum = word();
          const delay = word();
          this.playMusic(resNum, delay, byte());
          break;
        }
        default:
          throw new Error('invalid opcode 0x' + opcode.toString(16) + ' at 0x' + (pc - 1).toString(16));
      }
    }
    this.pc = pc;
  }

  playSound(resNum, freq, vol, channel) {
    const me = this.res.memList[resNum];
    if (me.state !== STATE_LOADED) return;
    if (vol === 0) {
      this.mixer.stopChannel(channel & 3);
      return;
    }
    const b = me.buf;
    const len = ((b[0] << 8) | b[1]) * 2;
    const loopLen = ((b[2] << 8) | b[3]) * 2;
    const chunk = {
      data: new Int8Array(b.buffer, b.byteOffset + 8, b.length - 8),
      len,
      loopPos: loopLen ? len : 0,
      loopLen,
    };
    this.mixer.playChannel(channel & 3, chunk, FREQUENCY_TABLE[freq], Math.min(vol, 0x3F));
  }

  playMusic(resNum, delay, pos) {
    if (resNum !== 0) {
      this.player.loadSfxModule(resNum, delay, pos);
      this.player.start();
    } else if (delay !== 0) {
      this.player.setEventsDelay(delay);
    } else {
      this.player.stop();
    }
  }

  updatePlayerInput() {
    const input = this.sys.input;
    const vars = this.vars;

    if (this.res.currentPartId === PART_LAST) {
      const c = input.lastChar;
      if (c === 8 || c === 0 || (c >= 97 && c <= 122)) {
        vars[VAR_LAST_KEYCHAR] = c & ~0x20;
        input.lastChar = 0;
      }
    }

    let lr = 0;
    let m = 0;
    let ud = 0;
    if (input.dirMask & DIR_RIGHT) { lr = 1; m |= 1; }
    if (input.dirMask & DIR_LEFT) { lr = -1; m |= 2; }
    if (input.dirMask & DIR_DOWN) { ud = 1; m |= 4; }

    vars[VAR_HERO_POS_UP_DOWN] = ud;
    if (input.dirMask & DIR_UP) vars[VAR_HERO_POS_UP_DOWN] = -1;
    if (input.dirMask & DIR_UP) { ud = -1; m |= 8; }

    vars[VAR_HERO_POS_JUMP_DOWN] = ud;
    vars[VAR_HERO_POS_LEFT_RIGHT] = lr;
    vars[VAR_HERO_POS_MASK] = m;
    let button = 0;
    if (input.button) { button = 1; m |= 0x80; }
    vars[VAR_HERO_ACTION] = button;
    vars[VAR_HERO_ACTION_POS_MASK] = m;
  }

  handleSpecialKeys() {
    const input = this.sys.input;
    if (input.code) {
      input.code = false;
      if (this.res.currentPartId !== PART_LAST && this.res.currentPartId !== PART_FIRST) {
        this.res.requestedNextPart = PART_LAST;
      }
    }
  }
}
