// Pictures from Premiere Pro's frame export: smaller frames for the AI to look at, and
// contact sheets (many frames of a stretch in one picture, each with its time under it), so
// the AI can watch a stretch instead of spot-checking it. One look at eight frames can miss a
// half-second shot; a sheet of thirty can't. Ported from 1.0's sheets.mjs and listen.mjs
// (PNG reader and writer, the 3x5 font, the tiling). New in v2: frames are shrunk here, in
// plain code, so nothing depends on sips (Mac) or System.Drawing (Windows).
import { deflateSync, inflateSync } from "node:zlib";

export interface Rgb {
  w: number;
  h: number;
  /** 8-bit RGB, w*h*3 bytes. */
  rgb: Uint8Array;
}

const be32 = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

/** PNG bytes -> RGB (transparency over black). 8- or 16-bit, not interlaced. */
export function decodePng(buf: Uint8Array): Rgb {
  if (buf.length < 33 || be32(buf, 0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  const data: Uint8Array[] = [];
  while (pos + 8 <= buf.length) {
    const n = be32(buf, pos);
    const id = String.fromCharCode(buf[pos + 4]!, buf[pos + 5]!, buf[pos + 6]!, buf[pos + 7]!);
    const body = buf.subarray(pos + 8, pos + 8 + n);
    if (id === "IHDR") { w = be32(body, 0); h = be32(body, 4); depth = body[8]!; type = body[9]!; interlace = body[12]!; }
    else if (id === "PLTE") palette = body;
    else if (id === "IDAT") data.push(body);
    else if (id === "IEND") break;
    pos += 12 + n;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!w || !h || !channels || interlace || !(depth === 8 || (depth === 16 && type !== 3))) {
    throw new Error("a PNG this reader doesn't take (8 or 16 bits, not interlaced, only)");
  }
  const raw = inflateSync(Buffer.concat(data));
  const bpp = channels * (depth / 8); // bytes per pixel
  const stride = w * bpp;
  if (raw.length < h * (stride + 1)) throw new Error("a PNG that ends early");
  let line = new Uint8Array(stride), prev = new Uint8Array(stride);
  const rgb = new Uint8Array(w * h * 3);
  const at = depth === 16 ? (i: number) => i * 2 : (i: number) => i; // the high byte of a 16-bit sample
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++]!;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp]! : 0, b = prev[x]!, c = x >= bpp ? prev[x - bpp]! : 0;
      let v = raw[p++]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3, i = x * channels;
      if (type === 2) { rgb[o] = line[at(i)]!; rgb[o + 1] = line[at(i + 1)]!; rgb[o + 2] = line[at(i + 2)]!; }
      else if (type === 6) { const al = line[at(i + 3)]! / 255; rgb[o] = line[at(i)]! * al; rgb[o + 1] = line[at(i + 1)]! * al; rgb[o + 2] = line[at(i + 2)]! * al; }
      else if (type === 0) { rgb[o] = rgb[o + 1] = rgb[o + 2] = line[at(i)]!; }
      else if (type === 4) { const g = (line[at(i)]! * line[at(i + 1)]!) / 255; rgb[o] = rgb[o + 1] = rgb[o + 2] = g; }
      else { const k = line[i]! * 3; rgb[o] = palette ? palette[k]! : 0; rgb[o + 1] = palette ? palette[k + 1]! : 0; rgb[o + 2] = palette ? palette[k + 2]! : 0; }
    }
    const t = prev; prev = line; line = t;
  }
  return { w, h, rgb };
}

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

/** The picture made smaller (never larger) so its longest side is `max`: each new pixel is
 *  the average of the ones it covers. */
export function shrink(img: Rgb, max: number): Rgb {
  const s = Math.min(1, max / Math.max(img.w, img.h));
  if (s >= 1) return img;
  const W = Math.max(1, Math.round(img.w * s)), H = Math.max(1, Math.round(img.h * s));
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor((y * img.h) / H), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.h) / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor((x * img.w) / W), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.w) / W));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let o = (yy * img.w + x0) * 3;
        for (let xx = x0; xx < x1; xx++, o += 3) { r += img.rgb[o]!; g += img.rgb[o + 1]!; b += img.rgb[o + 2]!; n++; }
      }
      const k = (y * W + x) * 3;
      out[k] = r / n; out[k + 1] = g / n; out[k + 2] = b / n;
    }
  }
  return { w: W, h: H, rgb: out };
}

/** A PNG made smaller for looking at (longest side `max`); the PNG as it was when it's
 *  already small enough or can't be read here. */
