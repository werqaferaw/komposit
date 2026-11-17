// A PNG writer for the pictures Komposit draws itself (contact sheets, waveforms): 8-bit RGB,
// no filter, deflated. Shared by the connectors that make pictures.
import { deflateSync } from "node:zlib";

let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 8-bit RGB pixels (W*H*3 bytes) as a PNG file. */
export function encodePng(px: Uint8Array, W: number, H: number): Uint8Array {
  const raw = Buffer.alloc((W * 3 + 1) * H); // one filter byte (none) per row
  for (let r = 0; r < H; r++) raw.set(px.subarray(r * W * 3, (r + 1) * W * 3), r * (W * 3 + 1) + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const out = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0))]);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
