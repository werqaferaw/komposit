// Listening, as the AI gets it: one media file, or a whole timeline (Premiere Pro's sequence,
// After Effects' composition), heard and said in plain numbers, with a picture of the sound
// and the same facts as data for the edits that follow (K.heard). Ported from 1.0's
// listen.mjs (listenFile, listenTimeline, the waveform), with v2's music: the tracked beats,
// bars, sections and hits, laid on the timeline through each clip.
import { basename } from "node:path";
import type { Picture } from "../../protocol/connector.ts";
import type { Analysis, Ear } from "./audio.ts";
import { BEAT_SURE, FLOOR_DB, HOP, gaps, levels, r2, r3, soundRanges, whoIsTalking } from "./hearing.ts";
import type { Hit, Levels, Music, Section, Shape } from "./hearing.ts";
import { encodePng } from "./png.ts";
import type { Word, Words } from "./transcripts.ts";

type Range = [number, number];

export interface ListenOptions {
  /** Listen from this second (default: the start). */
  from?: number;
  /** Up to this second (default: the end). */
  to?: number;
  /** The shortest pause worth listing, seconds (default 0.6). */
  pauses?: number;
}

export interface TimelineClip {
  name: string;
  /** The media file (none: nested, or not a file). */
  path?: string | null;
  /** Where it sits on the timeline, seconds. */
  start: number;
  end: number;
  /** Its in and out point in the source, seconds. */
  srcIn: number;
  srcOut?: number;
  disabled?: boolean;
  /** A nested sequence or comp, time-remapped or reversed: not followed. */
  nested?: boolean;
}

export interface TimelineTrack {
  index: number;
  /** How the AI names it: "A1" (Premiere Pro), "L3" (After Effects' layer 3). */
  label?: string;
  name: string;
  muted?: boolean;
  clips: TimelineClip[];
}

export interface TimelineLayout {
  name: string;
  /** Premiere Pro's sequence id, so an edit can tell it heard this one. */
  id?: string;
  duration: number;
  what: "sequence" | "composition";
  /** How a label maps to an edit ("A1 is audio track 0 in an edit."). */
  ref: string;
  /** What to say when nobody's words are known (null: say nothing). */
  wordsHint?: string | null;
  audio: TimelineTrack[];
  video?: { index: number; name: string; clips: number; first?: string[] }[];
}

export interface HeardBeats {
  /** The track (or After Effects layer) the music is on; absent for a file. */
  track?: number;
  bpm: number;
  interval: number;
  first: number;
  /** Every beat. */
  times: number[];
  /** The first beat of each bar. */
  bars: number[];
  meter: number | null;
  /** How sure the bar lines are, 0 to 1. */
  barsSure: number;
}

/** What a listen heard, as the edits get it (K.heard). Every time is in seconds of what was
 *  heard: the file's own, or the timeline's as it was then. */
export interface Heard {
  what: "file" | "sequence" | "composition";
  name: string;
  /** The file's path, or Premiere Pro's sequence id. */
  path?: string;
  id?: string;
  duration: number;
  from: number;
  to: number;
  tracks: { track: number; label: string; name: string; kind: "voice" | "music" | "effect" | "silent"; sound: Range[]; pauses?: Range[] }[];
  turns?: [number, number, number][];
  overlaps?: Range[];
  nobody?: Range[];
  beats?: HeardBeats;
  sections?: Section[];
  hits?: Hit[];
  shape?: Shape;
  words?: Word[];
  speakers?: string[];
}

export interface Listened {
  text: string;
  picture: Picture;
  heard: Heard;
}

// ---------- saying it ----------

export const fmtRanges = (list: Range[], max = 60) =>
  list.length ? list.slice(0, max).map((r) => `${r[0]}–${r[1]}`).join(", ") + (list.length > max ? `, and ${list.length - max} more` : "") : "none";

const fmtList = (xs: number[], max: number, what: string) =>
  xs.slice(0, max).join(", ") + (xs.length > max ? ` … ${xs.length - max} more (K.heard.${what}; listen with from/to to read them)` : "");

/** "about 87 BPM (or 174 counted double)": a beat can be felt at twice or half the speed. */
export function sayTempo(bpm: number): string {
  return `about ${bpm} BPM${bpm < 100 ? ` (or ${Math.round(bpm * 2)} counted double)` : bpm > 150 ? ` (or ${Math.round(bpm / 2)} counted in half time)` : ""}`;
}

