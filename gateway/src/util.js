// Small helpers shared by the gateway's modules. No dependencies.

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567"; // RFC 4648 alphabet, lowercase

/** `length` random lowercase base32 characters (5 bits each). */
export function randomBase32(length) {
  // 256 is a multiple of 32, so taking the low 5 bits of each byte is unbiased.
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => BASE32[byte & 31]).join("");
}

/** `bytes` random bytes as unpadded base64url (43 characters for 32 bytes). */
export function randomBase64url(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function base64url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecodeText(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export async function sha256(text) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

export async function sha256Hex(text) {
  return Array.from(new Uint8Array(await sha256(text)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two strings (their lengths are not secret here). */
export function sameString(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseJson(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function nonNegativeInt(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

export function splitList(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/** Errors in the Anthropic API's shape, so the SDK maps them to its typed error classes. */
export function apiError(status, type, message, extraHeaders) {
  return json({ type: "error", error: { type, message } }, status, extraHeaders);
}

export function errorSummary(err) {
  return `${err?.name || "Error"}: ${String(err?.message ?? err).slice(0, 200)}`;
}

export function log(level, entry) {
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
