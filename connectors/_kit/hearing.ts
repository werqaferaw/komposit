// Reading what a sound is doing, from the numbers audio.ts measures. Pure functions, no I/O.
//
//   speech    where there is sound and where the pauses are; across tracks, who is loudest
//             when (the speaker, on a podcast with a mic each), where people overlap, where
//             nobody talks (ported from 1.0's listen.mjs as it was)
//   music     the tempo (1.0's three-band autocorrelation), then, new in v2: the beats
//             themselves, tracked through the song so they follow its real hits (dynamic
//             programming, as in Ellis 2007, "Beat tracking by dynamic programming"); the
//             bars (which beat is the one, from where the bass lands); the sections (loud and
//             quiet stretches, builds, drops and breaks, cut on bar lines); and where the hits
//             land (the strongest attacks, and whether they sit on a beat)
//   shape     a short sound's form: where it hits, how long it builds, how long it rings
//             (for sound effects: a whoosh, a riser, an impact)

/** Seconds per envelope step. */
export const HOP = 0.02;
/** Seconds per band step: the beat's resolution. */
export const STEP = 0.01;
export const FLOOR_DB = -100;
/** How sure a tempo has to be before it's called a beat. Songs with a steady pulse measure
 *  0.5 and up, speech 0.1 or less (0.35 at worst for a short, even-paced voice). */
export const BEAT_SURE = 0.4;

export const r2 = (n: number) => Math.round(n * 100) / 100;
export const r3 = (n: number) => Math.round(n * 1000) / 1000;
type Range = [number, number];

// ---------- levels and speech ----------

export interface Levels {
  floor: number;
  loud: number;
  threshold: number;
  range: number;
  silent?: boolean;
  /** Hardly any difference between quiet and loud: one unbroken sound. */
  steady?: boolean;
}

function percentile(sorted: number[], p: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]! : FLOOR_DB;
}

/** The envelope's own scale: its quiet floor, its loud level, and the level above which there
 *  is "sound" (speech, music), a third of the way up. */
export function levels(env: Float32Array): Levels {
  const live: number[] = [];
  for (let i = 0; i < env.length; i++) if (env[i]! > -95) live.push(env[i]!);
  if (live.length < 5) return { floor: FLOOR_DB, loud: FLOOR_DB, threshold: 0, range: 0, silent: true };
  live.sort((a, b) => a - b);
  const loud = percentile(live, 0.95);
  if (loud < -65) return { floor: percentile(live, 0.1), loud, threshold: 0, range: 0, silent: true };
  // Mostly digital silence with sound here and there (a click track, a clean voice-over).
  if (live.length < env.length * 0.5) return { floor: -90, loud, threshold: Math.max(-60, loud - 30), range: loud + 90 };
  const floor = percentile(live, 0.1), range = loud - floor;
  if (range < 6) return { floor, loud, threshold: floor - 3, range, steady: true };
  // A third of the way up from the floor, and never more than 22 dB under the loud level
  // (which keeps a far-off voice in the same room from counting as this mic's own).
  return { floor, loud, threshold: Math.max(floor + Math.max(6, Math.min(18, range * 0.35)), loud - 22), range };
}

/** Stretches of sound in an envelope (seconds), short gaps bridged, blips dropped. */
export function soundRanges(env: Float32Array, { threshold, bridge = 0.35, minLength = 0.15, pad = 0.04 }: { threshold?: number; bridge?: number; minLength?: number; pad?: number } = {}): Range[] {
  if (threshold === undefined) {
    const l = levels(env);
    if (l.silent) return [];
    threshold = l.threshold;
  }
  const out: Range[] = [];
  let start = -1;
  for (let i = 0; i <= env.length; i++) {
    const on = i < env.length && env[i]! > threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { out.push([start * HOP, i * HOP]); start = -1; }
  }
  const merged: Range[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < bridge) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  const total = env.length * HOP;
  return merged.filter((r) => r[1] - r[0] >= minLength).map((r): Range => [r2(Math.max(0, r[0] - pad)), r2(Math.min(total, r[1] + pad))]);
}

/** The gaps between ranges (and at the ends) of at least `min` seconds. */
export function gaps(ranges: Range[], total: number, min = 0.6): Range[] {
  const out: Range[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r[0] - at >= min) out.push([r2(at), r2(r[0])]);
    at = Math.max(at, r[1]);
  }
  if (total - at >= min) out.push([r2(at), r2(total)]);
  return out;
}