/** One source's levels in a sentence. */
export function describeLevels(a: Pick<Analysis, "lufs" | "peakDb" | "clipped">, env: Float32Array): string {
  const lv = levels(env);
  if (lv.silent) return "silent";
  const bits: string[] = [];
  if (a.lufs != null) bits.push(`loudness ${a.lufs} LUFS`);
  bits.push(`peak ${a.peakDb} dB${a.clipped > 20 ? " (clipping)" : ""}`);
  bits.push(`quiet floor ${Math.round(lv.floor)} dB`);
  return bits.join(", ");
}

function sayShape(s: Shape): string {
  if (s.kind === "hit") return `a hit at ${s.peak} s (it lands at once and rings for ${s.tail} s)`;
  if (s.kind === "riser") return `a riser that lands at ${s.peak} s (it builds for ${s.build} s from ${s.start} s, then ${s.tail < 0.2 ? "stops" : `rings for ${s.tail} s`})`;
  if (s.kind === "swell") return `a swell that peaks at ${s.peak} s (${s.build} s up from ${s.start} s, ${s.tail} s down)`;
  return "one steady sound, no clear peak";
}

/** The music's lines: tempo and beats, bars, sections, hits. */
function sayMusic(m: { beats?: HeardBeats; sections: Section[]; hits: Hit[] }, where: string): string[] {
  const lines: string[] = [];
  const b = m.beats;
  if (b && b.times.length) {
    lines.push(`  Steady beat: ${sayTempo(b.bpm)}, a beat every ${b.interval} s; ${b.times.length} beats from ${b.times[0]} to ${b.times[b.times.length - 1]} s${where} (each one's time is in K.heard.beats.times; they follow the music's own hits, so they can drift a little from an even grid).`);
    if (b.bars.length) {
      lines.push(`  Bars of ${b.meter}, ${r2(b.interval * (b.meter || 4))} s each${b.barsSure < 0.5 ? " (which beat starts the bar is a guess here: check it by ear, or ask)" : ""}; a bar starts at: ${fmtList(b.bars, 96, "beats.bars")}.`);
    }
  } else lines.push(`  No steady beat to count (soft or free-flowing music has none): cut on the sections and hits below, or on markers the user sets.`);
  if (m.sections.length) lines.push(`  Sections (where the sound changes${b?.bars.length ? ", on bar lines" : ""}): ${m.sections.map((s) => `${s.start}–${s.end} ${s.level}${s.kind ? ` (${s.kind})` : ""}`).join(" · ")}.`);
  if (m.hits.length) lines.push(`  Strongest hits: ${m.hits.map((h) => `${h.t}${h.bar ? " (bar)" : h.beat ? " (beat)" : ""}`).join(", ")}.`);
  return lines;
}

// ---------- the picture ----------

const FONT: Record<string, string> = {
  0: "111101101101111", 1: "010110010010111", 2: "111001111100111", 3: "111001111001111", 4: "101101111001001",
  5: "111100111001111", 6: "111100111101111", 7: "111001010010010", 8: "111101111101111", 9: "111101111001111",
  A: "010101111101101", V: "101101101101010", L: "100100100100111", R: "110101110101101", s: "000011100011110", ":": "000010000010000", ".": "000000000000010", " ": "000000000000000",
};
const PALETTE = [[122, 162, 247], [158, 206, 106], [224, 175, 104], [247, 118, 142], [187, 154, 247], [125, 207, 255], [255, 158, 100], [115, 218, 202]];

interface Row {
  label: string;
  env: Float32Array;
  /** Times of the row's own envelope start at `from`. */
  sound: Range[];
  lv?: Levels;
  beats?: number[];
  bars?: number[];
  sections?: Section[];
}

/** One row per track (bright where its own sound is; for music, the beats as short ticks and
 *  the bars as tall ones in a band above it, and the sections as a strip under it, brighter
 *  where louder), seconds along the bottom, and under the rows a strip coloured by who's
 *  talking. A row's env and sound start at `from`; its beats, bars and sections are absolute. */
