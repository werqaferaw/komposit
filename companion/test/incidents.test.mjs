// The incident log: app failures and script errors land in incidents.jsonl.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "kp-inc-"));
process.env.KOMPOSIT_DATA_DIR = dir;
const { recordIncident, recordFailure, readIncidents, classify, appKey } = await import("../incidents.mjs");

test("classifies osascript failures", () => {
  assert.equal(classify("Adobe Illustrator didn't answer in time. If it's showing a dialog…"), "timeout");
  assert.equal(classify("execution error: Adobe Illustrator got an error: AppleEvent timed out. (-1712)"), "timeout");
  assert.equal(classify("Connection is invalid. (-609)"), "crash");
  assert.equal(classify("Error 1302: No such element"), "app-error");
  assert.equal(appKey('application "Adobe Illustrator"'), "illustrator");
  assert.equal(appKey('application id "com.adobe.Photoshop"'), "photoshop");
});

test("records incidents with the script, and skips user stops", async () => {
  recordIncident({ app: 'application "Adobe Illustrator"', kind: "script-error", message: "Target layer cannot be modified (line 3)", script: "var d = app.activeDocument;" });
  await recordFailure('application "Adobe Illustrator"', Object.assign(new Error("Connection is invalid. (-609)")), "app.activeDocument.close()");
  await recordFailure('application "Adobe Illustrator"', new Error("stopped"), "x");
  const rows = readIncidents();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.app, r.kind]), [["illustrator", "script-error"], ["illustrator", "crash"]]);
  assert.match(rows[0].script, /activeDocument/);
  rmSync(dir, { recursive: true, force: true });
});
