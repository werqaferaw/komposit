// Premiere Pro's own transcripts, read from the saved project file. Ported from 1.0's
// companion/transcript.mjs (checked on a project saved by Premiere Pro 2026: 332 words whose
// times matched the audio).
//
// When a clip is transcribed in Premiere (Text panel > Transcribe, or Settings > Transcription
// > transcribe automatically), the words are kept in the .prproj: a gzip of XML in which each
// transcribed clip has an ExternallyProvidedTranscriptDocument whose TranscriptData is a
// base64 FlatBuffer. Premiere's scripts can't reach any of it, so it is read here. The layout
// (other versions may differ: anything that doesn't fit is skipped, never guessed):
//
//   root.f0            the document
//     doc.f0           [segment]   a stretch by one speaker
//     doc.f1           language ("en-us")
//     doc.f2           [speaker]   { f0 name, f1 id (two 64-bit halves) }
//   segment
//     f0, f1           start and length, in ticks (254016000000 a second) of the SOURCE file
//     f2               the speaker's id
//     f3               [word]
//   word
//     f0, f1           start and length, in ticks
//     f2               text ("guys.")
//     f3               confidence, 0 to 1
//     f6               3 for something that isn't a word (a pause); absent for words
//
// Times are the media's own (0 at its first frame), like a clip's in point.
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { gunzipSync } from "node:zlib";

const TICKS = 254016000000;

/** [start, end, text, confidence] in seconds of the source. */
export type SourceWord = [number, number, string, number];

export interface Transcript {
  language: string;
  speakers: string[];
  segments: { start: number; end: number; speaker: number; words: SourceWord[] }[];
}

export interface ClipTranscript {
  /** The clip's name in the project. */
  name: string;
  /** Its media file, when it can be worked out. */
  path: string | null;
  transcript: Transcript;
}

/** A word on a timeline (or in a file): [start, end, text, speaker]. */
export type Word = [number, number, string, number];

export interface Words {
  words: Word[];
  speakers: string[];
  paragraphs: { start: number; end: number; speaker: number; text: string }[];
}

type Field = (i: number) => number;

function table(buf: Buffer, pos: number): Field {
  if (pos < 4 || pos + 4 > buf.length) throw new Error("bad table");
  const vt = pos - buf.readInt32LE(pos);
  if (vt < 0 || vt + 4 > buf.length) throw new Error("bad vtable");
  const vlen = buf.readUInt16LE(vt);
  return (i) => {
    const o = 4 + 2 * i;
    if (o + 2 > vlen) return 0;
    const x = buf.readUInt16LE(vt + o);
    return x ? pos + x : 0;
  };
}
const follow = (buf: Buffer, p: number) => p + buf.readUInt32LE(p);
function string(buf: Buffer, p: number): string {
  if (!p) return "";
  const s = follow(buf, p), n = buf.readUInt32LE(s);
  if (s + 4 + n > buf.length) throw new Error("bad string");
  return buf.toString("utf8", s + 4, s + 4 + n);
}
function vector(buf: Buffer, p: number): number[] {
  if (!p) return [];
  const v = follow(buf, p), n = buf.readUInt32LE(v);
  if (n > 2_000_000 || v + 4 + n * 4 > buf.length) throw new Error("bad vector");
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = follow(buf, v + 4 + i * 4);
  return out;
}
const seconds = (buf: Buffer, p: number) => (p ? Number(buf.readBigInt64LE(p)) / TICKS : 0);
function id(buf: Buffer, p: number): string {
  if (!p) return "";
  const t = table(buf, follow(buf, p));
  const a = t(0), b = t(1);
  return (a ? buf.readBigUInt64LE(a).toString(16) : "0") + "-" + (b ? buf.readBigUInt64LE(b).toString(16) : "0");
}
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** TranscriptData bytes -> the transcript, in seconds of the source. Throws when the bytes
 *  aren't one. */