export function waveformPng(rows: Row[], { from = 0, to, turns = null, width = 1400 }: { from?: number; to: number; turns?: [number, number, number][] | null; width?: number }): Picture {
  const total = Math.max(0.01, to - from);
  const gutter = 34, waveH = 64, tickH = 10, gap = 10, axisH = 22, stripH = turns ? 14 : 0;
  const rowH = waveH + tickH;
  const W = width, H = Math.max(1, rows.length) * (rowH + gap) + stripH + (stripH ? gap : 0) + axisH + 6;
  const px = new Uint8Array(W * H * 3).fill(22);
  const set = (x: number, y: number, c: number[]) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 3; px[o] = c[0]!; px[o + 1] = c[1]!; px[o + 2] = c[2]!; };
  const text = (str: string, x: number, y: number, c: number[], scale = 2) => {
    for (const chr of String(str)) {
      const g = FONT[chr] || FONT[" "]!;
      for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) if (g[r * 3 + q] === "1") for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) set(x + q * scale + dx, y + r * scale + dy, c);
      x += 4 * scale;
    }
  };
  const plotW = W - gutter - 6;
  const xOf = (t: number) => gutter + Math.round(((t - from) / total) * plotW);
  rows.forEach((row, k) => {
    const band = k * (rowH + gap) + 3, top = band + tickH, mid = top + waveH / 2, col = PALETTE[k % PALETTE.length]!, dim = col.map((v) => Math.round(v * 0.35));
    for (let x = gutter; x < gutter + plotW; x++) for (let y = top; y < top + waveH; y++) set(x, y, [30, 31, 36]);
    text(row.label, 4, Math.round(mid) - 5, col);
    const lv = row.lv || levels(row.env), ref = lv.silent ? -20 : Math.max(lv.loud + 4, -50);
    let si = 0;
    for (let x = 0; x < plotW; x++) {
      const t0 = (x / plotW) * total, t1 = ((x + 1) / plotW) * total;
      let m = FLOOR_DB;
      for (let i = Math.floor(t0 / HOP); i <= Math.min(row.env.length - 1, Math.floor(t1 / HOP)); i++) if (i >= 0 && row.env[i]! > m) m = row.env[i]!;
      const amp = Math.max(0, Math.min(1, 1 - (ref - m) / (row.beats?.length ? 30 : 45))); // from the top to nothing: 45 dB (music: 30, so its loud and quiet show)
      const hgt = Math.round(amp * (waveH / 2 - 4));
      while (si < row.sound.length && row.sound[si]![1] < t0) si++;
      const on = si < row.sound.length && row.sound[si]![0] <= t1;
      for (let y = -hgt; y <= hgt; y++) set(gutter + x, Math.round(mid) + y, on ? col : dim);
    }
    for (const s of row.sections || []) {
      const shade = s.level === "loud" ? col : s.level === "medium" ? col.map((v) => Math.round(v * 0.6)) : col.map((v) => Math.round(v * 0.28));
      for (let x = Math.max(gutter, xOf(s.start) + 1); x < Math.min(gutter + plotW, xOf(s.end) - 1); x++) for (let dy = 0; dy < 4; dy++) set(x, top + waveH + 2 + dy, shade);
    }
    for (const t of row.beats || []) if (t >= from && t <= to) { const x = xOf(t); for (let dy = 5; dy < tickH - 1; dy++) set(x, band + dy, [120, 122, 130]); }
    for (const t of row.bars || []) if (t >= from && t <= to) { const x = xOf(t); for (let dy = 0; dy < tickH - 1; dy++) set(x, band + dy, [255, 255, 255]); }
  });
  let y = Math.max(1, rows.length) * (rowH + gap);
  if (turns) {
    for (const [a, b, k] of turns) for (let x = Math.max(gutter, xOf(a)); x < Math.min(gutter + plotW, xOf(b)); x++) for (let dy = 0; dy < stripH; dy++) set(x, y + dy, PALETTE[k % PALETTE.length]!);
    y += stripH + gap;
  }
  const nice = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  const stepS = nice.find((s) => total / s <= 14) || 3600;
  const fmt = (t: number) => (stepS >= 60 || to >= 600 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}` : String(Math.round(t * 10) / 10));
  for (let t = Math.ceil(from / stepS) * stepS; t <= to + 1e-6; t += stepS) {
    const x = xOf(t);
    for (let yy = 0; yy < y; yy++) if (yy % 4 === 0) set(x, yy, [70, 72, 80]);
    for (let dy = 0; dy < 5; dy++) set(x, y + dy, [150, 152, 160]);
    text(fmt(t), Math.min(W - 40, x + 3), y + 6, [150, 152, 160]);
  }
  return { bytes: encodePng(px, W, H), mime: "image/png", width: W, height: H };
}

// ---------- helpers ----------

const slice = (env: Float32Array, from: number, to: number) => env.subarray(Math.max(0, Math.round(from / HOP)), Math.min(env.length, Math.round(to / HOP)));
const shift = (ranges: Range[], by: number): Range[] => ranges.map((r): Range => [r2(r[0] + by), r2(r[1] + by)]);
const within = (xs: number[], a: number, b: number) => xs.filter((t) => t >= a - 1e-9 && t <= b + 1e-9);
const sure = (m: Music) => !!m.tempo && m.tempo.confidence >= BEAT_SURE && m.beats.length > 0;

/** A source's music laid on the timeline through one clip: where it sits, its in point and its
 *  speed (a clip played at half speed has half the tempo). */
export function musicOnTimeline(m: Music, clip: Pick<TimelineClip, "start" | "end" | "srcIn" | "srcOut">): { beats: number[]; bars: number[]; sections: Section[]; hits: Hit[]; bpm: number | null; interval: number | null } {
  const len = clip.end - clip.start, src = (clip.srcOut ?? clip.srcIn + len) - clip.srcIn, rate = len > 0 && src > 0 ? src / len : 1;
  const a = clip.srcIn, b = clip.srcIn + src;
  const map = (t: number) => r3(clip.start + (t - clip.srcIn) / rate);
  const sections = m.sections
    .filter((s) => s.end > a && s.start < b)
    .map((s) => ({ ...s, start: r2(clip.start + (Math.max(a, s.start) - a) / rate), end: r2(clip.start + (Math.min(b, s.end) - a) / rate) }));
  return {
    beats: within(m.beats, a, b).map(map),
    bars: within(m.bars, a, b).map(map),
    sections,
    hits: m.hits.filter((h) => h.t >= a && h.t <= b).map((h) => ({ ...h, t: r2(map(h.t)) })),
    bpm: m.tempo ? Math.round(m.tempo.bpm * rate * 10) / 10 : null,
    interval: m.tempo ? Math.round((m.tempo.interval / rate) * 10000) / 10000 : null,
  };
}

/** One track's envelope on the timeline: each clip's source envelope laid where the clip sits. */
export function trackEnvelope(clips: (TimelineClip & { env: Float32Array })[], total: number): Float32Array {
  const n = Math.ceil(total / HOP);
  const out = new Float32Array(n).fill(FLOOR_DB);
  for (const c of clips) {
    const len = c.end - c.start, src = (c.srcOut ?? c.srcIn + len) - c.srcIn;
    const rate = len > 0 && src > 0 ? src / len : 1;
    const a = Math.max(0, Math.round(c.start / HOP)), b = Math.min(n, Math.round(c.end / HOP));
    for (let i = a; i < b; i++) {
      const j = Math.round((c.srcIn + (i * HOP - c.start) * rate) / HOP);
      if (j >= 0 && j < c.env.length) out[i] = c.env[j]!;
    }
  }
  return out;
}

function wordLines(words: Words, from: number, end: number, intro: string): string[] {
  const inRange = words.paragraphs.filter((p) => p.end > from && p.start < end);
  const many = words.speakers.length > 1;
  let count = 0;
  const out: string[] = [];
  for (const p of inRange) {
    const n = p.text.split(/\s+/).length;
    if (count + n > 1500) { out.push(`… the transcript goes on (${inRange.length - out.length} more passages); listen with from/to for the rest.`); break; }
    count += n;
    out.push(`[${p.start}–${p.end}${many ? ` ${words.speakers[p.speaker]}` : ""}] ${p.text}`);
  }
  return [`${intro}\n${out.join("\n")}`];
}

// ---------- one file ----------

/** Listen to one media file. Times are the file's own seconds. `words`: the file's transcript,
 *  when there is one. */
export async function listenFile(ear: Ear, path: string, o: ListenOptions & { words?: Words | null; wordsNote?: string } = {}): Promise<Listened> {
  const a = await ear.hear(path);
  const pauseMin = Number(o.pauses) > 0 ? Number(o.pauses) : 0.6;
  const end = Math.min(a.duration, o.to == null ? a.duration : Number(o.to));
  const from = Math.max(0, Math.min(Number(o.from) || 0, end));
  if (end - from < 0.05) throw new Error(`Nothing to listen to between ${r2(from)} and ${r2(end)} s (the file is ${r2(a.duration)} s long).`);
  const name = basename(path);
  const m = a.music;
  const music = sure(m) || (levels(a.env).steady && a.duration > 15);
  const parts: [string, Float32Array][] = a.envL && a.envR ? [["L", a.envL], ["R", a.envR]] : [["A", a.env]];
  const rows = parts.map(([label, env]) => {
    const e = slice(env, from, end), lv = levels(env);
    const sound: Range[] = lv.silent ? [] : lv.steady || music ? [[0, r2(e.length * HOP)]] : soundRanges(e, { threshold: lv.threshold });
    return { label, env: e, lv, sound };
  });
  const who = rows.length > 1 && !music ? whoIsTalking(rows.map((r) => ({ env: r.env, lv: r.lv }))) : null;
  if (who) rows.forEach((r, k) => { if (!r.lv.silent && !r.lv.steady) r.sound = who.own[k]!; });
  const short = a.duration <= 15 && m.shape;
  const effect = !music && !!short && (m.shape!.kind === "hit" || m.shape!.kind === "riser") && rows[0]!.sound.length <= 3;
  const kind: Heard["tracks"][number]["kind"] = rows.every((r) => r.lv.silent) ? "silent" : music ? "music" : effect ? "effect" : "voice";
  const lines = [`Sound of ${name}: ${r2(a.duration)} s, ${a.channels === 1 ? "mono" : a.channels === 2 ? "stereo" : a.channels + " channels"}. ${describeLevels(a, a.env)}.${from > 0 || end < a.duration ? ` Listening to ${r2(from)}–${r2(end)} s.` : ""} Times are seconds in the file: to use them on a timeline, add where the file starts there and take away its in point.`];
  if (a.envL) lines.push("Left and right carry different sound (two mics on one file?), so they are listed apart.");
  const heard: Heard = { what: "file", name, path, duration: r2(a.duration), from: r2(from), to: r2(end), tracks: [] };
  if (kind === "music") {
    lines.push(`Music${m.tempo && sure(m) ? "" : " (or one unbroken sound)"}:`);
    const beats: HeardBeats | undefined = sure(m) ? { bpm: m.tempo!.bpm, interval: m.tempo!.interval, first: m.tempo!.first, times: within(m.beats, from, end), bars: within(m.bars, from, end), meter: m.meter, barsSure: m.barSure } : undefined;
    const sections = m.sections.filter((s) => s.end > from && s.start < end);
    const hits = m.hits.filter((h) => h.t >= from && h.t <= end);
    lines.push(...sayMusic({ ...(beats ? { beats } : {}), sections, hits }, " in the file"));
    if (beats) heard.beats = beats;
    heard.sections = sections;
    heard.hits = hits;
  } else if (kind === "effect") {
    lines.push(`A short sound effect: ${sayShape(m.shape!)}. To land it on a cut or a beat, line its peak up with it: start it ${m.shape!.peak} s before.`);
    heard.shape = m.shape!;
  }
  if (kind !== "music" && kind !== "silent") {
    for (const r of rows) {
      const total = r.env.length * HOP, said = r.sound.reduce((s, x) => s + x[1] - x[0], 0), head = rows.length > 1 ? `${r.label}: ` : "";
      if (r.lv.silent) { lines.push(`${head}silent.`); continue; }
      if (r.lv.steady) { lines.push(`${head}one unbroken sound, no pauses (a tone or constant noise).`); continue; }
      if (!r.sound.length) { lines.push(`${head}only short hits (percussion or clicks), no held sound.`); continue; }
      lines.push(`${head}sound ${Math.round((said / Math.max(0.01, total)) * 100)}% of the time, in ${r.sound.length} stretch${r.sound.length === 1 ? "" : "es"}: ${fmtRanges(shift(r.sound, from))}.`);
      lines.push(`  Pauses of ${pauseMin} s or more: ${fmtRanges(shift(gaps(r.sound, total, pauseMin), from))}.`);
    }
    if (short && kind === "voice") lines.push(`Its shape: ${sayShape(m.shape!)}.`);
  } else if (kind === "silent") lines.push("Silent.");
  if (who) lines.push(`Loudest side, held 0.8 s: ${who.turns.map((t) => `${r2(t[0] + from)}–${r2(t[1] + from)} ${rows[t[2]]!.label}`).slice(0, 80).join(" · ")}.`);
  rows.forEach((r, k) => heard.tracks.push({ track: k, label: r.label, name: r.label === "A" ? name : `${name} (${r.label === "L" ? "left" : "right"})`, kind, sound: shift(r.sound, from), ...(kind === "voice" ? { pauses: shift(gaps(r.sound, r.env.length * HOP, pauseMin), from) } : {}) }));
  if (who) heard.turns = who.turns.map((t): [number, number, number] => [r2(t[0] + from), r2(t[1] + from), t[2]]);
  if (o.words && o.words.words.length) {
    lines.push(...wordLines(o.words, from, end, `Words (Premiere Pro's transcript of this file; times are seconds in the file, so they are its in and out points; exact word times are in K.heard.words, and K.findWords("a phrase") finds them in an edit):`));
    heard.words = o.words.words.filter((w) => w[1] > from && w[0] < end);
    heard.speakers = o.words.speakers;
  } else if (o.wordsNote && kind === "voice") lines.push(o.wordsNote);
  const picture = waveformPng(
    rows.map((r) => ({ label: r.label, env: r.env, sound: shift(r.sound, 0), lv: r.lv, ...(heard.beats ? { beats: heard.beats.times, bars: heard.beats.bars } : {}), ...(heard.sections ? { sections: heard.sections } : {}) })),
    { from, to: end, turns: who ? who.turns.map((t): [number, number, number] => [t[0] + from, t[1] + from, t[2]]) : null },
  );
  return { text: lines.join("\n"), picture, heard };
}

