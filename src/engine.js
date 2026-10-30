import { Resource, STATE_LOADED, STATE_NOT_NEEDED } from './resource.js';
import { Video } from './video.js';
import { Mixer, SfxPlayer } from './mixer.js';
import { VirtualMachine, VAR_MUS_MARK } from './vm.js';
import { PART_FIRST, PARTS } from './tables.js';

/**
 * Glue between the virtual machine, resources, renderer and sound.
 *
 * `sys` is the platform layer and must provide:
 *   input: { dirMask, button, lastChar, code, save, load }
 *   setPalette(Uint8Array 32 bytes), updateDisplay(Uint8Array 4bpp page)
 */
export class Engine {
  constructor(sys, getFile, sampleRate = 22050) {
    this.sys = sys;
    this.mixer = new Mixer(sampleRate);
    this.video = new Video(null, sys);
    this.res = new Resource(this.video, getFile);
    this.video.res = this.res;
    this.player = new SfxPlayer(this.mixer, this.res, (v) => { this.vm.vars[VAR_MUS_MARK] = v; });
    this.vm = new VirtualMachine(this.res, this.video, this.mixer, this.player, sys);
    this.vm.onFrameStart = () => this.processInput();
    this.saveHandler = null; // (snapshot) => void
    this.pendingLoad = null; // snapshot to restore at the next frame start
  }

  /** @param {number} partId  first game part: 0x3E80 = copy protection, 0x3E81 = intro */
  init(partId = PART_FIRST + 1) {
    this.video.init();
    this.res.readEntries();
    this.vm.init({ bypassProtection: partId !== PART_FIRST });
    this.vm.initForPart(partId);
  }

  processInput() {
    const input = this.sys.input;
    if (input.save) {
      input.save = false;
      if (this.saveHandler) this.saveHandler(this.snapshot());
    }
    if (input.load) {
      input.load = false;
    }
    if (this.pendingLoad) {
      const s = this.pendingLoad;
      this.pendingLoad = null;
      this.restore(s);
    }
  }

  /** Run the VM until the next frame is ready to be shown. */
  runFrame() { this.vm.runFrame(); }
  get frameDelay() { return this.vm.frameDelay; }
  showFrame() { this.vm.completeBlit(); }

  snapshot() {
    const { vm, res, video, player } = this;
    return {
      version: 1,
      vars: Array.from(vm.vars),
      stackCalls: Array.from(vm.stackCalls),
      threadPc: Array.from(vm.threadPc),
      threadReqPc: Array.from(vm.threadReqPc),
      active: [Array.from(vm.active[0]), Array.from(vm.active[1])],
      partId: res.currentPartId,
      useSegVideo2: res.useSegVideo2,
      loaded: res.memList.map((m, i) => (m.state === STATE_LOADED ? i : -1)).filter((i) => i >= 0),
      palette: video.currentPaletteId,
      pages: video.pages.map((p) => Uint8Array.from(p)),
      cur: [video.cur1, video.cur2, video.cur3].map((p) => video.pages.indexOf(p)),
      music: { resNum: player.resNum, delay: player.delay, curPos: player.mod ? player.mod.curPos : 0,
               curOrder: player.mod ? player.mod.curOrder : 0 },
    };
  }

  restore(s) {
    const { vm, res, video, player } = this;
    player.stop();
    this.mixer.stopAll();
    vm.vars.set(s.vars);
    vm.stackCalls.set(s.stackCalls);
    vm.threadPc.set(s.threadPc);
    vm.threadReqPc.set(s.threadReqPc);
    vm.active[0].set(s.active[0]);
    vm.active[1].set(s.active[1]);

    res.invalidateAll();
    res.currentPartId = s.partId;
    res.requestedNextPart = 0;
    res.useSegVideo2 = s.useSegVideo2;
    for (const id of s.loaded) {
      const me = res.memList[id];
      me.buf = res.readBank(me);
      me.state = STATE_LOADED;
    }
    const [pal, code, cin, v2] = PARTS[s.partId - PART_FIRST];
    res.segPalettes = res.memList[pal].buf;
    res.segBytecode = res.memList[code].buf;
    res.segCinematic = res.memList[cin].buf;
    res.segVideo2 = v2 ? res.memList[v2].buf : null;

    s.pages.forEach((p, i) => video.pages[i].set(p));
    [video.cur1, video.cur2, video.cur3] = s.cur.map((i) => video.pages[i]);
    video.paletteIdRequested = 0xFF;
    video.changePal(s.palette);

    if (s.music.resNum) {
      player.loadSfxModule(s.music.resNum, 0, s.music.curOrder);
      player.mod.curPos = s.music.curPos;
      player.delay = s.music.delay;
      player.mixer.setTimer(player.delay, () => { player.handleEvents(); return player.delay; });
    }
  }
}

export { STATE_NOT_NEEDED };