export function smallerPng(bytes: Uint8Array, max: number): { bytes: Uint8Array; width?: number; height?: number } {
  try {
    const img = decodePng(bytes);
    if (Math.max(img.w, img.h) <= max) return { bytes, width: img.w, height: img.h };
    const s = shrink(img, max);
    return { bytes: encodePng(s.rgb, s.w, s.h), width: s.w, height: s.h };
  } catch {
    return { bytes };
  }
}

// 3x5 pixel digits for the times under the frames (rows top to bottom).
const FONT: Record<string, string> = {
  0: "111101101101111", 1: "010110010010111", 2: "111001111100111", 3: "111001111001111", 4: "101101111001001",
  5: "111100111001111", 6: "111100111101111", 7: "111001010010010", 8: "111101111101111", 9: "111101111001111",
  ":": "000010000010000", ".": "000000000000010", "-": "000000111000000", " ": "000000000000000",
};

function text(px: Uint8Array, W: number, H: number, str: string, x: number, y: number, color: number[], scale = 2): void {
  for (const ch of String(str)) {
    const g = FONT[ch] || FONT[" "]!;
    for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) if (g[r * 3 + q] === "1") for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const X = x + q * scale + dx, Y = y + r * scale + dy;
      if (X >= 0 && Y >= 0 && X < W && Y < H) { const o = (Y * W + X) * 3; px[o] = color[0]!; px[o + 1] = color[1]!; px[o + 2] = color[2]!; }
    }
    x += 4 * scale;
  }
}

/** How many frames fit a sheet for thumbnails of this size. */
export function grid(tw: number, th: number, { maxW = 1500, maxH = 1320 } = {}): { cols: number; rows: number; per: number } {
  const cols = Math.max(1, Math.floor(maxW / (tw + 4))), rows = Math.max(1, Math.floor(maxH / (th + 18)));
  return { cols, rows, per: cols * rows };
}

export interface Thumb extends Rgb {
  /** Under the frame: its time. */
  label: string;
  /** A line over the frame: the first frame of a new clip, so the cuts show. */
  mark?: boolean;
}

/** Thumbnails of one size -> PNG sheets, read left to right, top to bottom. */
export function tile(thumbs: Thumb[]): Uint8Array[] {
  if (!thumbs.length) return [];
  const tw = thumbs[0]!.w, th = thumbs[0]!.h, g = grid(tw, th), sheets: Uint8Array[] = [];
  for (let s = 0; s < thumbs.length; s += g.per) {
    const part = thumbs.slice(s, s + g.per), cols = Math.min(g.cols, part.length), rows = Math.ceil(part.length / g.cols);
    const W = cols * (tw + 4) + 4, H = rows * (th + 18) + 4, px = new Uint8Array(W * H * 3).fill(22);
    part.forEach((t, i) => {
      const x0 = 4 + (i % g.cols) * (tw + 4), y0 = 4 + Math.floor(i / g.cols) * (th + 18);
      for (let y = 0; y < Math.min(th, t.h); y++) px.set(t.rgb.subarray(y * t.w * 3, (y * t.w + Math.min(tw, t.w)) * 3), ((y0 + y) * W + x0) * 3);
      if (t.mark) for (let x = 0; x < tw; x++) for (let dy = 0; dy < 2; dy++) { const o = ((y0 - 3 + dy) * W + x0 + x) * 3; if (o >= 0) { px[o] = 255; px[o + 1] = 200; px[o + 2] = 60; } }
      text(px, W, H, t.label, x0 + 1, y0 + th + 4, [200, 202, 210]);
    });
    sheets.push(encodePng(px, W, H));
  }
  return sheets;
}

/** Frame PNGs -> contact sheets. `detail`: larger thumbnails, fewer per sheet. Frames that
 *  can't be read are left out; frames of another size than the first are too. */
export function contactSheets(frames: { png: Uint8Array; label: string; mark?: boolean }[], { detail = false } = {}): { sheets: Uint8Array[]; per: number; count: number } {
  const size = detail ? 460 : 300;
  const thumbs: Thumb[] = [];
  for (const f of frames) {
    try {
      thumbs.push({ ...shrink(decodePng(f.png), size), label: f.label, mark: !!f.mark });
    } catch { /* a frame Premiere didn't finish, or a PNG this can't read */ }
  }
  if (!thumbs.length) throw new Error("The frames couldn't be read to make a contact sheet.");
  const { w, h } = thumbs[0]!;
  const same = thumbs.filter((t) => t.w === w && t.h === h);
  return { sheets: tile(same), per: grid(w, h).per, count: same.length };
}
