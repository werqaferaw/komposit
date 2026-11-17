import { test } from "node:test";
import assert from "node:assert/strict";
import { helpersUsed, mapHelperLine, mergeHelpers, parseHelpers, withHelpers, type Helper } from "./helpers.ts";
import { es3Problem, scriptSaves } from "./es3.ts";

const ok = (src: string): Helper[] => {
  const r = parseHelpers(src);
  if ("error" in r) throw new Error(r.error);
  return r.helpers;
};

test("parseHelpers: functions and var lines, each with its comments, named", () => {
  const list = ok(`
// mm to points
function mm(v) { return v * 2.834645; }
/* colours */
var C = { ink: rgb(20, 20, 20), paper: rgb(244, 238, 228) }, GAP = mm(4);
function rgb(r, g, b) {
  var c = new RGBColor(); c.red = r; c.green = g; c.blue = b;
  if (r > 255) { throw new Error("}"); }
  return c;
};
const SIZE = 12
var LABEL = "a; b"
function last() { return /[}]/.test("x"); }
`);
  assert.deepEqual(list.map((h) => h.names), [["mm"], ["C", "GAP"], ["rgb"], ["SIZE"], ["LABEL"], ["last"]]);
  assert.equal(list[0]!.code, "// mm to points\nfunction mm(v) { return v * 2.834645; }");
  assert.match(list[1]!.code, /^\/\* colours \*\/\nvar C = /);
  assert.match(list[2]!.code, /return c;\n\};$/);
  assert.equal(list[3]!.code, "const SIZE = 12");
});

test("parseHelpers: refuses statements, broken brackets and code that doesn't compile", () => {
  for (const [src, why] of [
    ["doc.layers[0].remove();", /only hold function declarations and var lines/],
    ["function a() { return 1;", /isn't complete/],
    ["var x = [1, 2;", /isn't complete/],
    ["function a() { return 1 +; }", /doesn't compile/],
    ["// nothing", /has no function or var/],
    ["", /has no function or var/],
  ] as const) {
    const r = parseHelpers(src);
    assert.ok("error" in r, src);
    assert.match((r as { error: string }).error, why, src);
  }
});

test("helpers: merge by name, prefix, and errors mapped back to the AI's lines", () => {
  const kept = ok("function a() {\n  return 1;\n}\nvar B = 2, C = 3;");
  const next = mergeHelpers(kept, ok("var C = 4;\nfunction d() { return C; }"));
  assert.deepEqual(next.map((h) => h.names), [["a"], ["C"], ["d"]], "the var line with C went, a stayed");
  const w = withHelpers(next, "d();\nboom();");
  assert.equal(w.lines, 5);
  assert.equal(w.code.split("\n")[6], "boom();");
  assert.equal(mapHelperLine("No such element (line 7). Hint: x", next, w.lines), "No such element (line 2). Hint: x");
  assert.equal(mapHelperLine("Object is invalid (line 2)", next, w.lines), "Object is invalid (in helper a, its line 2)");
  assert.equal(mapHelperLine("Object is invalid (line 5)", next, w.lines), "Object is invalid (in helper d, its line 1)");
  assert.equal(mapHelperLine("no line here", next, w.lines), "no line here");
  assert.deepEqual(withHelpers([], "x"), { code: "x", lines: 0 });
  assert.deepEqual(helpersUsed(next, "var x = d() + C; log('a()'); obj.a();"), ["C", "d"], "not in strings, not a property");
});

test("es3Problem: only what can't run in ExtendScript, outside strings and comments", () => {
  assert.match(es3Problem("var a = [1];\nvar b = a.map(function (x) { return x; });")!, /^ExtendScript is ES3, and line 2 uses \.map\(\), which ES3 arrays don't have; use a for loop \(var b = a\.map/);
  assert.match(es3Problem("a.forEach(function(){}); var f = (x) => x;")!, /line 1 uses \.forEach\(\).*Also: an arrow function/);
  assert.match(es3Problem("var s = `x${1}`;")!, /template string/);
  assert.match(es3Problem("var k = Object.keys(o);")!, /Object\.keys\(\), which ES3 doesn't have; use for \(var k in o\)/);
  assert.match(es3Problem("if (Array.isArray(a)) {}")!, /use x instanceof Array/);
  for (const fine of [
    "var a = 1; // a.map(x => x)",
    "log('items.filter(x => y) `tick`');",
    "Array.prototype.map = function (f) { var o = []; for (var i = 0; i < this.length; i++) o.push(f(this[i])); return o; };\n[1].map(function (x) { return x; });",
    "var o = { filter: function () {} }; o.filter();",
    "if (a >= b && c <= d) {}",
    "var t = JSON.stringify({ a: 1 });",
  ]) assert.equal(es3Problem(fine), null, fine);
});

test("scriptSaves: a plain .save() call, not one in a string or without a call", () => {
  assert.match(scriptSaves("doc.pathItems[0].left = 1;\napp.activeDocument.save();")!, /^line 2 saves the document \(app\.activeDocument\.save\(\);\)/);
  assert.equal(scriptSaves("log('doc.save()'); var s = doc.saved;"), null);
  assert.equal(scriptSaves("doc.saveAs(f, o);"), null, "a save to a path is the script check's");
});
