// Listening, held to sounds with known answers (soundfixtures.ts): a beat at a known tempo
// gives that tempo, every beat within 30 ms, and its bars; loud and quiet stretches come back
// as sections on the bar lines; speech-like bursts come back as stretches with their pauses;
// sound effects come back with their hit point. Plus the readers (WAV, AIFF, Premiere's
// transcripts), the system decoder on a Mac, and what the edits get (K.heard).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIN_DECODE_PS1, analyzePcm, createEar, writeWav } from "./audio.ts";
import { BEAT_SURE, gaps, levels, soundRanges } from "./hearing.ts";
import { createHeardShelf, heardAssignment, listenFile, listenTimeline, musicOnTimeline } from "./listening.ts";
import type { TimelineLayout } from "./listening.ts";
import { addPad, drumTrack, effect, speechLike } from "./soundfixtures.ts";
import { parseTranscriptData, readPremiereTranscripts, wordsOfFile, wordsOnTimeline } from "./transcripts.ts";
import { projectWithTranscript, transcriptBytes } from "./transcriptfixture.ts";

const R = 16000;
const tmp = () => mkdtempSync(join(tmpdir(), "kp-listen-"));
const nearest = (xs: number[], t: number) => xs.reduce((p, x) => (Math.abs(x - t) < Math.abs(p - t) ? x : p), Infinity);

/** A song: the drum track with a pad, quiet for 8 bars, loud for 8, quiet for 8 (at 120 BPM,
 *  bars start at 0.25 + 2k, so the changes sit on bar lines at 16.25 and 32.25). */
function song(bpm = 120, seconds = 48) {
  const bar = (4 * 60) / bpm;
  const a = 0.25 + 8 * bar, b = 0.25 + 16 * bar;
  const g = (t: number) => (t < a ? 0.25 : t < b ? 1 : 0.25);
  const d = drumTrack({ bpm, seconds, gain: g });
  addPad(d.x, R, (t) => 0.15 * g(t));
  return { ...d, changes: [a, b] };
}

function writeAiff16(path: string, x: Float32Array, rate: number) {
  const n = x.length, b = Buffer.alloc(12 + 26 + 16 + n * 2);
  b.write("FORM", 0, "ascii"); b.writeUInt32BE(b.length - 8, 4); b.write("AIFF", 8, "ascii");
  b.write("COMM", 12, "ascii"); b.writeUInt32BE(18, 16); b.writeUInt16BE(1, 20); b.writeUInt32BE(n, 22); b.writeUInt16BE(16, 26);
  // The rate as an 80-bit extended float.
  const e = Math.floor(Math.log2(rate)), m = rate / 2 ** e;
  b.writeUInt16BE(16383 + e, 28); b.writeUInt32BE(Math.floor(m * 2 ** 31), 30); b.writeUInt32BE(0, 34);
  b.write("SSND", 38, "ascii"); b.writeUInt32BE(8 + n * 2, 42); b.writeUInt32BE(0, 46); b.writeUInt32BE(0, 50);
  for (let i = 0; i < n; i++) b.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32767))), 54 + i * 2);
  writeFileSync(path, b);
}

function writeWavFloat(path: string, x: Float32Array, rate: number) {
  const n = x.length, b = Buffer.alloc(44 + n * 4);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + n * 4, 4); b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii"); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34);
  b.write("data", 36, "ascii"); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) b.writeFloatLE(x[i]!, 44 + i * 4);
  writeFileSync(path, b);
}

