// K for After Effects: what listening heard (K.heard) and the helpers that time things to it,
// put in front of an edit only when the edit names K (After Effects edits have no other
// toolkit). Ported from 1.0's withHeard (aftereffects.mjs), plus, new in v2: K.beats (the
// heard beats or bars in this comp, on its frames), K.markBeats (layer markers on them) and
// K.onBeats (layers moved so each starts on a beat). K.heard says which comp (or file) it is
// of, and the helpers refuse beats of another comp.
//
// One line, put in front of the edit on the same line, so its error lines still match.
// `comp` is the request's comp (the guard's).
export const AE_K = `
var K = (function(){
function heardOf(){ var H = K.heard; if (!H) throw new Error('Nothing heard yet: call listen first (on this comp, or with path for a song file), then use K.heard in the next edit.'); return H; }
function fd(){ return comp ? comp.frameDuration : 1 / 30; }
function snap(t){ return Math.round(t / fd()) * fd(); }
function shiftOf(H, o){ if (H.what === 'file'){ if (o.at === undefined) throw new Error('K.heard is the file ' + H.name + ', in its own seconds: pass at (where the song starts in the comp) and songIn (the second of the song that plays there), or add the song to the comp and listen to the comp.'); return Number(o.at) - Number(o.songIn || 0); } if (H.what !== 'composition') throw new Error('K.heard is not of an After Effects comp: listen in After Effects first.'); if (H.id && comp && String(H.id) !== String(comp.id)) throw new Error('K.heard is of the comp ' + H.name + ', not ' + comp.name + ': listen to this one first.'); return 0; }
function beats(o){ o = o || {}; var H = heardOf(), B = H.beats; if (!B || !B.times || !B.times.length) throw new Error('No steady beat was heard in ' + H.name + ': time things to K.heard.sections and K.heard.hits instead.'); var shift = shiftOf(H, o), lo = H.what === 'file' ? Number(o.at) : -1e9, list = B.times; if (o.bars){ if (!B.bars || !B.bars.length) throw new Error('No bars were heard in ' + H.name + ': use the beats.'); list = B.bars; } var from = o.from === undefined ? lo : Math.max(lo, Number(o.from)), to = o.to === undefined ? 1e9 : Number(o.to), every = Math.max(1, Math.round(Number(o.every) || 1)), out = [], k = 0; for (var i = 0; i < list.length; i++){ var t = list[i] + shift; if (t < from - 0.001 || t > to + 0.001) continue; if (k % every === 0) out.push(snap(t)); k++; } return out; }
function markBeats(layer, o){ o = o || {}; var H = heardOf(), L = layer; if (!L){ if (H.what === 'composition' && H.beats && H.beats.track) L = comp.layer(H.beats.track); else throw new Error('Pass the layer to put the markers on.'); } var t = beats(o), label = o.name || (o.bars ? 'Bar' : 'Beat'), mk = L.property('Marker'); if (t.length > 1000) throw new Error(t.length + ' markers is too many: pass bars: true, every, or from and to.'); for (var i = 0; i < t.length; i++) mk.setValueAtTime(t[i], new MarkerValue(label + ' ' + (i + 1))); return { markers: t.length, layer: L.name, from: t.length ? t[0] : null, to: t.length ? t[t.length - 1] : null }; }
function onBeats(layers, o){ o = o || {}; var n = Math.max(1, Math.round(Number(o.beats) || 1)), t = beats({ at: o.at, songIn: o.songIn, from: o.from, to: o.to, bars: o.bars }), out = []; for (var i = 0; i < layers.length; i++){ var k = i * n; if (k >= t.length) break; var L = layers[i]; L.startTime = L.startTime + (t[k] - L.inPoint); if (o.hold && k + n < t.length) L.outPoint = t[k + n]; out.push({ layer: L.name, start: L.inPoint, end: L.outPoint }); } return { placed: out.length, layers: out }; }
return { beats: beats, markBeats: markBeats, onBeats: onBeats, heard: null };
})();`.replace(/\n/g, " ");

/** An edit that uses K (After Effects edits get it only then). */
export const USES_K = /\bK\.\w/;
