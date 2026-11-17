// An app guide is a Markdown file (connectors/<app>/guide.md): a "# " title, a short
// intro, then one "## " section per topic. The recipes are 1.0's guidance, verbatim.
// guide() with no topic serves the index; with a topic, that section; "all" serves it all.
import { readFileSync } from "node:fs";

export interface GuideSection {
  slug: string;
  heading: string;
  body: string;
}

export interface Guide {
  title: string;
  intro: string;
  sections: GuideSection[];
}

export function slugify(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseGuide(md: string): Guide {
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  let title = "";
  const intro: string[] = [];
  const sections: GuideSection[] = [];
  let cur: { heading: string; body: string[] } | null = null;
  for (const line of lines) {
    if (!title && line.startsWith("# ")) {
      title = line.slice(2).trim();
      continue;
    }
    const h = /^## (.+)$/.exec(line);
    if (h) {
      if (cur) sections.push({ slug: slugify(cur.heading), heading: cur.heading, body: cur.body.join("\n").trim() });
      cur = { heading: h[1].trim(), body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
    else intro.push(line);
  }
  if (cur) sections.push({ slug: slugify(cur.heading), heading: cur.heading, body: cur.body.join("\n").trim() });
  return { title, intro: intro.join("\n").trim(), sections };
}

function find(g: Guide, topic: string): GuideSection | undefined {
  const t = slugify(topic);
  if (!t) return undefined;
  return (
    g.sections.find((s) => s.slug === t) ||
    g.sections.find((s) => s.slug.startsWith(t) || t.startsWith(s.slug)) ||
    g.sections.find((s) => s.slug.includes(t)) ||
    g.sections.find((s) => t.split("-").every((w) => s.body.toLowerCase().includes(w)))
  );
}

const firstLine = (s: string) => {
  const l = s.split("\n").find((x) => x.trim()) || "";
  const t = l.replace(/^-\s*/, "").trim();
  return t.length > 110 ? t.slice(0, 109).trimEnd() + "…" : t;
};

/** The index, one section, or everything ("all"). */
export function serveGuide(g: Guide, topic?: string): string {
  const t = String(topic || "").trim();
  if (!t || t === "index") {
    const list = g.sections.map((s) => `- ${s.slug}: ${firstLine(s.body)}`).join("\n");
    return `${g.title}\n${g.intro ? `\n${g.intro}\n` : ""}\nTopics (ask the guide for one by name, or "all"):\n${list}`;
  }
  if (t === "all") return [g.title, g.intro, ...g.sections.map((s) => `## ${s.heading}\n${s.body}`)].filter(Boolean).join("\n\n");
  const s = find(g, t);
  if (!s) return `This guide has no section on "${t}". Its topics: ${g.sections.map((x) => x.slug).join(", ")}.`;
  return `${g.title}: ${s.heading}\n\n${s.body}`;
}

/** Loads a guide.md next to a connector, once. */
export function guideLoader(url: URL): (topic?: string) => Promise<string> {
  let g: Guide | null = null;
  return async (topic) => {
    if (!g) g = parseGuide(readFileSync(url, "utf8"));
    return serveGuide(g, topic);
  };
}
