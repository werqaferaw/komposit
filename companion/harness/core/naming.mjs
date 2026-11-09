// Chat titles, the part every AI choice shares: the instruction, the prompt
// built from the first message, and cleaning a reply into a title. Pure: the
// local server (titles.mjs) and the web page name chats the same way.
export const TITLE_MODEL = "claude-haiku-5-5";
export const TIMEOUT_MS = 45_000;

const APP_NAMES = { illustrator: "Illustrator", photoshop: "Photoshop", aftereffects: "After Effects" };

export const SYSTEM =
  "You name chats in a design assistant. Reply with only a short title of 2 to 6 words for what the person " +
  "wants, in sentence case, in the language they wrote in. No quotes, no trailing period, no emoji, no " +
  "\"Title:\" prefix. Name the task, not the app, unless the app is the point.";

export function titlePrompt({ text = "", app = "", files = [] } = {}) {
  const where = APP_NAMES[app] ? `They are working in Adobe ${APP_NAMES[app]}.` : "";
  const att = files.length ? `\nAttached: ${files.slice(0, 6).join(", ")}` : "";
  const msg = String(text).slice(0, 2000);
  return `${where}\nTheir first message:\n"""\n${msg}\n"""${att}\n\nName this chat.`.trim();
}

// Model output -> a clean title, or "" when it isn't usable.
export function cleanTitle(raw) {
  let t = String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) || "";
  t = t
    .replace(/^(chat\s+)?title\s*[:\-]\s*/i, "")
    .replace(/^#+\s*/, "")
    .replace(/[*_`]/g, "")
    .replace(/\p{Extended_Pictographic}|‍|️/gu, "")
    .replace(/^["'“‘«]+|["'”’»]+$/g, "")
    .replace(/[.。]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 80) return t ? t.slice(0, 60).replace(/\s+\S*$/, "") : "";
  return t;
}