// ---------- a whole timeline ----------

/** Listen to a sequence or a composition: every audio track as laid out (each clip's sound
 *  where it sits, at its speed), before volume, mutes and effects. Times are timeline seconds. */
export async function listenTimeline(ear: Ear, layout: TimelineLayout, o: ListenOptions & { words?: Words | null } = {}): Promise<Listened> {
  const total = layout.duration;
  const pauseMin = Number(o.pauses) > 0 ? Number(o.pauses) : 0.6;
  const end = Math.min(total, o.to == null ? total : Number(o.to));
  const from = Math.max(0, Math.min(Number(o.from) || 0, end));
  const what = layout.what;
  if (end - from < 0.05) throw new Error(`Nothing to listen to between ${r2(from)} and ${r2(end)} s (the ${what} is ${r2(total)} s long).`);
  // Every source file once.
  const files = new Map<string, Analysis>(), problems: string[] = [];
  for (const t of layout.audio) for (const c of t.clips) {
    if (!c.path || c.disabled || c.nested || files.has(c.path)) continue;
    try { files.set(c.path, await ear.hear(c.path)); } catch (e) { problems.push((e as Error).message); }
  }
  type T = { index: number; label: string; name: string; muted: boolean; env: Float32Array; lv: Levels; kind: "voice" | "music" | "silent"; a: Analysis | null; sources: string[]; nested: boolean; sound: Range[]; music?: ReturnType<typeof musicOnTimeline> & { track: number } };
  const tracks: T[] = [];
  for (const t of layout.audio) {
    const clips = t.clips.filter((c) => !c.disabled);
    if (!clips.length) continue;
    const heardClips = clips.filter((c) => c.path && files.get(c.path)).map((c) => ({ ...c, env: files.get(c.path!)!.env, a: files.get(c.path!)! }));
    const whole = trackEnvelope(heardClips, total);
    const env = slice(whole, from, end);
    const lv = levels(whole);
    const main = heardClips.slice().sort((x, y) => y.end - y.start - (x.end - x.start))[0];
    const beatClips = heardClips.filter((c) => sure(c.a.music));
    const kind: T["kind"] = !heardClips.length || lv.silent ? "silent" : lv.steady || beatClips.length ? "music" : "voice";
    const sources = [...new Set(clips.map((c) => (c.path ? basename(c.path) : c.name)))];
    const rec: T = { index: t.index, label: t.label || `A${t.index + 1}`, name: t.name, muted: !!t.muted, env, lv, kind, a: main?.a ?? null, sources, nested: clips.some((c) => c.nested), sound: kind === "voice" ? soundRanges(env, { threshold: lv.threshold }) : kind === "music" ? [[0, r2(env.length * HOP)]] : [] };
    if (kind === "music") {
      // Each clip's beats, bars, sections and hits, where that clip plays them.
      const parts = heardClips.sort((x, y) => x.start - y.start).map((c) => musicOnTimeline(c.a.music, c));
      const best = beatClips.length ? musicOnTimeline(beatClips.sort((x, y) => y.end - y.start - (x.end - x.start))[0]!.a.music, beatClips[0]!) : null;
      rec.music = {
        track: t.index,
        beats: within(parts.flatMap((p) => p.beats), from, end),
        bars: within(parts.flatMap((p) => p.bars), from, end),
        sections: parts.flatMap((p) => p.sections).filter((s) => s.end > from && s.start < end),
        hits: parts.flatMap((p) => p.hits).filter((h) => h.t >= from && h.t <= end),
        bpm: best?.bpm ?? null,
        interval: best?.interval ?? null,
      };
    }
    tracks.push(rec);
  }
  const voices = tracks.filter((t) => t.kind === "voice");
  let who: ReturnType<typeof whoIsTalking> | null = null;
  if (voices.length > 1) {
    who = whoIsTalking(voices.map((t) => ({ env: t.env, lv: t.lv })));
    voices.forEach((t, k) => { t.sound = who!.own[k]!; });
  }
  const span = end - from;
  const nobody = who ? who.nobody : voices.length === 1 ? gaps(voices[0]!.sound, span, 1) : [];
  const lines = [`Sound of the ${what} "${layout.name}" (${r2(total)} s), as recorded: before volume, mutes and effects.${from > 0 || end < total ? ` Listening to ${r2(from)}–${r2(end)} s.` : ""} Times are seconds in the ${what}, as it is now: after you move, trim or remove things, listen again. ${layout.ref}`];
  const heard: Heard = { what, name: layout.name, ...(layout.id ? { id: layout.id } : {}), duration: r2(total), from: r2(from), to: r2(end), tracks: [] };
  // The music the cuts follow: the track with the most beats (the longest when none has a beat).
  const lead = tracks.filter((t) => t.music).sort((x, y) => (y.music!.beats.length - x.music!.beats.length) || (y.sound.length - x.sound.length))[0];
  for (const t of tracks) {
    const head = `${t.label} "${t.name}"${t.muted ? " (muted)" : ""}, ${t.sources.slice(0, 3).join(", ")}${t.sources.length > 3 ? ` and ${t.sources.length - 3} more` : ""}`;
    if (t.kind === "silent") { lines.push(`${head}: ${t.nested ? `nested or retimed inside the ${what} (not listened to)` : "silent here"}.`); continue; }
    if (t.kind === "music") {
      lines.push(`${head}: music (or one unbroken sound). ${t.a ? describeLevels(t.a, t.env) : ""}.`);
      const mu = t.music!;
      const beats: HeardBeats | undefined = mu.beats.length && mu.bpm && mu.interval ? { track: t.index, bpm: mu.bpm, interval: mu.interval, first: mu.beats[0]!, times: mu.beats, bars: mu.bars, meter: t.a?.music.meter ?? null, barsSure: t.a?.music.barSure ?? 0 } : undefined;
      lines.push(...sayMusic({ ...(beats ? { beats } : {}), sections: mu.sections, hits: mu.hits }, ` in the ${what}`));
      if (t === lead) {
        if (beats) heard.beats = beats;
        heard.sections = mu.sections;
        heard.hits = mu.hits;
      }
      continue;
    }
    const said = t.sound.reduce((s, x) => s + x[1] - x[0], 0);
    lines.push(`${head}: a voice, talking ${Math.round((said / span) * 100)}% of the time. ${t.a ? describeLevels(t.a, t.env) : ""}.`);
    lines.push(`  Talks: ${fmtRanges(shift(t.sound, from), 50)}.`);
    if (voices.length === 1) lines.push(`  Pauses of ${pauseMin} s or more: ${fmtRanges(shift(gaps(t.sound, span, pauseMin), from), 50)}.`);
  }
  const turns = who ? who.turns.map((x): [number, number, number] => [r2(x[0] + from), r2(x[1] + from), voices[x[2]]!.index]) : [];
  const labelOf = new Map(tracks.map((t) => [t.index, t.label]));
  if (who) {
    lines.push(`Who is talking (each mic against its own level, held 0.8 s): ${turns.slice(0, 160).map((x) => `${x[0]}–${x[1]} ${labelOf.get(x[2])}`).join(" · ")}${turns.length > 160 ? ` … ${turns.length - 160} more turns (listen with from/to for the rest)` : ""}.`);
    lines.push(`Talking over each other (1 s or more): ${fmtRanges(shift(who.overlaps, from), 40)}.`);
  }
  if (voices.length) lines.push(`Nobody talking (1 s or more): ${fmtRanges(shift(nobody, from), 60)}.`);
  if (layout.video?.length) lines.push(`Video tracks: ${layout.video.filter((v) => v.clips).map((v) => `V${v.index + 1} "${v.name}" ${v.clips} clip${v.clips === 1 ? "" : "s"}${v.first?.length ? ` (${v.first.join(", ")}${v.clips > v.first.length ? ", …" : ""})` : ""}`).join(" · ") || "none with clips"}.`);
  for (const p of problems.slice(0, 4)) lines.push(`Not listened to: ${p}`);
  if (o.words && o.words.words.length) {
    lines.push(...wordLines(o.words, from, end, `Words (Premiere Pro's transcript; exact word times are in K.heard.words, and K.findWords("a phrase") finds them in an edit):`));
    heard.words = o.words.words.filter((w) => w[1] > from && w[0] < end);
    heard.speakers = o.words.speakers;
  } else if (voices.length && layout.wordsHint !== null) {
    lines.push(layout.wordsHint || `No words yet: these clips aren't transcribed in Premiere Pro. To read what is said, the user transcribes them in Premiere Pro (Window > Text > Transcribe) and saves the project; then listen again.`);
  }
  heard.tracks = tracks.map((t) => ({ track: t.index, label: t.label, name: t.name, kind: t.kind, sound: shift(t.sound, from), ...(t.kind === "voice" ? { pauses: shift(gaps(t.sound, span, pauseMin), from) } : {}) }));
  if (who) { heard.turns = turns; heard.overlaps = shift(who.overlaps, from); }
  if (voices.length) heard.nobody = shift(nobody, from);
  const shown = tracks.filter((t) => t.kind !== "silent").slice(0, 8);
  const picture = waveformPng(
    shown.map((t) => ({ label: t.label, env: t.env, sound: t.sound, lv: t.lv, ...(t.music ? { beats: t.music.beats, bars: t.music.bars, sections: t.music.sections } : {}) })),
    { from, to: end, turns: who ? who.turns.map((x): [number, number, number] => [x[0] + from, x[1] + from, shown.indexOf(voices[x[2]]!)]) : null },
  );
  return { text: lines.join("\n"), picture, heard };
}