export interface Talking {
  /** [start, end, track] (the track's index in the list given). */
  turns: [number, number, number][];
  overlaps: Range[];
  nobody: Range[];
  /** Each track's own sound (not the other mics' bleed). */
  own: Range[][];
}

/** Who is loudest when, across tracks' envelopes on one timeline: each track's level against
 *  its own loud level (so a quiet mic still wins when its person talks), a speaker held until
 *  someone else has clearly taken over for `hold` seconds. */
export function whoIsTalking(tracks: { env: Float32Array; lv?: Levels }[], { hold = 0.8, overlapMin = 1, nobodyMin = 1 } = {}): Talking {
  const n = Math.max(0, ...tracks.map((t) => t.env.length));
  const lv = tracks.map((t) => t.lv || levels(t.env));
  const step = 5; // 100 ms
  const steps = Math.ceil(n / step);
  const active = tracks.map(() => new Uint8Array(steps));
  const score = tracks.map(() => new Float32Array(steps));
  tracks.forEach((t, k) => {
    if (lv[k]!.silent) return;
    for (let s = 0; s < steps; s++) {
      let m = FLOOR_DB;
      for (let i = s * step; i < Math.min(t.env.length, (s + 1) * step); i++) if (t.env[i]! > m) m = t.env[i]!;
      score[k]![s] = m - lv[k]!.loud;
      active[k]![s] = m > lv[k]!.threshold ? 1 : 0;
    }
  });
  const win = 2;
  const smooth = score.map((sc, k) => {
    const o = new Float32Array(steps);
    for (let s = 0; s < steps; s++) {
      let m = -200;
      for (let j = Math.max(0, s - win); j <= Math.min(steps - 1, s + win); j++) if (active[k]![j] && sc[j]! > m) m = sc[j]!;
      o[s] = m;
    }
    return o;
  });
  const holdSteps = Math.max(1, Math.round(hold / 0.1));
  const lead = new Int16Array(steps).fill(-1);
  for (let s = 0; s < steps; s++) {
    let best = -1, bv = -150;
    for (let k = 0; k < tracks.length; k++) if (smooth[k]![s]! > bv) { bv = smooth[k]![s]!; best = k; }
    lead[s] = best;
  }
  const cur = new Int16Array(steps).fill(-1);
  let who = -1;
  for (let s = 0; s < steps; s++) {
    if (lead[s] !== who && lead[s] !== -1) {
      let run = 0;
      while (s + run < steps && lead[s + run] === lead[s]) run++;
      if (run >= holdSteps || who === -1) who = lead[s]!;
    }
    cur[s] = who;
  }
  const turns: [number, number, number][] = [];
  for (let s = 0; s < steps; s++) {
    if (cur[s]! < 0) continue;
    const last = turns[turns.length - 1];
    if (last && last[2] === cur[s] && Math.abs(last[1] - s * 0.1) < 1e-6) last[1] = (s + 1) * 0.1;
    else turns.push([s * 0.1, (s + 1) * 0.1, cur[s]!]);
  }
  // A turn starts where its speaker starts and runs until the next one starts; the first
  // reaches back to the start, so the turns cover the whole stretch.
  for (let i = 0; i < turns.length; i++) turns[i]![1] = i + 1 < turns.length ? turns[i + 1]![0] : n * HOP;
  if (turns.length) turns[0]![0] = 0;
  const merged: [number, number, number][] = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last[2] === t[2]) last[1] = t[1];
    else merged.push(t);
  }
  const ranges = (test: (s: number) => boolean, min: number): Range[] => {
    const o: Range[] = [];
    let st = -1;
    for (let s = 0; s <= steps; s++) {
      const on = s < steps && test(s);
      if (on && st < 0) st = s;
      if (!on && st >= 0) { if ((s - st) * 0.1 >= min) o.push([r2(st * 0.1), r2(s * 0.1)]); st = -1; }
    }
    return o;
  };
  const count = (s: number) => { let c = 0; for (let k = 0; k < tracks.length; k++) c += active[k]![s]!; return c; };
  // Two voices at once only counts when both are near their own loud level (not one mic hearing the other).
  const overlaps = ranges((s) => { let c = 0; for (let k = 0; k < tracks.length; k++) if (active[k]![s] && score[k]![s]! > -12) c++; return c >= 2; }, overlapMin);
  const nobody = ranges((s) => count(s) === 0, nobodyMin);
  const own = tracks.map((_, k) => {
    const raw = ranges((s) => {
      if (!active[k]![s]) return false;
      for (let j = 0; j < tracks.length; j++) if (j !== k && active[j]![s] && score[j]![s]! > score[k]![s]! + 8) return false;
      return true;
    }, 0.2);
    const out: Range[] = [];
    for (const r of raw) { const last = out[out.length - 1]; if (last && r[0] - last[1] < 0.4) last[1] = r[1]; else out.push([r[0], r[1]]); }
    return out;
  });
  return { turns: merged.map((t): [number, number, number] => [r2(t[0]), r2(t[1]), t[2]]), overlaps, nobody, own };
}

