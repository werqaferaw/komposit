// A stand-in for Google's OAuth 2.0 / OpenID Connect endpoints, for testing the
// gateway's sign-in without a Google account or network access.
//
//   GET  /o/oauth2/v2/auth  checks the authorize URL the way Google does (client
//                           id, registered redirect_uri, response_type, scope,
//                           PKCE S256), then sends the browser back to
//                           redirect_uri with ?code&state, or ?error=access_denied&state
//   POST /token             exchanges a code once: checks the client id and
//                           secret, the redirect_uri and the PKCE verifier, and
//                           answers with a crafted (unsigned) id_token
//
// The test plays the browser. It picks who signs in by adding mock_identity
// (base64url JSON) to the authorize URL the gateway produced:
//   { sub, email, email_verified, name }   the Google account
//   { deny: true }                          the person clicks Cancel
//   { claims: { nonce, aud, iss, exp } }    tamper with the id_token
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

export const GOOGLE_ISSUER = "https://accounts.google.com";

export async function startMockGoogle({ clientId, clientSecret, redirectUris = [], host = "127.0.0.1", port = 0 }) {
  const registered = new Set(redirectUris);
  const codes = new Map();
  const authorizeCalls = [];
  const tokenCalls = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`);
    if (req.method === "GET" && url.pathname === "/o/oauth2/v2/auth") return authorize(url, res);
    if (req.method === "POST" && url.pathname === "/token") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => token(req, Buffer.concat(chunks).toString("utf8"), res));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  });

  function authorize(url, res) {
    const params = Object.fromEntries(url.searchParams);
    const problems = [];
    if (params.client_id !== clientId) problems.push("invalid_client");
    if (!registered.has(params.redirect_uri)) problems.push("redirect_uri_mismatch");
    if (params.response_type !== "code") problems.push("unsupported_response_type");
    if (!/(^| )openid( |$)/.test(params.scope || "")) problems.push("invalid_scope");
    if (params.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge || "")) {
      problems.push("invalid_request: PKCE");
    }
    authorizeCalls.push({ params, problems });
    if (problems.length) {
      res.writeHead(400, { "content-type": "text/plain" }).end(`Error 400: ${problems.join(", ")}`);
      return;
    }

    const identity = params.mock_identity ? JSON.parse(Buffer.from(params.mock_identity, "base64url").toString("utf8")) : {};
    const back = new URL(params.redirect_uri);
    if (params.state !== undefined) back.searchParams.set("state", params.state);
    if (identity.deny) {
      back.searchParams.set("error", "access_denied");
    } else {
      const code = `4/0Mock${randomBytes(24).toString("base64url")}`;
      codes.set(code, { redirectUri: params.redirect_uri, challenge: params.code_challenge, nonce: params.nonce, identity, used: false });
      back.searchParams.set("code", code);
      back.searchParams.set("scope", "email profile openid");
    }
    res.writeHead(302, { location: back.toString() }).end();
  }

  function token(req, raw, res) {
    const params = Object.fromEntries(new URLSearchParams(raw));
    const call = { params, contentType: req.headers["content-type"], status: null, error: null, idToken: null, code: params.code };
    tokenCalls.push(call);
    const fail = (error, status = 400) => {
      call.status = status;
      call.error = error;
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error, error_description: `mock: ${error}` }));
    };
    if (params.grant_type !== "authorization_code") return fail("unsupported_grant_type");
    if (params.client_id !== clientId || params.client_secret !== clientSecret) return fail("invalid_client", 401);
    const entry = codes.get(params.code);
    if (!entry || entry.used) return fail("invalid_grant");
    entry.used = true; // a code works once, as at Google
    if (params.redirect_uri !== entry.redirectUri) return fail("redirect_uri_mismatch");
    const challenge = createHash("sha256").update(params.code_verifier || "", "utf8").digest("base64url");
    if (challenge !== entry.challenge) return fail("invalid_grant"); // the PKCE verifier doesn't match

    const now = Math.floor(Date.now() / 1000);
    const { identity } = entry;
    const claims = {
      iss: GOOGLE_ISSUER,
      azp: clientId,
      aud: clientId,
      sub: identity.sub ?? "100000000000000000000",
      email: identity.email,
      email_verified: identity.email_verified ?? true,
      at_hash: randomBytes(16).toString("base64url"),
      nonce: entry.nonce,
      name: identity.name,
      iat: now,
      exp: now + 3600,
      ...identity.claims,
    };
    for (const key of Object.keys(claims)) if (claims[key] === undefined) delete claims[key];
    const segment = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    call.idToken = [segment({ alg: "RS256", kid: "mock-key", typ: "JWT" }), segment(claims), randomBytes(256).toString("base64url")].join(".");
    call.status = 200;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(
      JSON.stringify({
        access_token: `ya29.mock-${randomBytes(16).toString("hex")}`,
        expires_in: 3599,
        scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
        token_type: "Bearer",
        id_token: call.idToken,
      }),
    );
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const base = `http://${host}:${server.address().port}`;

  return {
    authUrl: `${base}/o/oauth2/v2/auth`,
    tokenUrl: `${base}/token`,
    authorizeCalls,
    tokenCalls,
    lastTokenCall: () => tokenCalls[tokenCalls.length - 1],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