// ---------- what the edits get ----------

/** The last thing an app heard, for its next edits (K.heard). One per connector: the newest
 *  listen wins, as in 1.0; the helpers check it's of the sequence (or comp) they work in. */
export function createHeardShelf(maxAgeMs = 24 * 3600 * 1000) {
  let kept: { heard: Heard; at: number } | null = null;
  return {
    set(heard: Heard) { kept = { heard, at: Date.now() }; },
    get(): Heard | null { return kept && Date.now() - kept.at <= maxAgeMs ? kept.heard : null; },
  };
}

/** `K.heard = {...};` for the front of an edit (one line, no newline), or "" when nothing was
 *  heard or it's too big to send (over 3 MB: a very long talk's words). */
export function heardAssignment(heard: Heard | null, target = "K.heard"): string {
  if (!heard) return "";
  const json = JSON.stringify(heard).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  if (json.length > 3 * 1024 * 1024) return "";
  return ` ${target} = ${json};`;
}

/** For an app without a timeline (Illustrator, Photoshop): a file only, by its path. */
export async function listenToFileOnly(ear: Ear, label: string, o: ListenOptions & { path?: string }): Promise<Listened> {
  if (!o.path) throw new Error(`${label} has no timeline to listen to: pass path, a media file to listen to (a song, a voice-over, footage, a sound effect).`);
  return listenFile(ear, o.path, o);
}