export function parseTranscriptData(buf: Buffer): Transcript {
  const root = table(buf, buf.readUInt32LE(0));
  const doc = table(buf, follow(buf, root(0)));
  const speakerIds: string[] = [], speakers: string[] = [];
  for (const sp of vector(buf, doc(2))) {
    const t = table(buf, sp);
    speakers.push(string(buf, t(0)) || `Speaker ${speakers.length + 1}`);
    speakerIds.push(id(buf, t(1)));
  }
  const segments: Transcript["segments"] = [];
  for (const sp of vector(buf, doc(0))) {
    const s = table(buf, sp);
    const start = seconds(buf, s(0)), length = seconds(buf, s(1));
    let speaker = speakerIds.indexOf(id(buf, s(2)));
    if (speaker < 0) { speakerIds.push(id(buf, s(2))); speakers.push(`Speaker ${speakers.length + 1}`); speaker = speakers.length - 1; }
    const words: SourceWord[] = [];
    for (const wp of vector(buf, s(3))) {
      const w = table(buf, wp);
      if (w(6) && buf.readUInt32LE(w(6)) !== 0) continue; // a pause, not a word
      const text = string(buf, w(2)).trim();
      if (!text) continue;
      const at = seconds(buf, w(0));
      words.push([r3(at), r3(at + seconds(buf, w(1))), text, w(3) ? Math.round(buf.readFloatLE(w(3)) * 100) / 100 : 1]);
    }
    if (words.length) segments.push({ start: r3(start), end: r3(start + length), speaker, words });
  }
  return { language: string(buf, doc(1)), speakers, segments };
}

const unxml = (s: string) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Every transcribed clip in a saved project. */
export function readPremiereTranscripts(prproj: string): ClipTranscript[] {
  let x: string;
  try {
    x = gunzipSync(readFileSync(prproj), { maxOutputLength: 768 * 1024 * 1024 }).toString("utf8");
  } catch {
    return [];
  }
  if (!x.includes("<TranscriptData")) return [];
  const objs = new Map<string, { tag: string; start: number; end: number }>();
  const re = /<([A-Za-z.]+) Object(?:ID|UID)="([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(x))) {
    const end = x.indexOf(`</${m[1]}>`, m.index);
    objs.set(m[2]!, { tag: m[1]!, start: m.index, end: end === -1 ? m.index + m[0].length : end });
  }
  const body = (o: { start: number; end: number } | undefined) => (o ? x.slice(o.start, o.end) : "");
  const ref = (text: string, tag: string) => text.match(new RegExp(`<${tag} Object(?:U)?Ref="([^"]+)"`))?.[1] || null;
  const mediaPath = (clipId: string) => {
    const src = objs.get(ref(body(objs.get(clipId)), "Source") || "");
    const media = objs.get(ref(body(src), "Media") || "");
    const t = body(media);
    const p = t.match(/<ActualMediaFilePath>([^<]+)</)?.[1] || t.match(/<FilePath>([^<]+)</)?.[1];
    return p && /[\\/]/.test(p) ? unxml(p) : null;
  };
  const out: ClipTranscript[] = [], seen = new Set<string>();
  for (const [, o] of objs) {
    if (o.tag !== "MasterClip") continue;
    const t = body(o);
    const clipIds = [...t.matchAll(/<Clip Index="\d+" ObjectRef="([^"]+)"\/>/g)].map((a) => a[1]!);
    const tc = clipIds.find((c) => objs.get(c)?.tag === "TranscriptClip");
    if (!tc) continue;
    const docId = ref(body(objs.get(tc)), "TranscriptTextSegments");
    if (!docId || seen.has(docId)) continue;
    const data = body(objs.get(docId)).match(/<TranscriptData Encoding="base64"[^>]*>([^<]+)</)?.[1];
    if (!data) continue;
    seen.add(docId);
    let transcript: Transcript;
    try {
      transcript = parseTranscriptData(Buffer.from(data, "base64"));
    } catch {
      continue;
    }
    if (!transcript.segments.length) continue;
    let path: string | null = null;
    for (const c of clipIds) { if (c === tc) continue; path = mediaPath(c); if (path) break; }
    const names = [...t.matchAll(/<Name>([^<]*)<\/Name>/g)].map((a) => a[1]!);
    out.push({ name: unxml(names[names.length - 1] || (path ? basename(path) : "clip")), path, transcript });
  }
  return out;
}