// ---------- the beat ----------

export interface Tempo {
  bpm: number;
  /** Seconds between beats. */
  interval: number;
  /** Where the grid's first beat sits, seconds. */
  first: number;
  /** 0 to 1; BEAT_SURE and up is a steady beat. */
  confidence: number;
}

const BAND_WEIGHT = [1, 0.5, 0.8];

/** How much each band's energy rises every 10 ms (weighted sum over the bands): the attacks.
 *  Each band is smoothed over 30 ms first, so one cycle of a bass note isn't taken for a hit,
 *  and a rise only counts past 1.5 dB. `only`: one band alone. */
export function onsets(bands: Float32Array[], from = 0, to = bands[0]!.length, only?: number): Float32Array {
  const n = Math.max(0, to - from), o = new Float32Array(n);
  bands.forEach((band, k) => {
    if (only !== undefined && k !== only) return;
    const w = only !== undefined ? 1 : BAND_WEIGHT[k] ?? 1;
    const e = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = from + i;
      e[i] = 10 * Math.log10(((band[j - 1] || band[j]!) + band[j]! + (band[j + 1] || band[j]!)) / 3 + 1e-10);
    }
    for (let i = 2; i < n; i++) {
      const d = e[i]! - e[i - 2]!;
      if (d > 1.5 && e[i]! > -75) o[i] = o[i]! + w * (d - 1.5);
    }
  });
  return o;
}

/** The tempo of one stretch of attacks: the lag (0.3 to 1 s) at which they repeat, counted
 *  with its doubles (a real beat also repeats every 2 and 4 beats). */
function tempoOf(o: Float32Array): { lag: number; strength: number; phase: number } | null {
  const n = o.length;
  let mean = 0, energy = 0, count = 0;
  for (let i = 0; i < n; i++) { mean += o[i]!; if (o[i]! > 0) count++; }
  if (count < 8) return null;
  mean /= n;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { x[i] = o[i]! - mean; energy += x[i]! * x[i]!; }
  if (energy < 1e-6) return null;
  const maxLag = Math.min(400, n - 1), r = new Float32Array(maxLag + 2);
  for (let lag = 1; lag <= maxLag; lag++) { let sum = 0; for (let i = 0; i + lag < n; i++) sum += x[i]! * x[i + lag]!; r[lag] = sum / energy; }
  const at = (lag: number) => { const i = Math.floor(lag), f = lag - i; return i + 1 <= maxLag ? r[i]! * (1 - f) + r[i + 1]! * f : 0; };
  let best = -Infinity, bestLag = 0;
  for (let lag = 30; lag <= 100; lag++) {
    const score = r[lag]! + 0.5 * at(lag * 2) + 0.25 * at(lag * 4);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(6000 / lag / 115) / 0.8, 2)); // a gentle pull to the middle tempos
    if (score * prior > best) { best = score * prior; bestLag = lag; }
  }
  if (!bestLag) return null;
  // Finer than one 10 ms step: the lag whose 4th and 8th repeats line up best.
  let fine = bestLag, fineScore = -Infinity;
  for (let d = -0.6; d <= 0.6001; d += 0.025) {
    const L = bestLag + d, sc = at(L) + at(L * 2) + at(L * 4) + (L * 8 <= maxLag ? at(L * 8) : 0);
    if (sc > fineScore) { fineScore = sc; fine = L; }
  }
  // Where the beats sit: the offset whose comb catches the most attacks.
  let phase = 0, caught = -Infinity;
  for (let p = 0; p < fine; p++) { let sum = 0; for (let t = p; t < n; t += fine) sum += o[Math.round(t)] || 0; if (sum > caught) { caught = sum; phase = p; } }
  return { lag: fine, strength: r[bestLag]! + 0.5 * at(bestLag * 2), phase };
}

