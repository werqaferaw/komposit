// An AI plan's usage limit, said the same way by the core (the record, the notification) and the
// window (which says "has reset" once the time has passed). Plain JavaScript: no Node, no DOM.

const WHO: Record<string, string> = { "claude-code": "Claude", codex: "ChatGPT" };

/** The plan's name, as people say it: "Claude", "ChatGPT". */
export const limitWho = (ai: string | undefined): string => WHO[String(ai || "")] || "Your AI";

/** When it resets, in this computer's time: "at 11:20", "tomorrow at 09:00", "on Friday at 15:00". */
export function resetWords(resetsAt: number, now = Date.now(), locale?: string): string {
  const d = new Date(resetsAt), n = new Date(now);
  const time = d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(n)) return `at ${time}`;
  const next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
  if (day(d) === day(next)) return `tomorrow at ${time}`;
  if (resetsAt - now < 6 * 86_400_000) return `on ${d.toLocaleDateString(locale, { weekday: "long" })} at ${time}`;
  return `on ${d.toLocaleDateString(locale, { month: "long", day: "numeric" })} at ${time}`;
}

/** "Claude's limit resets at 11:20." / "Claude's limit has reset." / without a time, "for now". */
export function limitSentence(ai: string | undefined, resetsAt?: number, now = Date.now()): string {
  const who = limitWho(ai);
  const whose = who === "Your AI" ? "Your AI plan's limit" : `${who}'s limit`;
  if (!resetsAt || !Number.isFinite(resetsAt)) return `${whose} is used up for now.`;
  if (resetsAt <= now) return `${whose} has reset.`;
  return `${whose} resets ${resetWords(resetsAt, now)}.`;
}
