// Hearing a media file: its sound turned into numbers on this computer, with plain signal
// maths (no AI model; nothing leaves the machine). Ported from 1.0's companion/listen.mjs
// (decode and analyze), with v2's own decoding and a cache in the scratch folder.
//
//   read      a WAV (any PCM or float format) or an AIFF/AIFC is read as it is, on any system
//   decode    anything else (MP3, AAC/M4A, a movie's sound...) goes through the system's own
//             decoder into a 16 kHz WAV first:
//               Mac      afconvert (Core Audio), then avconvert (AVFoundation) for the movies
//                        afconvert won't read;
//               Windows  Media Foundation, through Windows' own MediaTranscoder from
//                        PowerShell (Windows 10 and 11 have both);
//               either   ffmpeg, when the person has it (KOMPOSIT_FFMPEG, or on the PATH).
//             Nothing is bundled: the installer stays the size it was.
//   analyze   one streaming pass over the PCM: a level envelope (20 ms steps), loudness
//             (ITU-R BS.1770 K-weighting with gating: LUFS), peak and clipping, whether left
//             and right carry different sound (two mics on one file), and the energy of three
//             bands every 10 ms (bass, middle, top) that hearing.ts reads the beat from.
//             It yields to the event loop as it goes, so a long file doesn't stall the app.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { FLOOR_DB, HOP, STEP, hearMusic } from "./hearing.ts";
import type { Music } from "./hearing.ts";

export { FLOOR_DB, HOP, STEP };
/** The rate decoders write at: plenty for levels, speech and the beat. */
export const RATE = 16000;
const CACHE_VERSION = 3;

// ---------- reading PCM ----------

export interface PcmFormat {
  container: "wav" | "aiff";
  /** Whole numbers or floats. */
  kind: "int" | "float";
  channels: number;
  rate: number;
  bits: number;
  bigEndian: boolean;
  /** 8-bit WAV is unsigned; 8-bit AIFF is signed. */
  unsigned8: boolean;
  dataOffset: number;
  dataBytes: number;
}

/** An AIFF sample rate: an 80-bit extended float. */
function extended80(b: Buffer, at: number): number {
  const exp = ((b[at]! & 0x7f) << 8) | b[at + 1]!;
  const hi = b.readUInt32BE(at + 2), lo = b.readUInt32BE(at + 6);
  if (!exp && !hi && !lo) return 0;
  return (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63);
}

