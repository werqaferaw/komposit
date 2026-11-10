// Serves the static UI with strict headers. Scripts come only from this site
// (the UI and the agent loop, no third parties). The page may connect only to
// this site, the Komposit app on the visitor's own computer, and the AI
// services it can call with a key kept in the browser: Anthropic, Google
// Gemini, OpenRouter, OpenAI, and Komposit's own gateway (invites, accounts).
// A custom service address runs through the app instead.
const AI_SERVICES = [
  "https://api.anthropic.com",
  "https://generativelanguage.googleapis.com",
  "https://openrouter.ai",
  "https://api.openai.com",
  "https://gateway.komposit.werq.dev",
];
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:", // After Effects previews play from blob: URLs
  `connect-src 'self' http://127.0.0.1:* http://localhost:* ${AI_SERVICES.join(" ")}`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set("content-security-policy", CSP);
    headers.set("x-frame-options", "DENY");
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    headers.set("permissions-policy", "camera=(), microphone=(self), geolocation=()");
    headers.set("strict-transport-security", "max-age=31536000");
    headers.set("cross-origin-opener-policy", "same-origin");
    const type = headers.get("content-type") || "";
    if (type.includes("text/html")) headers.set("cache-control", "no-cache");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
