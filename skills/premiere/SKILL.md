---
name: premiere
description: Use when the person wants something made, changed, checked or exported in Premiere Pro (video editing, cuts, sequences, titles, sound levels and video exports) and the komposit MCP tools are available. Covers how to look, script with ExtendScript, render, export and save safely, plus tested Premiere Pro recipes.
---

# Premiere Pro through Komposit

Work in the person's open Premiere Pro documents with the komposit MCP tools (the komposit-mcp server). Pass `app: "premiere"` on every app tool, and `doc` ({ name, path } from `documents`) when more than one document is open.

## How to work

1. Look first. `apps` says whether Premiere Pro is open and ready; `documents` lists what's open; `inspect` maps the document (each item has a `ref` you can use in code) and shows a picture.
2. Find the recipe. The recipes below are the same ones `guide` serves (`guide` with no topic lists them). Build on them instead of guessing the scripting API.
3. Change with `edit`: ExtendScript (ES3: `var` and `function`; no `let`, `const`, arrow functions or template strings). `return` what you need to check, and batch related changes in one script. A failure comes back with its line number.
4. Look at the result. `render` after a visual change; fix what's off, or `undo`.
5. Check before you say it's done: what was asked is there and nothing else moved.
6. Deliver. `export` writes a new file (png and mp4) to ~/Komposit Exports or an `outputDir` in the home folder, and never overwrites. `save` only when the person asks: `overwrite` (the file itself), `copy` (a new file, the document stays as it is) and `as` (a new file the document becomes).

## Rules

- Never save unless the person asks. Edits stay in the app's undo history until they do.
- Scripts that delete, rename or run files, run commands, quit the app, close documents or save are refused. Use the tools, or leave it to the person.
- Komposit never opens Premiere Pro. If it isn't open, ask the person to open it.
- Premiere Pro takes one call at a time; calls wait their turn.
- To bring in a file from elsewhere (another app's export, an image), use `place` with its absolute path.
- Premiere Pro's scripts only reach its active project: pass `doc` (the project's name and path from `documents`) on every call that changes it (`edit`, `undo`, `save`, `place`, and `render` with `video`). A call for a project that isn't the active one, or one that names none, changes nothing and says why; then ask the person to click into the right project.
- Komposit reaches Premiere Pro through its own small panel inside the app. When `apps` says the panel isn't installed or hasn't loaded, pass on what it says.
- To check a cut, `render` with `frames` 2-8. To find or rule something out across a stretch, watch it: `render` with `every` (seconds between frames), `from` and `to` gives contact sheets.

<!-- The recipes below are generated from connectors/premiere/guide.md by skills/build.mjs. Edit the guide, then run node skills/build.mjs. -->

# Premiere Pro ExtendScript (ES3) — correct patterns

Known-good recipes for Premiere Pro scripts. Komposit reaches Premiere through its own panel inside the app, and Premiere's scripts only reach its active project: name the project (doc) on every call that changes it.

## Results
How your edit script talks back to you:
- Whatever you `return` from the script is delivered to you as `result: <json>`. READ data this way (bounds, colors, counts, names) — do NOT throw an error to surface a value.
- `log(x)` appends to `logs:` for extra values in the same run.
- A failure comes back as `edit failed: <message> (line N)` — fix that line and retry.
- One returning script can both change the doc AND return what you need to verify. Don't probe in separate calls.

## The project
- The document is the open project: var p = app.project; var seq = p.activeSequence;  (null when no sequence is open). Refs from inspect read like seq.videoTracks[0].clips[2], so start with var seq = app.project.activeSequence; Clip and track numbers are 0-based (V1 is videoTracks[0]).
- In Komposit, start with var seq = K.seq(); instead: it is this request's sequence, the one open when the request started, found by its id, even if the user opens another one while you work. app.project.activeSequence is whatever is open now, which may be the user's other sequence.
- To work in another sequence, pass doc with part (its name). Frames, razor cuts and other QE work only happen in the sequence open in the timeline: when the request's sequence isn't the open one, they say so and change nothing; ask the user to open it. Komposit never switches the user's timeline.
- Name the project on every call that changes it: pass doc with the project's name and path (from the open-files list, or documents) to edit, undo, save, place, and render with video. Premiere's scripts only reach its ACTIVE project, so a call for a project that isn't the active one, or one that names none, changes nothing and says why: then ask the person to click into the right project in Premiere Pro. Reads (inspect, render, export) work on the active project; pass doc there too, so you never read the wrong one.
- An edit can't save, open, close or switch projects, quit Premiere, or reach into the other open projects (app.projects): it is refused before it runs. Save with the save tool when the person asks; open a project with the open tool.
- alert(), confirm() and prompt() don't show anything in a Komposit script (a dialog would hold Premiere up): their text goes to logs, confirm() answers no.