/** The same, remembered until the project file changes. */
export function createTranscriptReader(): (prproj: string) => ClipTranscript[] {
  let key = "", value: ClipTranscript[] = [];
  return (prproj) => {
    let k: string;
    try {
      const st = statSync(prproj);
      k = `${prproj}|${st.size}|${Math.round(st.mtimeMs)}`;
    } catch {
      return [];
    }
    if (k !== key) { key = k; value = readPremiereTranscripts(prproj); }
    return value;
  };
}

/** The words that fall on a timeline, in timeline seconds, in order. A source used on several
 *  tracks (a camera's picture and its sound) counts once. */
export function wordsOnTimeline(clips: { path?: string | null; name: string; start: number; end: number; srcIn: number; srcOut?: number }[], transcripts: ClipTranscript[]): Words {
  const byPath = new Map<string, ClipTranscript>(), byName = new Map<string, ClipTranscript>();
  for (const t of transcripts) { if (t.path) byPath.set(t.path, t); byName.set(t.name, t); }
  const speakers: { name: string; file: string }[] = [], speakerKey = new Map<string, number>();
  const label = (t: ClipTranscript, i: number) => {
    const k = `${t.path || t.name}|${i}`;
    if (!speakerKey.has(k)) { speakerKey.set(k, speakers.length); speakers.push({ name: t.transcript.speakers[i] || `Speaker ${i + 1}`, file: t.name }); }
    return speakerKey.get(k)!;
  };
  const used: [string, number, number][] = [];
  const words: Word[] = [], paragraphs: Words["paragraphs"] = [];
  for (const c of [...clips].sort((a, b) => a.start - b.start)) {
    const t = (c.path && byPath.get(c.path)) || byName.get(c.name) || (c.path && byName.get(basename(c.path)));
    if (!t) continue;
    const key = t.path || t.name, len = c.end - c.start, src = (c.srcOut ?? c.srcIn + len) - c.srcIn, rate = len > 0 && src > 0 ? src / len : 1;
    if (used.some((u) => u[0] === key && Math.abs(u[1] - c.srcIn) < 0.05 && Math.abs(u[2] - c.start) < 0.05)) continue;
    used.push([key, c.srcIn, c.start]);
    const srcOut = c.srcIn + src;
    for (const seg of t.transcript.segments) {
      if (seg.end <= c.srcIn || seg.start >= srcOut) continue;
      const sp = label(t, seg.speaker), mine: Word[] = [];
      for (const w of seg.words) {
        const mid = (w[0] + w[1]) / 2;
        if (mid < c.srcIn || mid >= srcOut) continue;
        const a = c.start + (w[0] - c.srcIn) / rate, b = c.start + (w[1] - c.srcIn) / rate;
        mine.push([r3(Math.max(c.start, a)), r3(Math.min(c.end, b)), w[2], sp]);
      }
      if (!mine.length) continue;
      words.push(...mine);
      paragraphs.push({ start: mine[0]![0], end: mine[mine.length - 1]![1], speaker: sp, text: mine.map((w) => w[2]).join(" ") });
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  paragraphs.sort((a, b) => a.start - b.start);
  const multi = new Set(speakers.map((s) => s.file)).size > 1;
  return { words, paragraphs, speakers: speakers.map((s) => (multi ? `${s.name} (${s.file})` : s.name)) };
}

/** One media file's transcript, as words in the file's own seconds, or null. */
export function wordsOfFile(path: string, transcripts: ClipTranscript[]): Words | null {
  const t = transcripts.find((x) => x.path === path) || transcripts.find((x) => x.name === basename(path));
  if (!t) return null;
  const words: Word[] = [], paragraphs: Words["paragraphs"] = [];
  for (const seg of t.transcript.segments) {
    for (const w of seg.words) words.push([w[0], w[1], w[2], seg.speaker]);
    paragraphs.push({ start: seg.words[0]![0], end: seg.words[seg.words.length - 1]![1], speaker: seg.speaker, text: seg.words.map((w) => w[2]).join(" ") });
  }
  return { words, paragraphs, speakers: t.transcript.speakers };
}
