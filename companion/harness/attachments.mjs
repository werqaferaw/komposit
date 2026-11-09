// Files the person attached to a message (any type: images, PDFs, design
// files, text, fonts, footage). They're saved with the chat; the model gets a
// short list with full paths so it can place, open or import them in the app,
// and the contents of small text files inline so it can read them directly.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import platform from "../platform/index.mjs";

// "this Mac" / "this computer": the model reads it, the person doesn't.
const HERE = platform.name === "mac" ? "this Mac" : "this computer";

const TEXT = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".html", ".htm", ".css", ".xml", ".yaml", ".yml", ".rtf"]);
const KIND = {
  ".ai": "Illustrator file", ".eps": "EPS", ".pdf": "PDF", ".svg": "SVG", ".psd": "Photoshop file", ".psb": "Photoshop file",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image", ".tif": "image", ".tiff": "image", ".heic": "image",
  ".aep": "After Effects project", ".mp4": "video", ".mov": "video", ".wav": "audio", ".mp3": "audio", ".aif": "audio",
  ".otf": "font", ".ttf": "font", ".woff": "font", ".woff2": "font",
};
const MAX_INLINE = 60_000;

function size(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export function filesBlock(files = []) {
  if (!files.length) return "";
  const lines = files.map((f) => {
    const ext = extname(f.name).toLowerCase();
    const kind = TEXT.has(ext) ? "text" : KIND[ext] || (f.media_type || "file");
    return `- ${f.name} (${kind}, ${size(f.size)}): ${f.path}`;
  });
  const inline = files
    .filter((f) => TEXT.has(extname(f.name).toLowerCase()) && f.size <= MAX_INLINE)
    .map((f) => {
      let body = "";
      try {
        body = readFileSync(f.path, "utf8");
      } catch {}
      return body ? `\n--- ${f.name} ---\n${body}\n--- end of ${f.name} ---` : "";
    })
    .join("");
  return `[Attached files, saved on ${HERE}. Place, open or import them in the app by these paths]\n${lines.join("\n")}${inline}\n\n`;
}