/** Where the PCM is in a WAV or AIFF file, or null when it's neither (or compressed). */
export function readPcmFormat(fd: number, fileSize: number): PcmFormat | null {
  const head = Buffer.alloc(12);
  if (readSync(fd, head, 0, 12, 0) < 12) return null;
  const magic = head.toString("ascii", 0, 4), form = head.toString("ascii", 8, 12);
  const ch = Buffer.alloc(8);
  if ((magic === "RIFF" || magic === "RF64") && form === "WAVE") {
    let pos = 12, fmt: Omit<PcmFormat, "dataOffset" | "dataBytes"> | null = null, big: number | null = null;
    for (let guard = 0; guard < 256 && pos + 8 <= fileSize; guard++) {
      readSync(fd, ch, 0, 8, pos);
      const id = ch.toString("ascii", 0, 4), size = ch.readUInt32LE(4);
      if (id === "ds64") { const b = Buffer.alloc(16); readSync(fd, b, 0, 16, pos + 8); big = Number(b.readBigUInt64LE(8)); }
      else if (id === "fmt ") {
        const b = Buffer.alloc(Math.min(size, 40));
        readSync(fd, b, 0, b.length, pos + 8);
        let tag = b.readUInt16LE(0);
        if (tag === 0xfffe && b.length >= 26) tag = b.readUInt16LE(24); // "extensible": the real format is in the sub-format
        if (tag !== 1 && tag !== 3) return null;
        fmt = { container: "wav", kind: tag === 3 ? "float" : "int", channels: b.readUInt16LE(2), rate: b.readUInt32LE(4), bits: b.readUInt16LE(14), bigEndian: false, unsigned8: true };
      } else if (id === "data") {
        if (!fmt) return null;
        const bytes = big ?? (size === 0xffffffff || size === 0 ? fileSize - pos - 8 : size);
        return { ...fmt, dataOffset: pos + 8, dataBytes: Math.min(bytes, fileSize - pos - 8) };
      }
      pos += 8 + size + (size % 2);
    }
    return null;
  }
  if (magic === "FORM" && (form === "AIFF" || form === "AIFC")) {
    let pos = 12, fmt: Omit<PcmFormat, "dataOffset" | "dataBytes"> | null = null;
    for (let guard = 0; guard < 256 && pos + 8 <= fileSize; guard++) {
      readSync(fd, ch, 0, 8, pos);
      const id = ch.toString("ascii", 0, 4), size = ch.readUInt32BE(4);
      if (id === "COMM") {
        const b = Buffer.alloc(Math.min(size, 64));
        readSync(fd, b, 0, b.length, pos + 8);
        const channels = b.readUInt16BE(0), bits = b.readUInt16BE(6), rate = extended80(b, 8);
        let kind: "int" | "float" = "int", bigEndian = true;
        if (form === "AIFC" && b.length >= 22) {
          const comp = b.toString("ascii", 18, 22);
          if (comp === "sowt") bigEndian = false;
          else if (comp === "fl32" || comp === "FL32" || comp === "fl64" || comp === "FL64") kind = "float";
          else if (comp !== "NONE" && comp !== "twos" && comp !== "in24" && comp !== "in32") return null;
        }
        fmt = { container: "aiff", kind, channels, rate: Math.round(rate), bits, bigEndian, unsigned8: false };
      } else if (id === "SSND") {
        if (!fmt) {
          // COMM after SSND is allowed; look ahead for it.
          const rest = readPcmFormatAfter(fd, fileSize, pos + 8 + size + (size % 2));
          if (!rest) return null;
          fmt = rest;
        }
        const b = Buffer.alloc(8);
        readSync(fd, b, 0, 8, pos + 8);
        const offset = b.readUInt32BE(0);
        return { ...fmt, dataOffset: pos + 16 + offset, dataBytes: Math.min(size - 8 - offset, fileSize - pos - 16 - offset) };
      }
      pos += 8 + size + (size % 2);
    }
  }
  return null;
}

function readPcmFormatAfter(fd: number, fileSize: number, from: number): Omit<PcmFormat, "dataOffset" | "dataBytes"> | null {
  const ch = Buffer.alloc(8);
  for (let pos = from, guard = 0; guard < 64 && pos + 8 <= fileSize; guard++) {
    readSync(fd, ch, 0, 8, pos);
    const id = ch.toString("ascii", 0, 4), size = ch.readUInt32BE(4);
    if (id === "COMM") {
      const b = Buffer.alloc(Math.min(size, 64));
      readSync(fd, b, 0, b.length, pos + 8);
      return { container: "aiff", kind: "int", channels: b.readUInt16BE(0), rate: Math.round(extended80(b, 8)), bits: b.readUInt16BE(6), bigEndian: true, unsigned8: false };
    }
    pos += 8 + size + (size % 2);
  }
  return null;
}

/** How to read one sample of a format as -1 to 1. */
function sampleReader(f: PcmFormat): ((b: Buffer, o: number) => number) | null {
  if (f.kind === "float") {
    if (f.bits === 32) return f.bigEndian ? (b, o) => b.readFloatBE(o) : (b, o) => b.readFloatLE(o);
    if (f.bits === 64) return f.bigEndian ? (b, o) => b.readDoubleBE(o) : (b, o) => b.readDoubleLE(o);
    return null;
  }
  if (f.bits === 16) return f.bigEndian ? (b, o) => b.readInt16BE(o) / 32768 : (b, o) => b.readInt16LE(o) / 32768;
  if (f.bits === 24) return f.bigEndian ? (b, o) => b.readIntBE(o, 3) / 8388608 : (b, o) => b.readIntLE(o, 3) / 8388608;
  if (f.bits === 32) return f.bigEndian ? (b, o) => b.readInt32BE(o) / 2147483648 : (b, o) => b.readInt32LE(o) / 2147483648;
  if (f.bits === 8) return f.unsigned8 ? (b, o) => (b[o]! - 128) / 128 : (b, o) => b.readInt8(o) / 128;
  return null;
}

