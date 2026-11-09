// AI chat titles: the model's reply is cleaned into a short title, and the
// prompt carries the app and attachments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTitle, titlePrompt, nameChat } from "../titles.mjs";

test("cleans model replies into a title", () => {
  assert.equal(cleanTitle("Resize and recolor the logo"), "Resize and recolor the logo");
  assert.equal(cleanTitle('"Resize the logo."'), "Resize the logo");
  assert.equal(cleanTitle("Title: Poster headline glow"), "Poster headline glow");
  assert.equal(cleanTitle("**Fade in the title**\n\nThis names the task."), "Fade in the title");
  assert.equal(cleanTitle("\n  Vignette and white headline  \n"), "Vignette and white headline");
  assert.equal(cleanTitle("Logo glow ✨"), "Logo glow");
  assert.equal(cleanTitle("ሎጎውን አሳድግ"), "ሎጎውን አሳድግ");
  assert.equal(cleanTitle(""), "");
  assert.equal(cleanTitle(null), "");
  assert.ok(cleanTitle("word ".repeat(40)).length <= 60);
});

test("the prompt names the app and attachments", () => {
  const p = titlePrompt({ text: "make it pop", app: "aftereffects", files: ["brief.pdf"] });
  assert.match(p, /Adobe After Effects/);
  assert.match(p, /make it pop/);
  assert.match(p, /brief\.pdf/);
});

test("no AI, or nothing to name: no title, no throw", async () => {
  assert.equal(await nameChat(null, { text: "hello" }), "");
  assert.equal(await nameChat({ mode: "claude-code" }, { text: "  " }), "");
  assert.equal(await nameChat({ mode: "openai", openai: {} }, { text: "hello" }), "");
});