/** The tempo of a sound from its three bands (10 ms steps): worked out on the whole (up to
 *  four minutes) and on each half; a steady beat gives the same answer in both. Speech and
 *  held tones give a weak or changing one. */
export function estimateTempo(bands: Float32Array[]): Tempo | null {
  const n = Math.min(bands[0]!.length, 24000);
  if (n < 800) return null;
  const all = tempoOf(onsets(bands, 0, n));
  if (!all || all.strength < 0.12) return null;
  const half = Math.floor(n / 2), a = tempoOf(onsets(bands, 0, half)), b = tempoOf(onsets(bands, half, n));
  // "The same" allows the neighbouring ways of counting one beat: half and double time, and the 3-against-2 of a swung or dotted rhythm.
  const same = (p: typeof a, q: typeof a) => { if (!p || !q) return false; const ratio = p.lag / q.lag; return [1, 2, 0.5, 4 / 3, 3 / 4, 3 / 2, 2 / 3].some((k) => Math.abs(ratio / k - 1) < 0.045); };
  const steady = same(a, all) && same(b, all);
  // Half a minute or less is little to go on: chance can look like a beat.
  const confidence = Math.max(0, Math.min(1, all.strength * (steady ? 1.6 : 0.5) * (n < 3000 ? 0.8 : 1)));
  const period = all.lag * STEP;
  return { bpm: Math.round((60 / period) * 10) / 10, first: Math.round(all.phase) / 100, interval: Math.round(period * 10000) / 10000, confidence: Math.round(confidence * 100) / 100 };
}

/** The beats themselves, following the music (frames of STEP): each beat is the strongest
 *  attack near one period after the one before, so a beat that drags or rushes, or a song
 *  that drifts, is still followed (Ellis 2007). `tightness` is how hard the pulse holds
 *  against the attacks: 400 keeps it steady through syncopation (librosa's 100 jumped to
 *  off-beats on a real song). Nothing before the music starts or after it ends. */
export function trackBeats(o: Float32Array, lag: number, tightness = 400): number[] {
  const n = o.length;
  if (!(lag > 1) || n < lag * 4) return [];
  let sq = 0;
  for (let i = 0; i < n; i++) sq += o[i]! * o[i]!;
  const sd = Math.sqrt(sq / n);
  if (!(sd > 0)) return [];
  // Each stretch against its own loudness (the attacks over the 4 s around them), so a quiet
  // intro's beat pulls as hard as the chorus's; never less than a tenth of the whole sound's.
  const W = 200, cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i]! + o[i]! * o[i]!;
  const norm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - W), b = Math.min(n, i + W);
    norm[i] = Math.max(Math.sqrt((cum[b]! - cum[a]!) / (b - a)), sd * 0.1);
  }
  // The local score: the attacks, smoothed a little (a gaussian a 32nd of a beat wide).
  const sig = Math.max(1, lag / 32), half = Math.ceil(sig * 3), g: number[] = [];
  for (let k = -half; k <= half; k++) g.push(Math.exp(-0.5 * (k / sig) ** 2));
  const loc = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -half; k <= half; k++) { const j = i + k; if (j >= 0 && j < n) s += (o[j]! / norm[j]!) * g[k + half]!; }
    loc[i] = s;
  }
  const lo = Math.max(1, Math.round(lag / 2)), hi = Math.round(lag * 2);
  const pen = new Float64Array(hi + 1);
  for (let d = lo; d <= hi; d++) pen[d] = tightness * Math.log(d / lag) ** 2;
  const C = new Float64Array(n), back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = -Infinity, bi = -1;
    for (let d = lo; d <= hi && t - d >= 0; d++) {
      const sc = C[t - d]! - pen[d]!;
      if (sc > best) { best = sc; bi = t - d; }
    }
    if (bi >= 0 && best > 0) { C[t] = loc[t]! + best; back[t] = bi; }
    else C[t] = loc[t]!;
  }
  let last = Math.max(0, n - hi);
  for (let t = last; t < n; t++) if (C[t]! > C[last]!) last = t;
  const path: number[] = [];
  for (let t = last; t >= 0; t = back[t]!) { path.push(t); if (back[t]! < 0) break; }
  path.reverse();
  // The path keeps a steady pulse; each beat then moves onto a clearly stronger attack within
  // 40 ms of it, so a cut lands on the sound itself.
  const beats = path.map((b) => {
    let best = b;
    for (let i = Math.max(0, b - 4); i <= Math.min(n - 1, b + 4); i++) if (loc[i]! > loc[best]!) best = i;
    return loc[best]! > loc[b]! * 1.2 ? best : b;
  });
  // Trim beats in silence at either end (before the music starts, after it stops).
  const strength = beats.map((b) => Math.max(loc[b - 1] ?? 0, loc[b]!, loc[b + 1] ?? 0));
  const sorted = [...strength].sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length / 2)] || 0;
  let a = 0, b = beats.length - 1;
  while (a <= b && strength[a]! < typical * 0.15) a++;
  while (b >= a && strength[b]! < typical * 0.15) b--;
  return beats.slice(a, b + 1);
}