/** The file is a WAV or AIFF this module reads itself. */
export function isPlainPcm(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const f = readPcmFormat(fd, statSync(path).size);
    return !!f && !!sampleReader(f) && f.channels > 0 && f.rate > 0;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// ---------- the analysis ----------

export interface Analysis {
  v: number;
  duration: number;
  channels: number;
  /** Level in dB every HOP seconds, the channels mixed. */
  env: Float32Array;
  /** Left and right apart, when they carry different sound (two mics on one file). */
  envL?: Float32Array;
  envR?: Float32Array;
  peakDb: number;
  /** Samples at full scale. */
  clipped: number;
  /** Integrated loudness (LUFS), null when too short or silent. */
  lufs: number | null;
  /** The beat, bars, sections, hits and a short sound's shape (hearing.ts). */
  music: Music;
}

/** K-weighting (ITU-R BS.1770) as two biquads for a sample rate. */
function kWeights(fs: number) {
  const f1 = 1681.974450955533, G = 3.999843853973347, Q1 = 0.7071752369554196;
  let K = Math.tan((Math.PI * f1) / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q1 + K * K;
  const shelf = { b0: (Vh + (Vb * K) / Q1 + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q1 + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q1 + K * K) / a0 };
  const f2 = 38.13547087602444, Q2 = 0.5003270373238773;
  K = Math.tan((Math.PI * f2) / fs);
  a0 = 1 + K / Q2 + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q2 + K * K) / a0 };
  return [shelf, hp] as const;
}

export const dbOf = (meanSquare: number) => (meanSquare > 1e-10 ? 10 * Math.log10(meanSquare) : FLOOR_DB);
const pause = () => new Promise<void>((r) => setImmediate(r));

