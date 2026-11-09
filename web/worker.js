// Serves the static UI with strict headers. The only places the page may
// connect to are this site and the Komposit app on the visitor's own Mac.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' blob: data:",
  "connect-src 'self' http://127.0.0.1:* http://localhost:*",
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
    headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    const type = headers.get("content-type") || "";
    if (type.includes("text/html")) headers.set("cache-control", "no-cache");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