/** Which beat is the one: bars of 4 (or 3), and where they start, from where the bass and the
 *  big attacks land. `sure` 0 to 1. */
export function barsOf(beatFrames: number[], low: Float32Array, all: Float32Array): { meter: number; phase: number; sure: number } | null {
  if (beatFrames.length < 8) return null;
  const peakNear = (x: Float32Array, f: number) => { let m = 0; for (let i = f - 3; i <= f + 3; i++) if (i >= 0 && i < x.length && x[i]! > m) m = x[i]!; return m; };
  const lowAcc = beatFrames.map((f) => peakNear(low, f)), allAcc = beatFrames.map((f) => peakNear(all, f));
  const norm = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length || 1; return xs.map((x) => x / m); };
  const nl = norm(lowAcc), na = norm(allAcc);
  const acc = nl.map((x, k) => x + 0.5 * na[k]!);
  const mean = acc.reduce((a, b) => a + b, 0) / acc.length;
  const sd = Math.sqrt(acc.reduce((a, b) => a + (b - mean) ** 2, 0) / acc.length) || 1;
  const score = (meter: number, phase: number) => {
    let on = 0, nOn = 0, off = 0, nOff = 0;
    acc.forEach((x, k) => { if (k % meter === phase) { on += x; nOn++; } else { off += x; nOff++; } });
    return nOn && nOff ? (on / nOn - off / nOff) / sd : 0;
  };
  const best = (meter: number) => { let p = 0, s = -Infinity; for (let ph = 0; ph < meter; ph++) { const v = score(meter, ph); if (v > s) { s = v; p = ph; } } return { phase: p, s }; };
  const four = best(4), three = best(3);
  const useThree = three.s > four.s * 1.25 + 0.2;
  const pick = useThree ? { meter: 3, ...three } : { meter: 4, ...four };
  return { meter: pick.meter, phase: pick.phase, sure: Math.round(Math.max(0, Math.min(1, pick.s / 1.5)) * 100) / 100 };
}

export interface Section {
  start: number;
  end: number;
  /** Its loudness, dB (power average of the level). */
  db: number;
  /** Against the loudest section: within 3 dB loud, within 9 medium, else quiet. */
  level: "quiet" | "medium" | "loud";
  /** build: rises through it; drop: comes in at least 6 dB louder than what was before;
   *  break: quieter than both neighbours; outro: the end, well under what came before. */
  kind?: "build" | "drop" | "break" | "outro";
}

const powerMean = (xs: ArrayLike<number>, a: number, b: number) => {
  let s = 0, n = 0;
  for (let i = Math.max(0, a); i < Math.min(xs.length, b); i++) { s += 10 ** (xs[i]! / 10); n++; }
  return n ? 10 * Math.log10(s / n + 1e-12) : FLOOR_DB;
};

/** Loud and quiet stretches, cut where the sound changes most, on bar lines when there are
 *  bars (`units`: the times sections may start at; else every 2 s). */