/** One streaming pass over a WAV or AIFF file (any rate, any channel count). */
export async function analyzePcm(path: string): Promise<Analysis> {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const h = readPcmFormat(fd, size);
    const read = h ? sampleReader(h) : null;
    if (!h || !read || !h.channels || !h.rate) throw new Error("not plain PCM audio");
    const C = h.channels, fs = h.rate, B = h.bits / 8;
    const frames = Math.floor(h.dataBytes / (B * C));
    const hopN = Math.round(fs * HOP), onsetN = Math.round(fs * STEP), subN = Math.round(fs * 0.1);
    const nHop = Math.ceil(frames / hopN), nOnset = Math.ceil(frames / onsetN), nSub = Math.floor(frames / subN);
    const env = new Float32Array(nHop), envL = C >= 2 ? new Float32Array(nHop) : null, envR = C >= 2 ? new Float32Array(nHop) : null;
    // The beat: energy every 10 ms in three bands. Music today is mastered so evenly that its
    // overall level hardly moves on a beat; the kick and the hi-hat still do, each in its band.
    const bandLow = new Float32Array(nOnset), bandMid = new Float32Array(nOnset), bandHigh = new Float32Array(nOnset);
    const aLow = 1 - Math.exp((-2 * Math.PI * 180) / fs), aTop = 1 - Math.exp((-2 * Math.PI * 3000) / fs);
    let l1 = 0, l2 = 0, t1 = 0, t2 = 0, eLow = 0, eMid = 0, eHigh = 0;
    const sub = new Float64Array(Math.max(1, nSub)); // K-weighted power per 100 ms, channels summed
    const [s1, s2] = kWeights(fs);
    const z1 = new Float64Array(C * 2), z2 = new Float64Array(C * 2);
    let peak = 0, clipped = 0;
    let hopI = 0, hopCount = 0, hopSum = 0, hopSumL = 0, hopSumR = 0;
    let onI = 0, onCount = 0;
    let subI = 0, subCount = 0, subSum = 0;
    const CHUNK = 32768;
    const buf = Buffer.alloc(CHUNK * C * B);
    let done = 0, chunks = 0;
    while (done < frames) {
      const want = Math.min(CHUNK, frames - done);
      const got = readSync(fd, buf, 0, want * C * B, h.dataOffset + done * C * B);
      const n = Math.floor(got / (C * B));
      if (!n) break;
      for (let i = 0; i < n; i++) {
        let mix = 0, kPow = 0;
        for (let c = 0; c < C; c++) {
          const x = read(buf, (i * C + c) * B);
          const a = x < 0 ? -x : x;
          if (a > peak) peak = a;
          if (a >= 0.9997) clipped++;
          mix += x;
          if (c === 0) hopSumL += x * x;
          else if (c === 1) hopSumR += x * x;
          const o = c * 2;
          const y = s1.b0 * x + z1[o]!; z1[o] = s1.b1 * x - s1.a1 * y + z1[o + 1]!; z1[o + 1] = s1.b2 * x - s1.a2 * y;
          const y2 = s2.b0 * y + z2[o]!; z2[o] = s2.b1 * y - s2.a1 * y2 + z2[o + 1]!; z2[o + 1] = s2.b2 * y - s2.a2 * y2;
          if (c < 3) kPow += y2 * y2; // L, R, C weigh 1; anything past that is left out
        }
        mix /= C;
        const p = mix * mix;
        hopSum += p; subSum += kPow;
        l1 += aLow * (mix - l1); l2 += aLow * (l1 - l2);
        t1 += aTop * (mix - t1); t2 += aTop * (t1 - t2);
        const hi = mix - t2, mid = t2 - l2;
        eLow += l2 * l2; eMid += mid * mid; eHigh += hi * hi;
        if (++hopCount === hopN) {
          env[hopI] = dbOf(hopSum / hopN);
          if (envL && envR) { envL[hopI] = dbOf(hopSumL / hopN); envR[hopI] = dbOf(hopSumR / hopN); }
          hopI++; hopCount = 0; hopSum = hopSumL = hopSumR = 0;
        }
        if (++onCount === onsetN) { bandLow[onI] = eLow / onsetN; bandMid[onI] = eMid / onsetN; bandHigh[onI] = eHigh / onsetN; onI++; onCount = 0; eLow = eMid = eHigh = 0; }
        if (++subCount === subN) { if (subI < sub.length) sub[subI++] = subSum / subN; subCount = 0; subSum = 0; }
      }
      done += n;
      if (++chunks % 8 === 0) await pause();
    }
    if (hopCount && hopI < nHop) {
      env[hopI] = dbOf(hopSum / hopCount);
      if (envL && envR) { envL[hopI] = dbOf(hopSumL / hopCount); envR[hopI] = dbOf(hopSumR / hopCount); }
      hopI++;
    }
    const e = env.subarray(0, hopI);
    const out: Analysis = {
      v: CACHE_VERSION,
      duration: frames / fs,
      channels: C,
      env: e,
      peakDb: peak ? Math.round(200 * Math.log10(peak)) / 10 : FLOOR_DB,
      clipped,
      lufs: integratedLoudness(sub.subarray(0, subI)),
      music: hearMusic([bandLow.subarray(0, onI), bandMid.subarray(0, onI), bandHigh.subarray(0, onI)], e),
    };
    if (envL && envR && channelsDiffer(envL.subarray(0, hopI), envR.subarray(0, hopI))) { out.envL = envL.subarray(0, hopI); out.envR = envR.subarray(0, hopI); }
    return out;
  } finally {
    closeSync(fd);
  }
}

