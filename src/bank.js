// Bank unpacker: a backward-reading bit-stream decoder (ByteKiller-like) used by every compressed resource.

const readU32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

class Unpacker {
  constructor(buf, packedSize) {
    this.buf = buf;
    this.i = packedSize - 4; // input cursor, walks backwards
    this.datasize = readU32(buf, this.i); this.i -= 4;
    this.o = this.datasize - 1; // output cursor, walks backwards
    this.crc = readU32(buf, this.i); this.i -= 4;
    this.chk = readU32(buf, this.i); this.i -= 4;
    this.crc = (this.crc ^ this.chk) >>> 0;
    this.size = 0;
  }

  rcr(carryIn) {
    const carryOut = this.chk & 1;
    this.chk >>>= 1;
    if (carryIn) this.chk = (this.chk | 0x80000000) >>> 0;
    return carryOut;
  }

  nextBit() {
    let cf = this.rcr(0);
    if (this.chk === 0) {
      this.chk = readU32(this.buf, this.i); this.i -= 4;
      this.crc = (this.crc ^ this.chk) >>> 0;
      cf = this.rcr(1);
    }
    return cf;
  }

  getCode(n) {
    let c = 0;
    while (n--) c = (c << 1) | this.nextBit();
    return c;
  }

  literal(numBits, add) {
    let count = this.getCode(numBits) + add + 1;
    this.datasize -= count;
    while (count--) this.buf[this.o--] = this.getCode(8);
  }

  copy(numBits) {
    const offset = this.getCode(numBits);
    let count = this.size + 1;
    this.datasize -= count;
    while (count--) {
      this.buf[this.o] = this.buf[this.o + offset];
      this.o--;
    }
  }

  run() {
    do {
      if (!this.nextBit()) {
        this.size = 1;
        if (!this.nextBit()) this.literal(3, 0);
        else this.copy(8);
      } else {
        const c = this.getCode(2);
        if (c === 3) {
          this.literal(8, 8);
        } else if (c < 2) {
          this.size = c + 2;
          this.copy(c + 9);
        } else {
          this.size = this.getCode(8);
          this.copy(12);
        }
      }
    } while (this.datasize > 0);
    return this.crc === 0;
  }
}

/** Extract the resource described by `entry` from its bank file. Returns a Uint8Array of `entry.size` bytes. */
export function readResource(bankData, entry) {
  const raw = bankData.subarray(entry.bankOffset, entry.bankOffset + entry.packedSize);
  if (entry.packedSize === entry.size) return Uint8Array.from(raw);
  const buf = new Uint8Array(Math.max(entry.size, entry.packedSize));
  buf.set(raw);
  if (!new Unpacker(buf, entry.packedSize).run()) throw new Error('bank checksum mismatch');
  return buf.subarray(0, entry.size);
}
