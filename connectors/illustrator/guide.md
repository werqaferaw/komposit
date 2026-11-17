# Illustrator ExtendScript (ES3) — correct patterns

Known-good recipes for Illustrator scripts. In a run script, `doc` is the document the call targets (the one in front when none is named).

## Results
How your edit script talks back to you:
- Whatever you `return` from the script is delivered to you as `result: <json>`. READ data this way (bounds, colors, counts, names) — do NOT throw an error to surface a value.
- `log(x)` appends to `logs:` for extra values in the same run.
- A failure comes back as `edit failed: <message> (line N)` — fix that line and retry.
- One returning script can both change the doc AND return what you need to verify. Don't probe in separate calls.

## Document model
- DOM: app.activeDocument (doc), doc.layers[], doc.pageItems[], doc.textFrames[], doc.artboards[].

## Bounds
- geometricBounds = [left, top, right, bottom] in POINTS, y increases UPWARD (top > bottom). Width = r-l, height = top-bottom.

## Color
- Color: var c = new RGBColor(); c.red=230; c.green=80; c.blue=40;  (0–255). Match doc.documentColorSpace (RGB vs CMYK).

## Shapes
- New rectangle: var it = doc.pathItems.rectangle(top, left, width, height); it.filled=true; it.stroked=false; it.fillColor=c;  (note: top-left origin, y DOWN for this call's args).
- New ellipse/circle: doc.pathItems.ellipse(top, left, width, height).

## Text
- New text: var tf = doc.textFrames.add(); tf.contents="Hi"; tf.textRange.characterAttributes.size=48; tf.left=x; tf.top=y;

## Centering
- Center on an artboard: var r=doc.artboards[i].artboardRect; // [l,t,r,b]; cx=(r[0]+r[2])/2; cy=(r[1]+r[3])/2; then set item.left=cx-item.width/2; item.top=cy+item.height/2;

## Duplicating
- Duplicate artwork: use item.duplicate() — NEVER copy()/paste(). Paste needs the app frontmost and fails with "Illustrator must be the front application".

## Artboards
- Switch artboard: doc.artboards.setActiveArtboardIndex(i).

## Locked layers
- "Target layer cannot be modified" when creating art: the document's ACTIVE layer is locked or hidden, even if you target another layer. Set doc.activeLayer to the visible, unlocked layer you're drawing into first.
- It also comes from a locked or hidden PARENT: a sublayer inside a locked layer can't be changed even when it's unlocked itself. Moving or duplicating into a locked or hidden layer fails too (often as the PARM / 'MRAP' error). Items have their own item.locked and item.hidden.
- Open a layer and its parents for a change, then put every one back as it was (the person locked them for a reason):
  function openLayer(L){ var was = []; for (var x = L; x && x.typename === 'Layer'; x = x.parent){ was.push([x, x.locked, x.visible]); x.locked = false; x.visible = true; } return was; }
  function putBack(was){ for (var i = was.length - 1; i >= 0; i--){ was[i][0].visible = was[i][2]; was[i][0].locked = was[i][1]; } }
  var was = openLayer(L); var prevActive = doc.activeLayer; try { doc.activeLayer = L; /* the change */ } finally { try { doc.activeLayer = prevActive; } catch(e){} putBack(was); }
- New art the person didn't ask to go on a locked layer: put it on a visible, unlocked layer instead (or make one: doc.layers.add()) and leave theirs alone. inspect shows each layer's visible and locked.

## Lookups by name
- getByName throws "No such element" when nothing has that name (layers, pageItems, swatches, app.textFonts). Look up with a loop that can come back empty:
  function byName(coll, name){ for (var i = 0; i < coll.length; i++){ if (coll[i].name === name) return coll[i]; } return null; }
  var L = byName(doc.layers, 'Background'); if (!L) { var all = []; for (var j = 0; j < doc.layers.length; j++) all.push(doc.layers[j].name); return 'no layer called Background; there are: ' + all.join(', '); }
- Names are exact and case-sensitive; layers can be nested (L.layers), and items live in groups (walk group.pageItems). Item names are often empty: use the `ref` from inspect instead.
- Fonts: app.textFonts.getByName needs the PostScript name ("Helvetica-Bold"), not the menu name. A missing font gives "No such element" or "Required value is missing" on the line that uses it.

## ES3 limits
- ExtendScript is ES3. Arrays have no map, forEach, filter, reduce, some, every or indexOf; strings have no trim; there's no Object.keys, Array.isArray, let, arrow functions or template strings. Komposit refuses most of these before the script runs, since they'd fail half way.
- Instead: for (var i = 0; i < a.length; i++) { ... } for map/forEach/filter; for (var k in o) { if (o.hasOwnProperty(k)) ... } for Object.keys; s.replace(/^\s+|\s+$/g, '') for trim; x instanceof Array for isArray; 'a' + b + 'c' for template strings.
- JSON.stringify and JSON.parse work in edits (Komposit adds them), but you rarely need them: return objects and arrays as they are.

## Text frame kinds
- tf.kind is TextType.POINTTEXT (click text), TextType.AREATEXT (text in a box) or TextType.PATHTEXT (text on a path). Some properties exist only on some kinds, and the wrong one fails with "The requested property is not available for this type of text frame" or "Not implemented".
- All kinds: contents, textRange (characterAttributes, paragraphAttributes), name, position, left, top, geometricBounds. Point text only: anchor. Area text only: columnCount, columnGutter, rowCount, rowGutter, spacing (the inset), textPath (the box). Path text: textPath, startTValue, endTValue.
- Make each kind: doc.textFrames.pointText([x, y]); doc.textFrames.areaText(doc.pathItems.rectangle(top, left, w, h)); doc.textFrames.pathText(aPathItem). Check tf.kind before reading kind-only properties when looping over doc.textFrames.

## Menu commands
- app.executeMenuCommand('name') fails (Illustrator error 'yeKB') when the command isn't available right now, e.g. "exitisolation" when nothing is in isolation mode. Wrap each in try { } catch(e) { } and check the result another way.

## Long scripts
- Write each edit's shared setup once: when edit takes `helpers` (the Komposit app), put drawing helpers, colours and lookups there; they're kept for the chat and in front of every later edit in Illustrator, so later edits only call them. Never paste the same functions into each edit.
- Split big work into a few edits of related changes (a section, a set of items), each returning what it made so you can check it, instead of one huge script. A script that fails half way leaves what it already did: undo, or fix from there.
- To see the result of an edit, pass render: true on the edit (the Komposit app) instead of calling render after it: one call instead of two.
- Never call app.redraw() in an edit: each call ends an undo step, so one edit would become several steps in the user's undo history (Komposit refuses it). Renders and exports see your changes without it.

## Vector files
- Bring in an attached VECTOR file (SVG, PDF, AI, EPS) as editable artwork: var g = doc.groupItems.createFromFile(new File(path));  then size/position g (it's a GroupItem). One call, no copy/paste, no opening the file.

## Raster images
- Place an attached RASTER image (PNG, JPG, PSD, TIFF): var p = doc.placedItems.add(); p.file = new File(path);  (linked; p.embed() embeds it). placedItems does NOT accept SVG. If setting .file throws, p.remove() the empty item it leaves behind.

## Nested colors
- A path's color may be nested in a GroupItem — walk group.pageItems recursively; inspect() now returns nested group fills in `fills`.