/** Gated loudness from K-weighted power per 100 ms (400 ms blocks, 75% overlap). */
export function integratedLoudness(sub: Float64Array): number | null {
  const blocks: number[] = [];
  for (let i = 0; i + 4 <= sub.length; i++) blocks.push((sub[i]! + sub[i + 1]! + sub[i + 2]! + sub[i + 3]!) / 4);
  if (!blocks.length) return null;
  const L = (z: number) => -0.691 + 10 * Math.log10(z);
  const abs = blocks.filter((z) => z > 0 && L(z) > -70);
  if (!abs.length) return null;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const kept = abs.filter((z) => L(z) > rel);
  if (!kept.length) return null;
  return Math.round(L(kept.reduce((a, b) => a + b, 0) / kept.length) * 10) / 10;
}

/** Left and right differ when, over the steps with sound, their levels are far apart on
 *  average: two mics recorded to one stereo file. */
function channelsDiffer(L: Float32Array, R: Float32Array): boolean {
  let n = 0, diff = 0;
  for (let i = 0; i < L.length; i++) {
    if (L[i]! < -55 && R[i]! < -55) continue;
    n++;
    diff += Math.abs(L[i]! - R[i]!);
  }
  return n > 50 && diff / n > 6;
}

// ---------- decoding ----------

export interface DecodeResult {
  ok: boolean;
  error?: string;
  /** Which decoder read it. */
  by?: string;
}

/** What turns a media file's sound into a WAV: the system's own tools, in order. */
export interface Decoder {
  name: string;
  decode(src: string, dst: string, o: { rate: number; timeoutMs: number }): Promise<DecodeResult>;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; error: string; missing?: boolean }> {
  return new Promise((resolve) => {
    let err = "";
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ ok: false, error: (e as Error).message, missing: true });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stderr.on("data", (d) => { if (err.length < 4000) err += d; });
    child.on("error", (e: NodeJS.ErrnoException) => { clearTimeout(timer); resolve({ ok: false, error: e.message, missing: e.code === "ENOENT" }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, error: err.trim() }); });
  });
}
const lastLine = (s: string) => s.trim().split(/\r?\n/).pop() || "";

/** Mac: Core Audio's afconvert reads audio files and the sound of most movies; avconvert
 *  (AVFoundation) pulls the sound out of the movies it won't. Both ship with macOS. */
export const macDecoder: Decoder = {
  name: "macOS (afconvert)",
  async decode(src, dst, { rate, timeoutMs }) {
    const fmt = ["-f", "WAVE", "-d", `LEI16@${rate}`];
    let r = await run("afconvert", [...fmt, src, dst], timeoutMs);
    if (r.ok && existsSync(dst)) return { ok: true, by: "afconvert" };
    const m4a = dst.replace(/\.wav$/i, "") + ".m4a";
    try {
      r = await run("avconvert", ["--source", src, "--preset", "PresetAppleM4A", "--output", m4a, "--replace"], timeoutMs);
      if (!r.ok || !existsSync(m4a)) return { ok: false, error: lastLine(r.error) || "no sound macOS can read" };
      r = await run("afconvert", [...fmt, m4a, dst], timeoutMs);
      return r.ok && existsSync(dst) ? { ok: true, by: "avconvert" } : { ok: false, error: lastLine(r.error) || "no sound macOS can read" };
    } finally {
      try { unlinkSync(m4a); } catch { /* not made */ }
    }
  },
};

/** Windows: Media Foundation (what Windows itself plays files with), through WinRT's
 *  MediaTranscoder from Windows PowerShell 5.1. Both come with Windows 10 and 11. */