export function sectionsOf(env: Float32Array, units: number[], bands?: Float32Array[]): Section[] {
  const total = env.length * HOP;
  if (total < 6) return [];
  let cuts = units.filter((t) => t > 0 && t < total);
  if (cuts.length < 6) { cuts = []; for (let t = 2; t < total; t += 2) cuts.push(t); }
  const edges = [0, ...cuts, total];
  const U = edges.length - 1;
  const L: number[] = [], H: number[] = [];
  for (let u = 0; u < U; u++) {
    L.push(powerMean(env, Math.round(edges[u]! / HOP), Math.round(edges[u + 1]! / HOP)));
    if (bands) {
      const a = Math.round(edges[u]! / STEP), b = Math.round(edges[u + 1]! / STEP);
      let lo = 0, mid = 0, top = 0;
      for (let i = a; i < Math.min(b, bands[0]!.length); i++) { lo += bands[0]![i]!; mid += bands[1]![i]!; top += bands[2]![i]!; }
      H.push(top / (lo + mid + top + 1e-12));
    } else H.push(0);
  }
  const w = U >= 16 ? 2 : 1;
  const novelty = new Float64Array(U + 1);
  for (let u = 1; u < U; u++) {
    const left = L.slice(Math.max(0, u - w), u), right = L.slice(u, Math.min(U, u + w));
    const hl = H.slice(Math.max(0, u - w), u), hr = H.slice(u, Math.min(U, u + w));
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    novelty[u] = Math.abs(avg(left) - avg(right)) + 20 * Math.abs(avg(hl) - avg(hr));
  }
  const minGap = units.length >= 6 ? 4 : 3; // bars (or 2 s steps)
  const cand: number[] = [];
  for (let u = 1; u < U; u++) {
    if (novelty[u]! < 3) continue;
    let peak = true;
    for (let k = Math.max(1, u - 2); k <= Math.min(U - 1, u + 2); k++) if (k !== u && novelty[k]! > novelty[u]!) peak = false;
    if (peak) cand.push(u);
  }
  cand.sort((a, b) => novelty[b]! - novelty[a]!);
  const chosen: number[] = [];
  for (const u of cand) if (chosen.every((c) => Math.abs(c - u) >= minGap) && u >= 2 && U - u >= 2) chosen.push(u);
  chosen.sort((a, b) => a - b);
  const bounds = [0, ...chosen, U];
  const out: Section[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = edges[bounds[i]!]!, b = edges[bounds[i + 1]!]!;
    out.push({ start: r2(a), end: r2(b), db: Math.round(powerMean(env, Math.round(a / HOP), Math.round(b / HOP)) * 10) / 10, level: "quiet" });
  }
  const loudest = Math.max(...out.map((s) => s.db));
  out.forEach((s, i) => {
    s.level = s.db >= loudest - 3 ? "loud" : s.db >= loudest - 9 ? "medium" : "quiet";
    const prev = out[i - 1], next = out[i + 1];
    // Rising through it: its last quarter well above its first.
    const a = Math.round(s.start / HOP), b = Math.round(s.end / HOP), q = Math.max(1, Math.round((b - a) / 4));
    const rise = powerMean(env, b - q, b) - powerMean(env, a, a + q);
    if (prev && s.db - prev.db >= 6) s.kind = "drop";
    else if (rise >= 5) s.kind = "build";
    else if (prev && next && s.db <= prev.db - 5 && s.db <= next.db - 5) s.kind = "break";
    else if (!next && prev && (s.db <= prev.db - 6 || rise <= -10)) s.kind = "outro";
  });
  return out;
}

export interface Hit {
  /** Seconds. */
  t: number;
  /** 0 to 1 against the strongest attacks in the sound. */
  strength: number;
  /** It sits on a tracked beat (within 60 ms), or on a bar's first beat. */
  beat?: boolean;
  bar?: boolean;
}

/** The strongest attacks (up to `max`), in time order. */
export function hitsOf(o: Float32Array, beats: number[], bars: number[], max = 24): Hit[] {
  const n = o.length, peaks: { i: number; v: number }[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = o[i]!;
    if (v <= 0) continue;
    let top = true;
    for (let k = Math.max(0, i - 10); k <= Math.min(n - 1, i + 10); k++) if (o[k]! > v || (o[k] === v && k < i)) { top = false; break; }
    if (top) peaks.push({ i, v });
  }
  if (!peaks.length) return [];
  const vals = peaks.map((p) => p.v).sort((a, b) => a - b);
  const ref = vals[Math.floor(vals.length * 0.98)] || vals[vals.length - 1]!;
  const near = (t: number, list: number[]) => list.some((x) => Math.abs(x - t) <= 0.06);
  return peaks
    .filter((p) => p.v >= ref * 0.25)
    .sort((a, b) => b.v - a.v)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((p) => {
      const t = r2(p.i * STEP);
      const h: Hit = { t, strength: Math.round(Math.min(1, p.v / ref) * 100) / 100 };
      if (near(t, beats)) h.beat = true;
      if (near(t, bars)) h.bar = true;
      return h;
    });
}

