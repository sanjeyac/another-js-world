// Minimal ZIP reader (stored + deflate entries) built on the browser's DecompressionStream.

/** @returns {Promise<Map<string, Uint8Array>>} entries keyed by lowercase base name (folders are ignored) */
export async function readZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);

  // End of central directory record: search backwards (it may be followed by a comment).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xFFFF); i--) {
    if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip.invalid');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();
  const dec = new TextDecoder();

  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014B50) throw new Error('zip.corrupt');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;

    const dataStart = localOffset + 30 + dv.getUint16(localOffset + 26, true) + dv.getUint16(localOffset + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) {
      data = Uint8Array.from(raw);
    } else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      throw new Error('zip.unsupported');
    }
    if (data.length !== size) throw new Error('zip.corrupt');
    out.set(name.toLowerCase().split(/[\\/]/).pop(), data);
  }
  return out;
}