export const WIN_DECODE_PS1 = `param([string]$In, [string]$Out, [int]$Rate = 16000)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Media.Transcoding.MediaTranscoder, Windows.Media.Transcoding, ContentType = WindowsRuntime]
  $null = [Windows.Media.MediaProperties.MediaEncodingProfile, Windows.Media.MediaProperties, ContentType = WindowsRuntime]
  $ext = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 }
  $asOp = $ext | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
  $asProgress = $ext | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncActionWithProgress\`1' } | Select-Object -First 1
  function Await($op, [Type]$type) { $t = $asOp.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(-1); $t.Result }
  $src = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($In)) ([Windows.Storage.StorageFile])
  $dir = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync([IO.Path]::GetDirectoryName($Out))) ([Windows.Storage.StorageFolder])
  $dst = Await ($dir.CreateFileAsync([IO.Path]::GetFileName($Out), [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
  $prof = [Windows.Media.MediaProperties.MediaEncodingProfile]::CreateWav([Windows.Media.MediaProperties.AudioEncodingQuality]::Medium)
  $prof.Audio.SampleRate = $Rate
  $prof.Audio.BitsPerSample = 16
  $tc = New-Object Windows.Media.Transcoding.MediaTranscoder
  $prep = Await ($tc.PrepareFileTranscodeAsync($src, $dst, $prof)) ([Windows.Media.Transcoding.PrepareTranscodeResult])
  if (-not $prep.CanTranscode) { [Console]::Error.WriteLine('Windows cannot read the sound of this file (' + $prep.FailureReason + ').'); exit 2 }
  $t = $asProgress.MakeGenericMethod([double]).Invoke($null, @($prep.TranscodeAsync()))
  $null = $t.Wait(-1)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

export function winDecoder(scratchDir: () => string): Decoder {
  return {
    name: "Windows (Media Foundation)",
    async decode(src, dst, { rate, timeoutMs }) {
      const script = join(scratchDir(), "komposit-decode-audio.ps1");
      try {
        if (!existsSync(script) || readFileSync(script, "utf8") !== WIN_DECODE_PS1) writeFileSync(script, WIN_DECODE_PS1, "utf8");
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      // Windows PowerShell 5.1 by its full path (a PATH can lose System32), else by name.
      const root = process.env.SystemRoot || process.env.windir;
      const ps = root ? win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
      const r = await run(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-In", src, "-Out", dst, "-Rate", String(rate)], timeoutMs);
      if (r.ok && existsSync(dst) && statSync(dst).size > 44) return { ok: true, by: "Media Foundation" };
      return { ok: false, error: lastLine(r.error) || "no sound Windows can read" };
    },
  };
}

/** ffmpeg, when the person has it: KOMPOSIT_FFMPEG, else "ffmpeg" on the PATH. */
export function ffmpegDecoder(path = process.env.KOMPOSIT_FFMPEG || "ffmpeg"): Decoder {
  let missing = false;
  return {
    name: "ffmpeg",
    async decode(src, dst, { rate, timeoutMs }) {
      if (missing) return { ok: false, error: "no ffmpeg" };
      const r = await run(path, ["-v", "error", "-nostdin", "-y", "-i", src, "-vn", "-ar", String(rate), "-c:a", "pcm_s16le", "-f", "wav", dst], timeoutMs);
      if (r.missing) { missing = true; return { ok: false, error: "no ffmpeg" }; }
      return r.ok && existsSync(dst) ? { ok: true, by: "ffmpeg" } : { ok: false, error: lastLine(r.error) || "ffmpeg could not read the sound" };
    },
  };
}

/** The decoders for a system, in the order they're tried. */
export function systemDecoders(platform: "mac" | "win" | string, scratchDir: () => string): Decoder[] {
  const own = platform === "mac" ? [macDecoder] : platform === "win" ? [winDecoder(scratchDir)] : [];
  return [...own, ffmpegDecoder()];
}

// ---------- the ear: decode, analyze, remember ----------

export interface EarOptions {
  /** Where decoded files and the cache go. Default: <temp>/komposit. */
  scratchDir?: () => string;
  /** The decoders to try, in order. Default: systemDecoders(platform). */
  decoders?: Decoder[];
  platform?: "mac" | "win" | string;
  /** Longest a decode may take. Default 15 minutes (an hour of footage). */
  timeoutMs?: number;
}

export interface Ear {
  /** A media file's sound, analyzed (and remembered until the file changes). Throws a plain
   *  sentence when the file has no sound that can be read. */
  hear(path: string): Promise<Analysis>;
}

const packEnv = (f: Float32Array) => {
  const a = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) a[i] = Math.round(Math.max(FLOOR_DB, Math.min(0, f[i]!)) * 100);
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
};
const unpackEnv = (s: string) => {
  const b = Buffer.from(s, "base64");
  const a = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
  const f = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) f[i] = a[i]! / 100;
  return f;
};

export function createEar(o: EarOptions = {}): Ear {
  const scratch = o.scratchDir ?? (() => { const d = join(tmpdir(), "komposit"); mkdirSync(d, { recursive: true }); return d; });
  const decoders = o.decoders ?? systemDecoders(o.platform ?? (process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : process.platform), scratch);
  const memory = new Map<string, Analysis>();
  const busy = new Map<string, Promise<Analysis>>();
  const cacheDir = () => { const d = join(scratch(), "listen"); mkdirSync(d, { recursive: true }); return d; };

  function keyOf(path: string): string {
    const st = statSync(path);
    return createHash("sha1").update(`${path}|${st.size}|${Math.round(st.mtimeMs)}|v${CACHE_VERSION}`).digest("hex").slice(0, 24);
  }
  function remember(key: string, a: Analysis): Analysis {
    memory.delete(key);
    memory.set(key, a);
    while (memory.size > 24) memory.delete(memory.keys().next().value!);
    try {
      const file = join(cacheDir(), key + ".json");
      writeFileSync(file + ".tmp", JSON.stringify({ ...a, env: packEnv(a.env), ...(a.envL && a.envR ? { envL: packEnv(a.envL), envR: packEnv(a.envR) } : {}) }));
      renameSync(file + ".tmp", file);
    } catch { /* the cache is only a shortcut */ }
    return a;
  }
  function recall(key: string): Analysis | null {
    const m = memory.get(key);
    if (m) return m;
    try {
      const j = JSON.parse(readFileSync(join(cacheDir(), key + ".json"), "utf8"));
      if (j.v !== CACHE_VERSION) return null;
      const a: Analysis = { ...j, env: unpackEnv(j.env), ...(j.envL ? { envL: unpackEnv(j.envL), envR: unpackEnv(j.envR) } : {}) };
      memory.set(key, a);
      return a;
    } catch {
      return null;
    }
  }

  async function analyze(path: string): Promise<Analysis> {
    if (isPlainPcm(path)) {
      try { return await analyzePcm(path); } catch { /* a WAV this reader can't take: try a decoder */ }
    }
    const wav = join(scratch(), `listen-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.wav`);
    const why: string[] = [];
    try {
      for (const d of decoders) {
        const r = await d.decode(path, wav, { rate: RATE, timeoutMs: o.timeoutMs ?? 15 * 60 * 1000 });
        if (r.ok) return await analyzePcm(wav);
        if (r.error && r.error !== "no ffmpeg") why.push(r.error);
        try { unlinkSync(wav); } catch { /* none */ }
      }
    } finally {
      try { unlinkSync(wav); } catch { /* none */ }
    }
    throw new Error(`Couldn't read the sound of ${basename(path)}${why.length ? `: ${why[0]!.replace(/[.\s]+$/, "")}` : ""}. It may have no sound track, or be in a format this computer can't play.`);
  }

  return {
    async hear(path: string) {
      if (!existsSync(path)) throw new Error(`There's no file at ${path}.`);
      if (statSync(path).isDirectory()) throw new Error(`${path} is a folder, not a media file.`);
      const key = keyOf(path);
      const known = recall(key);
      if (known) return known;
      const running = busy.get(key);
      if (running) return running;
      const p = analyze(path).then((a) => remember(key, a)).finally(() => busy.delete(key));
      busy.set(key, p);
      return p;
    },
  };
}

/** For tests and tools: write mono or stereo samples (-1 to 1) as a 16-bit WAV. */
export function writeWav(path: string, channels: Float32Array[], rate: number): void {
  const C = channels.length, n = channels[0]!.length;
  const b = Buffer.alloc(44 + n * C * 2);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + n * C * 2, 4); b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii"); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(C, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * C * 2, 28); b.writeUInt16LE(C * 2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii"); b.writeUInt32LE(n * C * 2, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < C; c++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(channels[c]![i]! * 32767))), 44 + (i * C + c) * 2);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, b);
}
