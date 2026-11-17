// JSON-RPC 2.0 over stdin/stdout, one JSON object per line.
//
// Requests are read on the main thread and each one runs on a concurrent queue,
// so a long script in Illustrator never holds up a ping or a window list.
// Replies may therefore come back out of order; the id says which is which.
import Foundation

typealias Params = [String: Any]
typealias Method = (Params) throws -> Any

/// A failure the core shows as a plain sentence. `kind` is the stable name the
/// core branches on; `code` is the JSON-RPC error code that goes with it.
struct HelperError: Error {
  let code: Int
  let kind: String
  let message: String
  var data: [String: Any] = [:]

  static func invalidParams(_ message: String) -> HelperError {
    HelperError(code: -32602, kind: "invalidParams", message: message)
  }
}

/// The error codes this helper uses (server range -32000..-32099), by kind.
enum Codes {
  static let notRunning = -32010
  static let automationDenied = -32011
  static let timeout = -32012
  static let scriptError = -32013
  static let notTrusted = -32014
  static let notFound = -32015
  static let failed = -32016
}

// ---- output -------------------------------------------------------------------

private let outLock = NSLock()

func send(_ message: [String: Any]) {
  let data: Data
  do {
    data = try JSONSerialization.data(withJSONObject: message, options: [.withoutEscapingSlashes])
  } catch {
    // Only reachable if a method returned something that isn't JSON; say so plainly.
    let id = message["id"] ?? NSNull()
    let fallback: [String: Any] = [
      "jsonrpc": "2.0", "id": id,
      "error": ["code": -32603, "message": "The helper produced an answer it couldn't send.", "data": ["kind": "failed"]],
    ]
    send(fallback)
    return
  }
  outLock.lock()
  defer { outLock.unlock() }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
}

func reply(id: Any, result: Any) {
  send(["jsonrpc": "2.0", "id": id, "result": result])
}

func replyError(id: Any, _ e: HelperError) {
  var data = e.data
  data["kind"] = e.kind
  send(["jsonrpc": "2.0", "id": id, "error": ["code": e.code, "message": e.message, "data": data]])
}

func notify(_ method: String, _ params: [String: Any]) {
  send(["jsonrpc": "2.0", "method": method, "params": params])
}

// ---- params ---------------------------------------------------------------------

func optString(_ p: Params, _ key: String) -> String? {
  p[key] as? String
}

func reqString(_ p: Params, _ key: String) throws -> String {
  guard let s = p[key] as? String, !s.isEmpty else { throw HelperError.invalidParams("The request is missing \(key).") }
  return s
}

func optInt(_ p: Params, _ key: String) -> Int? {
  guard let n = p[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
  return n.intValue
}

func reqInt(_ p: Params, _ key: String) throws -> Int {
  guard let n = optInt(p, key) else { throw HelperError.invalidParams("The request is missing \(key).") }
  return n
}

func optBool(_ p: Params, _ key: String) -> Bool? {
  guard let n = p[key] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
  return n.boolValue
}

// ---- dispatch -------------------------------------------------------------------

let work = DispatchQueue(label: "komposit-helper.work", attributes: .concurrent)
let inFlight = DispatchGroup()

func handleLine(_ line: String, methods: [String: Method]) {
  let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty { return }
  guard let raw = trimmed.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: raw, options: []),
        let msg = obj as? [String: Any]
  else {
    replyError(id: NSNull(), HelperError(code: -32700, kind: "parse", message: "The helper couldn't read that message."))
    return
  }
  guard let method = msg["method"] as? String else {
    if let id = msg["id"] { replyError(id: id, HelperError(code: -32600, kind: "invalidRequest", message: "That message isn't a request.")) }
    return
  }
  let id = msg["id"] // nil means a notification: run it, send nothing back
  let params = (msg["params"] as? Params) ?? [:]
  guard let fn = methods[method] else {
    if let id { replyError(id: id, HelperError(code: -32601, kind: "methodNotFound", message: "The helper doesn't know \(method).")) }
    return
  }
  inFlight.enter()
  work.async {
    defer { inFlight.leave() }
    do {
      let result = try fn(params)
      if let id { reply(id: id, result: result) }
    } catch let e as HelperError {
      if let id { replyError(id: id, e) }
    } catch {
      if let id { replyError(id: id, HelperError(code: Codes.failed, kind: "failed", message: error.localizedDescription)) }
    }
  }
}