export interface Shape {
  /** hit: lands at once; riser: builds to a peak near its end; swell: grows, then fades;
   *  steady: no clear peak. */
  kind: "hit" | "riser" | "swell" | "steady";
  /** Where it's loudest, seconds: the moment to line up with a cut. */
  peak: number;
  /** Where it starts to be heard. */
  start: number;
  /** From the start to the peak. */
  build: number;
  /** From the peak until it's 20 dB down for good. */
  tail: number;
  /** Separate attacks, seconds (a double hit, a stutter). */
  hits: number[];
}

/** A short sound's form, from its envelope. Null for silence. */
export function shapeOf(env: Float32Array): Shape | null {
  const lv = levels(env);
  if (lv.silent) return null;
  let pk = 0;
  for (let i = 1; i < env.length; i++) if (env[i]! > env[pk]!) pk = i;
  const peakDb = env[pk]!;
  const on = Math.max(lv.floor + 6, peakDb - 40);
  let start = 0;
  while (start < pk && env[start]! <= on) start++;
  let end = env.length - 1;
  while (end > pk && env[end]! <= peakDb - 20) end--;
  const hits: number[] = [];
  for (let i = 1; i < env.length; i++) {
    // An attack: up 12 dB or more on its recent low within 60 ms, and near the top of the sound.
    if (env[i]! - Math.min(env[i - 1]!, env[Math.max(0, i - 3)]!) >= 12 && env[i]! >= peakDb - 18) {
      const t = r2(i * HOP);
      if (!hits.length || t - hits[hits.length - 1]! > 0.1) hits.push(t);
    }
  }
  const build = (pk - start) * HOP, span = Math.max(HOP, (end - start) * HOP);
  const kind: Shape["kind"] = peakDb - lv.floor < 6 && !lv.silent && lv.steady ? "steady" : build < 0.1 ? "hit" : build >= 0.4 && (pk - start) * HOP >= span * 0.6 ? "riser" : "swell";
  return { kind, peak: r2(pk * HOP), start: r2(start * HOP), build: r2(build), tail: r2((end - pk) * HOP), hits: hits.slice(0, 16) };
}

// ---------- all of it ----------

export interface Music {
  /** The tempo estimate, with how sure it is (a beat only when confidence >= BEAT_SURE). */
  tempo: Tempo | null;
  /** Every beat, seconds, followed through the sound (none when there's no steady beat). */
  beats: number[];
  /** The first beat of each bar. */
  bars: number[];
  /** Beats per bar (4, or 3), when there are bars. */
  meter: number | null;
  /** How sure the bar lines are, 0 to 1. */
  barSure: number;
  sections: Section[];
  hits: Hit[];
  /** For sounds of 15 s or less: where it hits, its build and tail. */
  shape: Shape | null;
}

/** A sound's beat, bars, sections, hits and shape, from its bands (STEP) and envelope (HOP). */
export function hearMusic(bands: Float32Array[], env: Float32Array): Music {
  const tempo = estimateTempo(bands);
  const all = onsets(bands);
  let beats: number[] = [], bars: number[] = [], meter: number | null = null, barSure = 0;
  if (tempo && tempo.confidence >= BEAT_SURE) {
    const frames = trackBeats(all, tempo.interval / STEP);
    beats = frames.map((f) => r3(f * STEP));
    const b = barsOf(frames, onsets(bands, 0, bands[0]!.length, 0), all);
    if (b) {
      meter = b.meter;
      barSure = b.sure;
      bars = beats.filter((_, k) => k % b.meter === b.phase);
    }
  }
  const duration = env.length * HOP;
  const sections = sectionsOf(env, bars.length >= 6 ? bars : beats.length >= 24 ? beats.filter((_, k) => k % 4 === 0) : [], bands);
  return { tempo, beats, bars, meter, barSure, sections, hits: hitsOf(all, beats, bars), shape: duration <= 15 ? shapeOf(env) : null };
}
