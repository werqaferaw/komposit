// Komposit's door into Premiere Pro (a hidden CEP extension).
//
// Premiere takes ExtendScript only from inside the app, so this extension starts with
// Premiere and opens a small HTTP server on 127.0.0.1. Komposit POSTs ExtendScript to
// /eval; the script runs in Premiere through CEP's evalScript, and its value comes back
// as the response. GET /status answers without touching Premiere.
//
// Finding it and trusting it: on start it picks a free port and a random token and writes
// both to premiere-panel.json in the "dev.werq.komposit" folder of the person's application
// data (readable by this user only). Every request must carry that token; requests from a
// web page (anything with an Origin header) or for another host name are refused.
//
// Its id (dev.werq.komposit.premiere) is the one Komposit 1.0's panel had: installing this
// replaces that copy (version 0.1.0, which wrote premiere-bridge.json in 1.0's folder), so
// VERSION (and the manifest's) must stay above 0.1.0 for an old copy to read as out of date.
//
// Written for the oldest CEP this targets (CEP 9, Premiere Pro 2020: Node 8).
(function () {
  "use strict";
  var req = typeof require === "function" ? require : (window.cep_node && window.cep_node.require);
  if (!req) return; // Node is off: nothing we can do from here.
  var http = req("http");
  var fs = req("fs");
  var path = req("path");
  var os = req("os");
  var crypto = req("crypto");

  var VERSION = "0.2.0";
  var MAX_BODY = 8 * 1024 * 1024;
  var FOLDER = "dev.werq.komposit";

  function dataDir() {
    if (process.platform === "win32") {
      return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), FOLDER);
    }
    return path.join(os.homedir(), "Library", "Application Support", FOLDER);
  }
  var DIR = dataDir();
  var INFO = path.join(DIR, "premiere-panel.json");
  var LOG = path.join(DIR, "premiere-panel.log");

  // Make the folder and any parents (Node 8 has no { recursive: true }).
  function ensureDir(dir) {
    if (fs.existsSync(dir)) return;
    var parent = path.dirname(dir);
    if (parent && parent !== dir) ensureDir(parent);
    try { fs.mkdirSync(dir); } catch (e) { if (!fs.existsSync(dir)) throw e; }
  }

  function log(msg) {
    try {
      ensureDir(DIR);
      try { if (fs.statSync(LOG).size > 512 * 1024) fs.writeFileSync(LOG, ""); } catch (e) {}
      fs.appendFileSync(LOG, new Date().toISOString() + " " + msg + "\n");
    } catch (e) {}
  }

  function hostInfo() {
    try {
      var env = JSON.parse(window.__adobe_cep__.getHostEnvironment());
      return { appName: env.appName, appVersion: env.appVersion };
    } catch (e) {
      return {};
    }
  }

  function evalScript(script) {
    return new Promise(function (resolve) {
      try {
        window.__adobe_cep__.evalScript(script, function (res) { resolve(res); });
      } catch (e) {
        resolve("EvalScript error. " + (e && e.message ? e.message : String(e)));
      }
    });
  }

  var token = crypto.randomBytes(24).toString("hex");
  var host = hostInfo();
  var port = 0;

  function tokenOk(t) {
    if (typeof t !== "string" || t.length !== token.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token)); } catch (e) { return false; }
  }

  // Only "127.0.0.1:<port>" or "localhost:<port>": a page that points another name at this
  // computer (DNS rebinding) is refused before the token is even looked at.
  function hostOk(h) {
    return h === "127.0.0.1:" + port || h === "localhost:" + port;
  }

  function send(res, code, obj) {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  }

  var server = http.createServer(function (rq, res) {
    // A web page can reach 127.0.0.1 too; it always sends an Origin. Komposit doesn't.
    if (rq.headers.origin) return send(res, 403, { ok: false, error: "forbidden" });
    if (!hostOk(rq.headers.host)) return send(res, 403, { ok: false, error: "forbidden" });
    if (!tokenOk(rq.headers["x-komposit-token"])) return send(res, 401, { ok: false, error: "bad token" });

    if (rq.method === "GET" && rq.url === "/status") {
      return send(res, 200, { ok: true, bridge: VERSION, host: host, pid: process.pid });
    }
    if (rq.method === "POST" && rq.url === "/eval") {
      var chunks = [], size = 0, tooBig = false;
      rq.on("data", function (c) {
        size += c.length;
        if (size > MAX_BODY) { tooBig = true; return; }
        chunks.push(c);
      });
      rq.on("end", function () {
        if (tooBig) return send(res, 413, { ok: false, error: "script too large" });
        var body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { return send(res, 400, { ok: false, error: "bad json" }); }
        if (!body || typeof body.script !== "string") return send(res, 400, { ok: false, error: "no script" });
        var t0 = Date.now();
        evalScript(body.script).then(function (result) {
          send(res, 200, { ok: true, result: result, ms: Date.now() - t0 });
        });
      });
      rq.on("error", function () {});
      return;
    }
    send(res, 404, { ok: false, error: "not found" });
  });

  // A script may run for minutes (an export): never close a quiet connection.
  server.setTimeout(0);
  server.on("error", function (e) { log("server error: " + (e && e.message)); });

  server.listen(0, "127.0.0.1", function () {
    port = server.address().port;
    try {
      ensureDir(DIR);
      var tmp = INFO + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ port: port, token: token, pid: process.pid, bridge: VERSION, host: host, startedAt: new Date().toISOString() }), { mode: 384 });
      fs.renameSync(tmp, INFO);
      log("listening on 127.0.0.1:" + port + " (" + (host.appName || "?") + " " + (host.appVersion || "?") + ")");
    } catch (e) {
      log("could not write " + INFO + ": " + (e && e.message));
    }
  });

  // Best effort: forget the address when Premiere closes the extension.
  window.addEventListener("unload", function () {
    try {
      var cur = JSON.parse(fs.readFileSync(INFO, "utf8"));
      if (cur.token === token) fs.unlinkSync(INFO);
    } catch (e) {}
    try { server.close(); } catch (e) {}
  });
})();