test("WAV (16-bit, float) and AIFF are read as they are, and measure the same", async () => {
  const dir = tmp();
  try {
    const { x } = song(120, 20);
    writeWav(join(dir, "a.wav"), [x], R);
    writeWavFloat(join(dir, "b.wav"), x, R);
    writeAiff16(join(dir, "c.aif"), x, R);
    const [a, b, c] = await Promise.all(["a.wav", "b.wav", "c.aif"].map((f) => analyzePcm(join(dir, f))));
    for (const z of [b, c]) {
      assert.ok(Math.abs(z.duration - a.duration) < 0.01);
      assert.ok(Math.abs((z.lufs ?? 0) - (a.lufs ?? 0)) < 0.3, `${z.lufs} vs ${a.lufs}`);
      assert.equal(z.music.tempo?.bpm, a.music.tempo?.bpm);
    }
    assert.equal(Math.round(a.duration), 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const bpm of [120, 90, 128]) {
  test(`a beat at ${bpm} BPM: the tempo, every beat within 30 ms, bars of 4 on the kick`, async () => {
    const dir = tmp();
    try {
      const d = song(bpm, 40);
      writeWav(join(dir, "s.wav"), [d.x], R);
      const m = (await analyzePcm(join(dir, "s.wav"))).music;
      assert.ok(m.tempo && Math.abs(m.tempo.bpm - bpm) <= 0.5, JSON.stringify(m.tempo));
      assert.ok(m.tempo!.confidence >= BEAT_SURE);
      assert.ok(Math.abs(m.beats.length - d.beats.length) <= 1, `${m.beats.length} beats heard, ${d.beats.length} played`);
      for (const t of d.beats.slice(1, -1)) assert.ok(Math.abs(nearest(m.beats, t) - t) <= 0.03, `the beat at ${t} s was heard at ${nearest(m.beats, t)} s`);
      assert.equal(m.meter, 4);
      for (const t of d.bars.slice(1, -1)) assert.ok(Math.abs(nearest(m.bars, t) - t) <= 0.03, `the bar at ${t} s`);
      assert.ok(m.barSure >= 0.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a live band: the tempo drifting from 116 to 124 BPM, each hit up to 15 ms off, is still followed", async () => {
  const dir = tmp();
  try {
    const d = drumTrack({ bpm: 116, bpmEnd: 124, seconds: 50, jitter: 0.015 });
    // (A fixed grid at the average tempo is a quarter of a beat off at the ends of this one.)
    writeWav(join(dir, "live.wav"), [d.x], R);
    const m = (await analyzePcm(join(dir, "live.wav"))).music;
    assert.ok(m.tempo && m.tempo.bpm > 115 && m.tempo.bpm < 125, JSON.stringify(m.tempo));
    const off = d.beats.slice(1, -1).map((t) => Math.abs(nearest(m.beats, t) - t));
    assert.ok(Math.max(...off) <= 0.04, `worst beat ${Math.max(...off)} s off`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a waltz: bars of 3", async () => {
  const dir = tmp();
  try {
    const d = drumTrack({ bpm: 96, seconds: 36, meter: 3 });
    writeWav(join(dir, "w.wav"), [d.x], R);
    const m = (await analyzePcm(join(dir, "w.wav"))).music;
    assert.equal(m.meter, 3);
    for (const t of d.bars.slice(1, -1)) assert.ok(Math.abs(nearest(m.bars, t) - t) <= 0.03);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sections: quiet, loud, quiet, cut on the bar lines where the sound changes; the hits sit on the bars", async () => {
  const dir = tmp();
  try {
    const d = song(120, 48);
    writeWav(join(dir, "s.wav"), [d.x], R);
    const m = (await analyzePcm(join(dir, "s.wav"))).music;
    assert.equal(m.sections.length, 3, JSON.stringify(m.sections));
    assert.ok(Math.abs(m.sections[1]!.start - d.changes[0]!) <= 0.05, JSON.stringify(m.sections));
    assert.ok(Math.abs(m.sections[2]!.start - d.changes[1]!) <= 0.05);
    assert.deepEqual(m.sections.map((s) => s.level), ["quiet", "loud", "quiet"]);
    assert.equal(m.sections[1]!.kind, "drop");
    assert.equal(m.sections[2]!.kind, "outro");
    assert.ok(m.hits.length >= 8);
    assert.ok(m.hits.filter((h) => h.beat).length >= m.hits.length * 0.9, "the strongest hits are the beats");
    assert.ok(m.hits.filter((h) => h.bar).length >= m.hits.length * 0.6, "and mostly the kicks on the bars");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("speech: its stretches and the pauses between, and no beat", async () => {
  const dir = tmp();
  try {
    const said: [number, number][] = [[0.5, 3.2], [4.4, 7.9], [9.5, 12]];
    writeWav(join(dir, "talk.wav"), [speechLike(said, { seconds: 14 })], R);
    const a = await analyzePcm(join(dir, "talk.wav"));
    assert.ok(!a.music.tempo || a.music.tempo.confidence < BEAT_SURE, JSON.stringify(a.music.tempo));
    assert.deepEqual(a.music.beats, []);
    const lv = levels(a.env);
    const heard = soundRanges(a.env, { threshold: lv.threshold });
    assert.equal(heard.length, 3, JSON.stringify(heard));
    heard.forEach((r, i) => {
      assert.ok(Math.abs(r[0] - said[i]![0]) <= 0.15, `starts ${r[0]} vs ${said[i]![0]}`);
      assert.ok(Math.abs(r[1] - said[i]![1]) <= 0.15, `ends ${r[1]} vs ${said[i]![1]}`);
    });
    const p = gaps(heard, a.duration, 0.6);
    assert.equal(p.length, 3, JSON.stringify(p)); // two between, and the end (half a second at the start is too short to list)
    assert.ok(Math.abs(p[0]![0] - 3.2) <= 0.15 && Math.abs(p[0]![1] - 4.4) <= 0.15);
    assert.ok(Math.abs(p[1]![0] - 7.9) <= 0.15 && Math.abs(p[1]![1] - 9.5) <= 0.15);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two mics on one stereo file: left and right apart, and who talks when", async () => {
  const dir = tmp();
  try {
    const host = speechLike([[0.5, 4], [9, 12.5]], { seconds: 14, seed: 4 });
    const guest = speechLike([[4.8, 8.4]], { seconds: 14, seed: 9, pitch: 210 });
    // Each mic hears the other person too, 20 dB down.
    const L = host.map((v, i) => v + 0.1 * guest[i]!), Rr = guest.map((v, i) => v + 0.1 * host[i]!);
    writeWav(join(dir, "both.wav"), [L, Rr], R);
    const ear = createEar({ scratchDir: () => dir, decoders: [] });
    const r = await listenFile(ear, join(dir, "both.wav"));
    assert.match(r.text, /Left and right carry different sound/);
    const turns = r.heard.turns!;
    const at = (t: number) => turns.find((x) => x[0] <= t && t < x[1])?.[2];
    assert.equal(at(2), 0, JSON.stringify(turns));
    assert.equal(at(6.5), 1);
    assert.equal(at(11), 0);
    assert.equal(r.heard.tracks.length, 2);
    assert.equal(r.heard.tracks[1]!.sound.length, 1, "the guest's own sound, not the bleed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sound effects: where a hit lands and where a riser lands", async () => {
  const dir = tmp();
  try {
    writeWav(join(dir, "hit.wav"), [effect("hit", { at: 0.6, seconds: 3 })], R);
    writeWav(join(dir, "riser.wav"), [effect("riser", { at: 2.4, seconds: 3 })], R);
    const ear = createEar({ scratchDir: () => dir, decoders: [] });
    const hit = await listenFile(ear, join(dir, "hit.wav"));
    assert.equal(hit.heard.shape?.kind, "hit");
    assert.ok(Math.abs(hit.heard.shape!.peak - 0.6) <= 0.04, JSON.stringify(hit.heard.shape));
    assert.match(hit.text, /A short sound effect: a hit at 0\.6\d? s/);
    const riser = await listenFile(ear, join(dir, "riser.wav"));
    assert.equal(riser.heard.shape?.kind, "riser", JSON.stringify(riser.heard.shape));
    assert.ok(Math.abs(riser.heard.shape!.peak - 2.4) <= 0.06);
    assert.match(riser.text, /a riser that lands at 2\.(3|4)\d* s/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listen to a song file: what the AI reads, the picture, and K.heard", async () => {
  const dir = tmp();
  try {
    const d = song(120, 48);
    writeWav(join(dir, "song.wav"), [d.x], R);
    const ear = createEar({ scratchDir: () => dir, decoders: [] });
    const r = await listenFile(ear, join(dir, "song.wav"));
    assert.match(r.text, /^Sound of song\.wav: 48 s, mono\. loudness -\d+(\.\d)? LUFS/);
    assert.match(r.text, /Steady beat: about 120(\.\d)? BPM, a beat every 0\.(5|4998) s; 9\d beats from 0\.2\d to 47\.\d+ s in the file/);
    assert.match(r.text, /Bars of 4, 2 s each; a bar starts at: 0\.2\d, 2\.2\d, 4\.2\d/);
    assert.match(r.text, /Sections \(where the sound changes, on bar lines\): 0–16\.2\d quiet · 16\.2\d–32\.2\d loud \(drop\) · 32\.2\d–48 quiet \(outro\)/);
    assert.match(r.text, /Strongest hits: /);
    assert.equal(r.heard.what, "file");
    assert.equal(r.heard.beats!.times.length, r.heard.beats!.times.filter((t) => t >= 0 && t <= 48).length);
    assert.equal(r.heard.tracks[0]!.kind, "music");
    assert.equal(r.picture.mime, "image/png");
    assert.equal(Buffer.from(r.picture.bytes).subarray(1, 4).toString("ascii"), "PNG");
    // A part of it: times stay the file's own.
    const part = await listenFile(ear, join(dir, "song.wav"), { from: 20, to: 30 });
    assert.ok(part.heard.beats!.times[0]! >= 20 && part.heard.beats!.times[part.heard.beats!.times.length - 1]! <= 30);
    assert.match(part.text, /Listening to 20–30 s\./);
    await assert.rejects(listenFile(ear, join(dir, "song.wav"), { from: 60 }), /Nothing to listen to between 48 and 48 s \(the file is 48 s long\)\./);
    // Remembered: the second time is read from the cache in the scratch folder.
    assert.ok(readdirSync(join(dir, "listen")).some((f) => f.endsWith(".json")));
    const again = createEar({ scratchDir: () => dir, decoders: [] });
    assert.equal((await again.hear(join(dir, "song.wav"))).music.beats.length, (await ear.hear(join(dir, "song.wav"))).music.beats.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a timeline: a voice and a song placed at 5 s from 2.25 s into it; beats in timeline seconds; a sped-up clip has a faster beat", async () => {
  const dir = tmp();
  try {
    const d = song(120, 48);
    writeWav(join(dir, "song.wav"), [d.x], R);
    writeWav(join(dir, "talk.wav"), [speechLike([[0.5, 3.2], [4.4, 7.9]], { seconds: 10 })], R);
    const ear = createEar({ scratchDir: () => dir, decoders: [] });
    const layout: TimelineLayout = {
      name: "Edit", id: "seq-1", duration: 40, what: "sequence", ref: "A1 is audio track 0 in an edit.",
      audio: [
        { index: 0, name: "Audio 1", clips: [{ name: "talk.wav", path: join(dir, "talk.wav"), start: 0, end: 10, srcIn: 0, srcOut: 10 }] },
        { index: 1, name: "Music", clips: [{ name: "song.wav", path: join(dir, "song.wav"), start: 5, end: 40, srcIn: 2.25, srcOut: 37.25 }] },
        { index: 2, name: "Audio 3", clips: [{ name: "gone.wav", path: join(dir, "gone.wav"), start: 0, end: 3, srcIn: 0, srcOut: 3 }] },
      ],
      video: [{ index: 0, name: "Video 1", clips: 3, first: ["a.mp4", "b.mp4", "c.mp4"] }],
    };
    const r = await listenTimeline(ear, layout);
    assert.equal(r.heard.what, "sequence");
    assert.equal(r.heard.id, "seq-1");
    assert.deepEqual(r.heard.tracks.map((t) => [t.label, t.kind]), [["A1", "voice"], ["A2", "music"], ["A3", "silent"]]);
    const b = r.heard.beats!;
    assert.equal(b.track, 1);
    // Source beats at 0.25 + 0.5k; the clip starts at 2.25 in the source and 5 on the timeline.
    assert.ok(Math.abs(b.times[0]! - 5) <= 0.03, `first beat on the timeline ${b.times[0]}`);
    assert.ok(Math.abs(nearest(b.bars, 5) - 5) <= 0.03, "2.25 s into the song is a bar line, so 5 s is too");
    assert.ok(b.times.every((t) => t >= 5 && t <= 40));
    assert.ok(Math.abs(nearest(r.heard.sections!.map((s) => s.start), 5 + 16.25 - 2.25) - 19) <= 0.05, JSON.stringify(r.heard.sections));
    assert.match(r.text, /A2 "Music", song\.wav: music/);
    assert.match(r.text, /A1 "Audio 1", talk\.wav: a voice, talking \d+% of the time/);
    assert.match(r.text, /Pauses of 0\.6 s or more: /);
    assert.match(r.text, /Not listened to: There's no file at .*gone\.wav\./);
    assert.match(r.text, /No words yet: these clips aren't transcribed in Premiere Pro/);
    assert.match(r.text, /Video tracks: V1 "Video 1" 3 clips \(a\.mp4, b\.mp4, c\.mp4\)/);
    // Twice as fast (35 s of source in 17.5 s): twice the tempo, beats every 0.25 s.
    const fast = musicOnTimeline((await ear.hear(join(dir, "song.wav"))).music, { start: 0, end: 17.5, srcIn: 0.25, srcOut: 35.25 });
    assert.equal(fast.bpm !== null && Math.round(fast.bpm), 240);
    assert.ok(Math.abs(fast.beats[1]! - fast.beats[0]! - 0.25) <= 0.02);
    // Listening closer: from/to.
    const close = await listenTimeline(ear, layout, { from: 10, to: 20 });
    assert.ok(close.heard.beats!.times.every((t) => t >= 10 && t <= 20));
    assert.match(close.text, /Listening to 10–20 s\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file with no sound that can be read says so plainly; the decoders are tried in order", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "song.mp3"), "not audio at all");
    const tried: string[] = [];
    const ear = createEar({
      scratchDir: () => dir,
      decoders: [
        { name: "a", decode: async () => { tried.push("a"); return { ok: false, error: "format not supported." }; } },
        { name: "b", decode: async () => { tried.push("b"); return { ok: false, error: "no ffmpeg" }; } },
      ],
    });
    await assert.rejects(ear.hear(join(dir, "song.mp3")), /^Error: Couldn't read the sound of song\.mp3: format not supported\. It may have no sound track, or be in a format this computer can't play\.$/);
    assert.deepEqual(tried, ["a", "b"]);
    await assert.rejects(ear.hear(join(dir, "missing.wav")), /There's no file at/);
    // A decoder that writes a WAV is used.
    const d = song(120, 12);
    const ear2 = createEar({ scratchDir: () => dir, decoders: [{ name: "w", decode: async (_s, dst) => { writeWav(dst, [d.x], R); return { ok: true }; } }] });
    assert.equal(Math.round((await ear2.hear(join(dir, "song.mp3"))).duration), 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Mac: an AAC file (and a movie's sound) decoded by the system's own afconvert", { skip: process.platform !== "darwin" }, async () => {
  const dir = tmp();
  try {
    const d = song(120, 30);
    writeWav(join(dir, "song.wav"), [d.x], R);
    execFileSync("afconvert", ["-f", "m4af", "-d", "aac", join(dir, "song.wav"), join(dir, "song.m4a")]);
    const ear = createEar({ scratchDir: () => dir, platform: "mac" });
    const a = await ear.hear(join(dir, "song.m4a"));
    assert.ok(Math.abs(a.duration - 30) < 0.2, String(a.duration));
    assert.ok(a.music.tempo && Math.abs(a.music.tempo.bpm - 120) <= 0.5);
    for (const t of d.beats.slice(2, -2)) assert.ok(Math.abs(nearest(a.music.beats, t) - t) <= 0.06, `beat ${t} heard at ${nearest(a.music.beats, t)} (AAC adds a little delay)`);
    assert.ok(!readdirSync(dir).some((f) => /^listen-.*\.wav$/.test(f)), "the decoded copy is gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows: the decoder is Windows' own Media Foundation through PowerShell", () => {
  assert.match(WIN_DECODE_PS1, /MediaTranscoder/);
  assert.match(WIN_DECODE_PS1, /CreateWav/);
  assert.match(WIN_DECODE_PS1, /\$prof\.Audio\.SampleRate = \$Rate/);
  assert.match(WIN_DECODE_PS1, /IAsyncOperation`1/);
  assert.doesNotMatch(WIN_DECODE_PS1, /\$profile\b/, "not PowerShell's own $PROFILE");
});

test("K.heard: one assignment on one line, line separators escaped, nothing when it's too big", () => {
  const shelf = createHeardShelf();
  assert.equal(heardAssignment(shelf.get()), "");
  shelf.set({ what: "file", name: "a\u2028b", duration: 1, from: 0, to: 1, tracks: [] });
  const s = heardAssignment(shelf.get());
  assert.ok(s.startsWith(" K.heard = {") && s.endsWith("};"));
  assert.ok(!s.includes("\n") && !s.includes("\u2028") && s.includes("\\u2028"));
  const huge = { what: "file" as const, name: "x", duration: 1, from: 0, to: 1, tracks: [], words: Array.from({ length: 200000 }, (_, i): [number, number, string, number] => [i, i + 1, "wordwordword", 0]) };
  assert.equal(heardAssignment(huge), "");
  const old = createHeardShelf(-1);
  old.set({ what: "file", name: "x", duration: 1, from: 0, to: 1, tracks: [] });
  assert.equal(old.get(), null, "a day old: forgotten");
});

// ---------- Premiere Pro's transcripts ----------

test("transcripts: the bytes: speakers, stretches, words with their times; pauses left out", () => {
  const t = parseTranscriptData(transcriptBytes());
  assert.equal(t.language, "en-us");
  assert.deepEqual(t.speakers, ["Host", "Speaker 2"]);
  assert.equal(t.segments.length, 2);
  assert.deepEqual(t.segments[0]!.words.map((w) => w[2]), ["What's", "up", "guys.", "Welcome"]);
  assert.deepEqual(t.segments[0]!.words[0]!.slice(0, 2), [0, 0.4], "a word at the very start has no stored start");
  assert.deepEqual(t.segments[0]!.words[2], [0.6, 1.1, "guys.", 0.9]);
  assert.deepEqual([t.segments[1]!.start, t.segments[1]!.end, t.segments[1]!.speaker], [4, 6.5, 1]);
  assert.throws(() => parseTranscriptData(Buffer.from("not a transcript at all")));
});

test("transcripts: words land on the timeline through each clip's in point; a source on two tracks counts once", () => {
  const transcript = parseTranscriptData(transcriptBytes());
  const list = [{ name: "talk.mp4", path: "/m/talk.mp4", transcript }];
  const clip = { name: "talk.mp4", path: "/m/talk.mp4", start: 10, end: 15, srcIn: 0.55, srcOut: 5.55 };
  const w = wordsOnTimeline([clip, { ...clip }, { name: "music.wav", path: "/m/music.wav", start: 0, end: 30, srcIn: 0, srcOut: 30 }], list);
  assert.deepEqual(w.speakers, ["Host", "Speaker 2"]);
  assert.deepEqual(w.words.map((x) => x[2]), ["guys.", "Welcome", "Thanks", "for", "having", "me."], "words before the in point are not on the timeline");
  assert.deepEqual(w.words[0], [10.05, 10.55, "guys.", 0]);
  assert.deepEqual(w.words[2]!.slice(0, 2), [13.45, 13.75]);
  assert.deepEqual(w.paragraphs.map((p) => [p.start, p.speaker, p.text]), [[10.05, 0, "guys. Welcome"], [13.45, 1, "Thanks for having me."]]);
  assert.deepEqual(wordsOnTimeline([{ name: "other.mp4", path: "/m/other.mp4", start: 0, end: 5, srcIn: 0, srcOut: 5 }], list).words, []);
});

test("transcripts: a saved project's transcribed clips, with their media files; one file's words", () => {
  const dir = tmp();
  try {
    const p = join(dir, "show.prproj");
    writeFileSync(p, projectWithTranscript("talk & walk.mp4", "/Volumes/Shoot/Footage/talk & walk.mp4"));
    const list = readPremiereTranscripts(p);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, "talk & walk.mp4");
    assert.equal(list[0]!.path, "/Volumes/Shoot/Footage/talk & walk.mp4");
    assert.equal(list[0]!.transcript.segments.length, 2);
    assert.deepEqual(readPremiereTranscripts(join(dir, "missing.prproj")), []);
    const w = wordsOfFile("/Volumes/Shoot/Footage/talk & walk.mp4", list)!;
    assert.equal(w.words.length, 8);
    assert.deepEqual(w.paragraphs.map((q) => [q.start, q.end, q.speaker]), [[0, 2.5, 0], [4, 5.2, 1]]);
    assert.equal(wordsOfFile("/elsewhere/talk & walk.mp4", list)!.words.length, 8, "found by name when the file has moved");
    assert.equal(wordsOfFile("/m/other.mp4", list), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a timeline with words: they're read out with their times and kept for the edits", async () => {
  const dir = tmp();
  try {
    writeWav(join(dir, "talk.wav"), [speechLike([[0, 2.6], [4, 6.6]], { seconds: 8 })], R);
    const transcript = parseTranscriptData(transcriptBytes());
    const words = wordsOnTimeline([{ name: "talk.wav", path: join(dir, "talk.wav"), start: 0, end: 8, srcIn: 0, srcOut: 8 }], [{ name: "talk.wav", path: join(dir, "talk.wav"), transcript }]);
    const ear = createEar({ scratchDir: () => dir, decoders: [] });
    const r = await listenTimeline(ear, { name: "Talk", duration: 8, what: "sequence", ref: "", audio: [{ index: 0, name: "A", clips: [{ name: "talk.wav", path: join(dir, "talk.wav"), start: 0, end: 8, srcIn: 0, srcOut: 8 }] }] }, { words });
    assert.match(r.text, /Words \(Premiere Pro's transcript;/);
    assert.match(r.text, /\[0–2\.5 Host\] What's up guys\. Welcome/);
    assert.match(r.text, /\[4–5\.2 Speaker 2\] Thanks for having me\./);
    assert.equal(r.heard.words!.length, 8);
    assert.deepEqual(r.heard.speakers, ["Host", "Speaker 2"]);
    assert.ok(existsSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
