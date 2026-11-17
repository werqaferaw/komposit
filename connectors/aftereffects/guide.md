# After Effects ExtendScript (ES3) — correct patterns

Known-good recipes for After Effects scripts. Komposit runs every script with After Effects' dialogs suppressed, so an error comes back to you instead of blocking the app with an alert.

## Results
How your edit script talks back to you:
- Whatever you `return` from the script is delivered to you as `result: <json>`. READ data this way (bounds, colors, counts, names) — do NOT throw an error to surface a value.
- `log(x)` appends to `logs:` for extra values in the same run.
- A failure comes back as `edit failed: <message> (line N)` — fix that line and retry.
- One returning script can both change the doc AND return what you need to verify. Don't probe in separate calls.
- RETURN a plain object/value — AE has no stdout, the wrapper writes your return to a file.

## Undo groups
- Wrap EVERY change: app.beginUndoGroup('what'); ... app.endUndoGroup();
- In Komposit, every edit already runs inside one undo group named "Komposit: " and its explanation (so give edits a short explanation); a group of your own nests inside it. The user's Undo takes the whole edit back in one step.

## Active comp
- In Komposit, `comp` is already the comp this request works in, found by its id: the one open when the request started (or one the request made, when none was), even if the user opens another comp while you work. Use `comp`, not app.project.activeItem, which is whatever the user is viewing now. To work in another comp, find it by name in your code, or pass doc with part (its name) so inspect, render and export use it too. Don't open comps in the viewer (openInViewer) unless the user asks: the viewer is theirs.
- Active comp: var comp = app.project.activeItem; if (!(comp && comp instanceof CompItem)) { for (var i=1;i<=app.project.numItems;i++){ if (app.project.item(i) instanceof CompItem){ comp=app.project.item(i); break; } } }
- (That line is for scripts outside Komposit. Here, only use it when `comp` is null: a project with no comp yet.)

## Text layers
- New text layer: var L = comp.layers.addText("Hello"); then: var td = L.property("Source Text").value; td.fontSize=96; td.fillColor=[1,1,1]; L.property("Source Text").setValue(td);  (AE colors are [r,g,b] 0–1, NOT 0–255).

## Position and keyframes
- Position: L.property("Transform")("Position").setValue([x, y]);  (time in SECONDS; keyframes via setValueAtTime(t, v)).

## Solids
- New solid: comp.layers.addSolid([r,g,b], "name", comp.width, comp.height, 1);

## Easing
- Easing (what makes motion feel designed): after setting keys, var e = new KeyframeEase(0, 75); prop.setTemporalEaseAtKey(k, [e], [e]);  (one KeyframeEase per dimension for separated/spatial props: Position in 3D takes 1 since it's spatial; Scale takes 3 → [e,e,e]). Speed 0 + influence 33–80 = ease in/out.
- Hold or linear: prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD | LINEAR | BEZIER).

## Stagger
- Stagger several layers: offset each layer's keys by i * frameDuration * N, or shift layer.startTime.

## Importing files
- Import an attached file (footage, image, audio, AI/PSD): var item = app.project.importFile(new ImportOptions(new File(path))); comp.layers.add(item);  (AI/PSD import as footage; set ImportOptions.importAs = ImportAsType.COMP to keep layers).

## Expressions
- Expressions: prop.expression = 'wiggle(2, 20)'; check prop.expressionError afterwards.

## Selection
- Read the selection's refs from the [Live selection] block; times are in seconds.

## Checking motion
- To check motion, render with frames: 4-6; when it's done, render once with video: true so the user can watch it.

## Timing to sound
- Hear the comp before you time anything to sound: the listen tool measures the comp's layers that have audio on this computer (each one's level, where it has sound, the pauses, who is loudest when across them, and for music its tempo, every beat, the bars, the sections and the strongest hits), in comp seconds. Listen with path to hear a file that isn't in the comp (a song, a voice-over, a sound effect), in the file's own seconds.
- In the edits after it, K.heard holds it: { what: 'composition', name, id, duration, tracks: [{ track (the layer's index), name, kind: 'voice'|'music'|'silent', sound: [[start, end]], pauses }], turns, nobody, beats: { track, bpm, interval, first, times: [every beat], bars: [the first beat of each bar], meter, barsSure }, sections: [{ start, end, level: 'quiet'|'medium'|'loud', kind: 'build'|'drop'|'break'|'outro' }], hits: [{ t, strength, beat, bar }] }. After moving or trimming layers, listen again.
  K.beats({ from, to, every: 2, bars: true })  the heard beats (or bars), every nth one, on the comp's frames. For a file heard by path, pass at (where it starts in the comp) and songIn (the second of it that plays there).
  K.markBeats(layer, { bars: true })  layer markers on the beats or bars (no layer: the music's own layer).
  K.onBeats([layer, ...], { beats: 2, from: 4, hold: true })  moves each layer so it starts on a beat, every that many beats; hold ends each one where the next begins.
- Land motion on the music: the big move on a drop or one of the strongest hits, a settle in a break, keyframes on beats (setValueAtTime at K.beats() times). A sound effect heard by path says where its peak is: start its layer that many seconds before the moment it should hit.
- A voice's sound ranges say when each line starts and ends: bring text in a few frames before a range starts and hold it to its end. There are no words in After Effects (only where the sound is): for lyrics or captions, take the lines from the user, lay them on the sound ranges in order, and say they may want nudging.
