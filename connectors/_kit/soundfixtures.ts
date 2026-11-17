// Made-up sounds with known answers, for the listening tests: clicks at a known tempo with a
// kick on each bar's first beat, a song whose loud and quiet stretches are known, speech-like
// bursts with known pauses, and sound effects with a known hit point. Deterministic (seeded
// noise), so a test always hears the same thing.

/** A seeded random number generator (mulberry32), 0 to 1. */
export function seeded(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adds a drum hit at `t` seconds: "kick" (a low thump), "snare" (a noise burst with body) or
 *  "hat" (a short bright tick). */
export function addDrum(x: Float32Array, rate: number, t: number, kind: "kick" | "snare" | "hat", amp = 1, rnd = seeded(Math.round(t * 1000) + 7)): void {
  const at = Math.round(t * rate);
  const len = Math.round(rate * (kind === "kick" ? 0.18 : kind === "snare" ? 0.12 : 0.04));
  let hp = 0, prev = 0;
  for (let i = 0; i < len && at + i < x.length; i++) {
    const s = i / rate;
    let v = 0;
    if (kind === "kick") v = Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-s * 30)) * s) * Math.exp(-s * 18);
    else {
      const n = rnd() * 2 - 1;
      hp = 0.6 * (hp + n - prev); // a little high-pass: brighter noise
      prev = n;
      v = kind === "snare" ? (0.6 * hp + 0.4 * Math.sin(2 * Math.PI * 190 * s)) * Math.exp(-s * 30) : hp * Math.exp(-s * 120);
    }
    x[at + i] = x[at + i]! + amp * v;
  }
}

/** A beat at `bpm` from `first` s for `seconds`: a kick on each bar's first beat (bars of
 *  `meter`), a snare on the others, a hat on every off-beat. Returns the samples and the
 *  times of the beats and bars. */
export function drumTrack({ bpm, seconds, rate = 16000, first = 0.25, meter = 4, amp = 0.5, gain, bpmEnd, jitter = 0, seed = 11 }: { bpm: number; seconds: number; rate?: number; first?: number; meter?: number; amp?: number; gain?: (t: number) => number; bpmEnd?: number; jitter?: number; seed?: number }): { x: Float32Array; beats: number[]; bars: number[] } {
  const x = new Float32Array(Math.round(seconds * rate));
  const beats: number[] = [], bars: number[] = [], rnd = seeded(seed);
  // The tempo may drift from bpm to bpmEnd (a live band), and each hit may be early or late by
  // up to `jitter` seconds (a human drummer).
  const tempoAt = (t: number) => (bpmEnd ? bpm + ((bpmEnd - bpm) * t) / seconds : bpm);
  for (let k = 0, grid = first; grid < seconds - 0.2; k++, grid += 60 / tempoAt(grid)) {
    const t = Math.max(0, grid + (jitter ? (rnd() * 2 - 1) * jitter : 0));
    const step = 60 / tempoAt(grid);
    const g = amp * (gain ? gain(t) : 1);
    beats.push(Math.round(t * 1000) / 1000);
    if (k % meter === 0) { bars.push(Math.round(t * 1000) / 1000); addDrum(x, rate, t, "kick", g); }
    else addDrum(x, rate, t, "snare", g * 0.55);
    if (t + step / 2 < seconds - 0.1) addDrum(x, rate, t + step / 2, "hat", g * 0.3);
  }
  return { x, beats, bars };
}

/** A held chord (three sines), its loudness following `gain(t)`. */
export function addPad(x: Float32Array, rate: number, gain: (t: number) => number, freqs = [220, 277.2, 329.6]): void {
  for (let i = 0; i < x.length; i++) {
    const t = i / rate;
    let v = 0;
    for (const f of freqs) v += Math.sin(2 * Math.PI * f * t);
    x[i] = x[i]! + (gain(t) * v) / freqs.length;
  }
}

/** Speech-like sound: voiced syllables (a buzzing tone through a few formants, about four a
 *  second, with uneven loudness) in the given stretches; a quiet room elsewhere. */
export function speechLike(stretches: [number, number][], { seconds, rate = 16000, amp = 0.3, pitch = 130, seed = 3, room = 0.0015 }: { seconds: number; rate?: number; amp?: number; pitch?: number; seed?: number; room?: number }): Float32Array {
  const x = new Float32Array(Math.round(seconds * rate));
  const rnd = seeded(seed);
  for (let i = 0; i < x.length; i++) x[i] = room * (rnd() * 2 - 1);
  for (const [a, b] of stretches) {
    let t = a;
    while (t < b - 0.05) {
      const len = Math.min(b - t, 0.14 + rnd() * 0.16), loud = 0.55 + rnd() * 0.45;
      const f0 = pitch * (0.9 + rnd() * 0.2);
      const i0 = Math.round(t * rate), n = Math.round(len * rate);
      for (let i = 0; i < n && i0 + i < x.length; i++) {
        const s = i / rate, w = Math.sin((Math.PI * i) / n) ** 0.6;
        let v = 0;
        for (let h = 1; h <= 18; h++) {
          const f = f0 * h;
          const formant = Math.exp(-(((f - 600) / 250) ** 2)) + 0.6 * Math.exp(-(((f - 1700) / 400) ** 2)) + 0.25;
          v += (formant * Math.sin(2 * Math.PI * f * s)) / h;
        }
        x[i0 + i] = x[i0 + i]! + amp * loud * w * v * 0.5;
      }
      t += len + 0.03 + rnd() * 0.06; // the little gaps between syllables
    }
  }
  return x;
}

/** A sound effect: "hit" (lands at `at` and rings out) or "riser" (noise that grows to `at`
 *  and stops). */
export function effect(kind: "hit" | "riser", { at, seconds, rate = 16000, seed = 5 }: { at: number; seconds: number; rate?: number; seed?: number }): Float32Array {
  const x = new Float32Array(Math.round(seconds * rate));
  const rnd = seeded(seed);
  for (let i = 0; i < x.length; i++) {
    const t = i / rate, n = rnd() * 2 - 1;
    if (kind === "hit") x[i] = t >= at ? 0.8 * n * Math.exp(-(t - at) * 7) + 0.6 * Math.sin(2 * Math.PI * 70 * (t - at)) * Math.exp(-(t - at) * 5) : 0.0005 * n;
    else x[i] = t <= at ? 0.7 * n * Math.exp((t - at) * 2.2) : 0.0005 * n;
  }
  return x;
}
