// The skills stay in sync with the connectors' guides: each SKILL.md has valid frontmatter
// and carries its guide verbatim, and skills/build.mjs --check agrees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const apps = readdirSync(join(ROOT, "connectors")).filter((n) => existsSync(join(ROOT, "connectors", n, "guide.md")));

test("every guide has a skill, with frontmatter and the recipes verbatim", () => {
  assert.ok(apps.length >= 3);
  for (const app of apps) {
    const file = join(HERE, app, "SKILL.md");
    assert.ok(existsSync(file), `skills/${app}/SKILL.md is missing: run node skills/build.mjs`);
    const skill = readFileSync(file, "utf8");
    const m = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/.exec(skill);
    assert.ok(m, `${app}: frontmatter`);
    assert.equal(m[1], app, "the name matches the folder");
    assert.match(m[1]!, /^[a-z0-9-]{1,64}$/);
    const description = m[2]!;
    assert.ok(description.startsWith("Use when"), "the description says when to use it");
    assert.ok(description.length <= 1024);
    assert.ok(!/: | #|^[\[{>|*&!%@`'"]/.test(description), "a plain YAML scalar");
    assert.ok(skill.endsWith(readFileSync(join(ROOT, "connectors", app, "guide.md"), "utf8")), `${app}: the recipes are the guide, verbatim`);
    assert.match(skill, /`guide`/);
    assert.match(skill, new RegExp(`app: "${app}"`));
  }
});

test("skills/build.mjs --check finds nothing out of date", () => {
  const out = execFileSync(process.execPath, [join(HERE, "build.mjs"), "--check"], { encoding: "utf8" });
  assert.match(out, /in sync/);
});
