// The macOS platform layer's pure parts. These run on any OS. A real After
// Effects on a Mac is covered by aftereffects.live.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as mac from "../platform/mac.mjs";

const AE = (year, base = "/Applications") =>
  `${base}/Adobe After Effects ${year}/Adobe After Effects ${year}.app/Contents/MacOS/After Effects`;

test("After Effects on a Mac: the version that's open, not a fixed year", () => {
  // `ps -axo comm=` lines: After Effects 2025 open, with its helpers.
  const ps = [
    "/sbin/launchd",
    "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
    AE(2025),
    "/Applications/Adobe After Effects 2025/Adobe After Effects Render Engine 2025.app/Contents/MacOS/After Effects Render Engine",
    "/Applications/Adobe After Effects 2025/Adobe After Effects 2025.app/Contents/MacOS/CEPHtmlEngine.app/Contents/MacOS/CEPHtmlEngine",
    "/Applications/Adobe After Effects 2025/Adobe After Effects 2025.app/Contents/MacOS/dynamiclinkmanager",
  ].join("\n");
  assert.deepEqual(mac.parseRunningAe(ps), ["Adobe After Effects 2025"]);

  // The Render Engine on its own isn't After Effects.
  assert.deepEqual(
    mac.parseRunningAe("/Applications/Adobe After Effects 2026/Adobe After Effects Render Engine 2026.app/Contents/MacOS/After Effects Render Engine"),
    [],
  );
  // Another install folder, two versions open at once: the newest first.
  assert.deepEqual(mac.parseRunningAe(`${AE(2024)}\n${AE(2026, "/Volumes/Apps")}  \n`), [
    "Adobe After Effects 2026",
    "Adobe After Effects 2024",
  ]);
  assert.deepEqual(mac.parseRunningAe(""), []);

  // The AppleScript target: AE_APP, else the one that's open, else the bundle id.
  assert.equal(mac.targetForAe({ running: ["Adobe After Effects 2025"] }), 'application "Adobe After Effects 2025"');
  assert.equal(
    mac.targetForAe({ envName: "Adobe After Effects (Beta)", running: ["Adobe After Effects 2025"] }),
    'application "Adobe After Effects (Beta)"',
  );
  assert.equal(mac.targetForAe({}), 'application id "com.adobe.AfterEffects.application"');
  assert.equal(mac.BUNDLE_IDS.aftereffects, "com.adobe.AfterEffects.application");

  // Labels in messages: no process lookup, the other apps unchanged.
  assert.equal(mac.target("aftereffects"), mac.targetForAe({ envName: process.env.AE_APP }));
  assert.equal(mac.target("illustrator"), 'application "Adobe Illustrator"');
  assert.equal(mac.target("photoshop"), 'application id "com.adobe.Photoshop"');
});