## K toolkit
- Every edit script has K, a toolkit of tested helpers for the calls that are easy to get wrong. Use it:
  K.clip('video'|'audio', track, index)  the clip (same as the ref);  K.seq()  the active sequence;  K.findItem(name)  a project item, searching bins.
  K.effects('video'|'audio'|'transition'|'audioTransition', 'word')  effect names containing a word. Names are exact and differ between Premiere versions (in 2026 "Gaussian Blur" has the setting "Amount" and the older effect is "Gaussian Blur (Legacy)" with "Blurriness"; before that, "Gaussian Blur" is the one with "Blurriness"), so look names up here and read the settings K.addEffect returns instead of assuming them.
  K.addEffect(clip, name)  adds a video or audio effect (by the clip's kind) and returns its settings with their current values;  K.settings(clip, effectOrComponent)  the same for any effect, Motion, Opacity or Volume.
  K.set(clip, effect, setting, value)  sets one;  K.keys(clip, effect, setting, [[seconds, value], ...])  keyframes at TIMELINE seconds (K converts to the clip's source time).
  K.transition(clip, name, { at: 'end'|'start'|'both', seconds: 1, align: 0.5 })  a video transition, or an audio one on an audio clip (default Cross Dissolve / Constant Power); align 0.5 centres it on the cut.
  K.volume(audioClip, dB);  K.volumeKeys(audioClip, [[seconds, dB], ...])  for fades and ducking under voice.
  K.speed(clip, percent, { ripple, reverse, keepPitch })  (200 = twice as fast; ripple moves later clips).
  K.razor(seconds)  cuts every track there;  K.razor(seconds, { kind: 'video', track: 0 })  one track. K.remove(clip, { ripple: true });  K.disable(clip, true).
  K.addTracks(video, audio);  K.importFiles([paths], 'Bin name')  returns the new items;  K.tc(seconds)  a frame-exact timecode string for QE calls;  K.snap(seconds)  onto the frame grid.
  K.captions([[start, end, 'text'], ...], { name })  writes an .srt next to the project and adds it as a caption track (subtitles, lyrics, quotes). Caption tracks came with Premiere Pro 2021; a helper that needs a newer Premiere than the user has says so in its error.
  K.template('Basic Title'|'Basic Lower Third'|path.mogrt, seconds, videoTrack)  adds a Motion Graphics template.

## Effects
- Lumetri Color settings by name: Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Temperature, Tint, Saturation, Vibrance, Faded Film, Sharpen (K.set(clip, 'Lumetri Color', 'Exposure', 0.8)). Motion: Position [x, y] as 0-1 of the frame, Scale, Rotation, Anchor Point. Opacity: Opacity (0-100).
- Useful audio effects: DeNoise, DeReverb, DeHummer, DeEsser, Dynamics, Multiband Compressor, Hard Limiter, Parametric Equalizer, Studio Reverb, Amplify, Loudness Meter.

## QE
- When you write your own QE code: never pick between QE calls with ?: (Premiere's ExtendScript takes the wrong branch); use if/else. QE track items include empty gaps; K.qeClip(clip) finds the right one.

## Times
- Times: Time objects have .seconds and .ticks (a string; 254016000000 ticks per second). Clip times: clip.start / clip.end (timeline), clip.inPoint / clip.outPoint (source; stills start an hour in). Clips sit on frame boundaries, and round seconds often aren't one (at 23.976 fps, 2 s is 47.95 frames): work in frames with K.snap, and inspect lists any gaps per track, tick-exact.
- Close a gap or butt clips together: next.move((Number(prev.end.ticks) - Number(next.start.ticks)) / 254016000000)  (move keeps the clip's length; work left to right). Sequence length (seq.end) is the end of the LAST clip on ANY track, audio included.

## Clips on the timeline
- Put a clip on the timeline: seq.videoTracks[0].overwriteClip(item, seconds)  (replaces what's there) or .insertClip(item, seconds)  (ripples later clips). Audio comes along on the linked audio track. A new sequence from clips: var s = p.createNewSequenceFromClips(name, [items], p.rootItem); then p.openSequence(s.sequenceID)  (it isn't made active by itself).
- A piece of a file on the timeline, by its in and out point: item.setInPoint(seconds, 4); item.setOutPoint(seconds, 4); seq.videoTracks[0].insertClip(item, timelineSeconds); and item.clearInPoint(); item.clearOutPoint() after (K.findItem(name) gives the item; 4 means picture and sound). Cut on the gaps between words, a few frames before the first and after the last, never mid-word.
- Trim: set clip.end = seconds or clip.start = seconds (keeps the source sync); clip.inPoint / clip.outPoint shift the source range. Remove several clips from the END of a track backwards.

## Markers
- Markers: var m = seq.markers.createMarker(seconds); m.name = 'x'; m.comments = 'y'; m.end = seconds2 (for a range). In/out: seq.setInPoint(seconds), seq.setOutPoint(seconds).

## Undo
- Every DOM change is its own undo step in Premiere (no undo groups), so batch related changes in one script and say how many undo steps take it back if it matters.

## Titles and text
- Text inside Premiere's own titles can't be read or changed by scripts. For real typography, design the title in Illustrator or Photoshop, export a PNG (transparent background) and place it on a track above the footage, then animate it with K.keys on Motion (Position, Scale) and Opacity. For words on screen that are simply read (subtitles, lyrics, names), use K.captions. A template's text is edited by the user in the Essential Graphics panel; say so.

## Cutting a whole sequence
- Cutting from who talks when, tightening and music under voice: helpers for whole sequences. Komposit can't listen to a sequence yet, so the times come from the person (their notes, a transcript, markers they set) or from what you can see in renders: say where they came from.
  K.multicam([[start, end, videoTrack], ...], { tracks: [0, 1, 2] })  cuts those camera tracks at every change and shows only the chosen camera in each stretch (the others are disabled, not deleted, so the user can change a pick). For a podcast or interview: the cameras sit stacked on video tracks; build the cuts from who talks when. Edit like an editor: a reply shorter than about 1.5 s stays on whoever was on screen, a cut lands a few frames before the first word, and the wide shot covers people talking over each other and long stretches of one person.
  K.removeRanges([[start, end], ...])  takes those stretches out of every track and closes the gaps (leave about 0.15 s of breath at each side of dead air). Run K.backup('tightening') first: it leaves a copy of the sequence named "… (before tightening)" in the project, because Premiere's undo only goes back one small step at a time.
  K.duck(musicClip, ranges, { base: -8, low: -22, fade: 0.4 })  holds the music at base dB and dips it to low under the ranges (where the voice is).

## Looking at your work
- Look at your work: render with frames 3-6 to check a cut, a grade or a title; render with video: true once a sequence is done so the user can watch it.
- Watch, don't spot-check, when something has to be found or ruled out (a person in shot, a logo, a blurred take): render with every (0.1 for a fast cut; shorter than the shortest shot) and from/to. The contact sheets show every stretch, and the list under them says which clip and which seconds of its source each frame is, so you know exactly what to replace. Before pointing a shot at new source footage, watch that part of the source first: open the sequence that holds the whole take (app.project.openSequence(id)), watch it, and come back. Say what you watched and at what spacing; never say "none of the frames show it" about frames you didn't look at.

## Saving and exporting
- save, only when the person asks: mode "overwrite" saves the project's own file; "as" saves it as a new .prproj that the open project then becomes (later saves go there: name the new path as doc from then on); "copy" writes the active sequence and the media it uses as a new project and leaves the open project as it is (other sequences aren't in it). To keep a version inside the project instead, K.backup(label) copies the sequence.
- export: png is the frame at the playhead at full size; mp4 is H.264 of the sequence's in/out range (or all of it when none is set), matching its settings, through Premiere's own encoder. Neither changes the project.
