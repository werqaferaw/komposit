// `komposit-helper bridge`: how an AI reaches Komposit's toolbox from inside the Mac app.
//
// An AI's own process (Claude Code, Codex) starts it from the MCP config Komposit wrote. It
// speaks MCP's stdio transport (newline-delimited JSON-RPC) on stdin/stdout and relays every
// line to the core over the private local socket, presenting the run's pass first:
//
//   KOMPOSIT_SOCKET  the socket the core serves the toolbox on
//   KOMPOSIT_PASS    this run's pass
//
// It does what bridge/bridge.ts does (development and Windows run that one on Node), with the
// same plain sentences, byte for byte. When the core can't be reached or refuses the pass,
// every request gets a JSON-RPC error whose message is a plain sentence ("Komposit isn't
// running."), and the bridge exits.
//
// Why native: the Mac app's own Electron doesn't run as Node (its RunAsNode fuse is off), so no
// other program can borrow the app's signed identity, and with it the person's Automation
// permission for their creative apps. It is also a few MB per AI turn, where Electron as Node
// was about 40.
//
// How: the main thread reads stdin, a second thread reads the socket; each blocks only in
// read(). What they share sits behind one lock that is never held during I/O. Writes are
// blocking whole lines (looping over partial writes and interruptions), one writer at a time on
// stdout and on the socket, so lines never interleave. Line ends are looked for only in newly
// read bytes, so a 16 MB line costs its length once. The socket is shut down, never closed,
// until the process ends, so no thread can ever write to a reused descriptor.
import Foundation

private let notRunning = "Komposit isn't running."
private let noAnswer = "Komposit isn't answering."
private let stopped = "Komposit stopped before this finished."
/// How long the core gets to answer the pass.
private let connectSeconds = 10.0
/// With nothing to answer, an offline bridge waits this long for a request before it goes.
private let offlineWaitSeconds = 30.0

func runBridge() -> Never {
  signal(SIGPIPE, SIG_IGN) // a closed pipe or socket is a failed write, not the end of the process
  let bridge = Bridge()
  bridge.start()
  bridge.readAI()
}

private final class Bridge {
  private enum State { case connecting, relaying, offline, coreGone }

  // Shared by the threads; `lock` is never held during I/O.
  private let lock = NSLock()
  private var state = State.connecting
  private var offlineMessage = notRunning
  /// Lines from the AI before the core answered the pass (each with its "\n"), and the id of
  /// each one that is a request.
  private var queued: [(line: [UInt8], id: [UInt8]?)] = []
  /// Requests sent to the core and not answered yet: the id as JSON -> the order they were sent.
  private var inflight: [[UInt8]: Int] = [:]
  private var sent = 0
  /// Set once, before relaying starts; shut down (never closed) when the bridge goes offline.
  private var sock: Int32 = -1

  private let outLock = NSLock() // one line at a time to the AI
  private let sockLock = NSLock() // one line at a time to the core; taken before `lock` when both are

  func start() {
    let path = env("KOMPOSIT_SOCKET")
    let pass = env("KOMPOSIT_PASS")
    guard !path.isEmpty, !pass.isEmpty else { return goOffline(notRunning) }
    DispatchQueue.global().asyncAfter(deadline: .now() + connectSeconds) { [self] in goOffline(noAnswer) }
    let reader = Thread { [self] in readCore(path: path, pass: pass) }
    reader.stackSize = 8 << 20 // as the main thread's: parsing a deeply nested line recurses
    reader.start()
  }

  // ---- the AI's side (the main thread) --------------------------------------------------------

  func readAI() -> Never {
    let end = LineReader(fd: 0).run { line, newlineFollows in
      if !isBlank(line) { fromAI(line, newlineFollows) }
      return true
    }
    if end == .eof { halfClose() } // the AI is done: tell the core, then go
    exitBridge()
  }

  private func fromAI(_ line: UnsafeBufferPointer<UInt8>, _ newlineFollows: Bool) {
    let id = requestId(line)
    lock.lock()
    switch state {
    case .connecting:
      queued.append((line: Array(line) + [0x0A], id: id))
      lock.unlock()
    case .relaying:
      // Counted before it is sent, so an answer can never arrive before it is.
      if let id { inflight[id] = sent; sent += 1 }
      lock.unlock()
      sockLock.lock()
      _ = writeLine(sock, line, newlineFollows) // a failure shows on the reading side
      sockLock.unlock()
    case .offline:
      let message = offlineMessage
      lock.unlock()
      if let id { errorReply(id, message); exitBridge() }
    case .coreGone:
      lock.unlock()
      if let id { errorReply(id, stopped) }
    }
  }

  /// The AI closed its input: no more requests, so the core sees the end of them.
  private func halfClose() {
    guard sockLock.lock(before: Date(timeIntervalSinceNow: 2)) else { return }
    lock.lock()
    if state == .relaying { shutdown(sock, SHUT_WR) }
    lock.unlock()
    sockLock.unlock()
  }

  // ---- the core's side (its own thread) --------------------------------------------------------

  private func readCore(path: String, pass: String) {
    let fd = connectUnix(path)
    guard fd >= 0 else { return goOffline(notRunning) }
    lock.lock()
    guard state == .connecting else { lock.unlock(); close(fd); return } // it gave up meanwhile
    sock = fd
    lock.unlock()

    let hello = Array(#"{"komposit_pass":"#.utf8) + jsonString(pass) + Array("}\n".utf8)
    sockLock.lock()
    let passSent = hello.withUnsafeBytes { writeAll(fd, $0.baseAddress!, $0.count) }
    sockLock.unlock()
    guard passSent else { return goOffline(notRunning) }

    var handshaken = false
    _ = LineReader(fd: fd).run { line, newlineFollows in
      if isBlank(line) { return true }
      if handshaken { fromCore(line, newlineFollows); return true }
      handshaken = true
      return answered(line)
    }

    // The socket ended: the core closed it, it failed, or it was shut down here.
    lock.lock()
    let was = state
    lock.unlock()
    if was == .connecting { goOffline(notRunning) }
    else if was == .relaying { coreWentAway() }
  }

  /// The core's first line: the pass is accepted ({"komposit":"ok"}), or not, with a sentence.
  /// True while there is more to read.
  private func answered(_ line: UnsafeBufferPointer<UInt8>) -> Bool {
    var ok = false
    var message = notRunning
    autoreleasepool {
      guard let ack = parseObject(line) else { return }
      ok = (ack["komposit"] as? String) == "ok"
      if let m = ack["message"] as? String, !m.isEmpty { message = m }
    }
    guard ok else { goOffline(message); return false }

    // Relaying from now on. What the AI sent meanwhile goes first, in order: the AI's thread
    // waits for sockLock before it can send anything newer.
    sockLock.lock()
    defer { sockLock.unlock() }
    lock.lock()
    guard state == .connecting else { lock.unlock(); return false } // it gave up first
    state = .relaying
    let lines = queued
    queued = []
    for q in lines { if let id = q.id { inflight[id] = sent; sent += 1 } }
    lock.unlock()
    for q in lines { _ = q.line.withUnsafeBytes { writeAll(sock, $0.baseAddress!, $0.count) } }
    return true
  }

  private func fromCore(_ line: UnsafeBufferPointer<UInt8>, _ newlineFollows: Bool) {
    // An answer (an id and no method) is no longer in flight.
    var answer: [UInt8]?
    autoreleasepool {
      if let msg = parseObject(line), msg["method"] == nil, let id = msg["id"] { answer = jsonValue(id) }
    }
    if let answer { lock.lock(); inflight[answer] = nil; lock.unlock() }
    toAI { writeLine(1, line, newlineFollows) }
  }

  /// The core went away (it quit, or the run was stopped): say so for what's still open.
  private func coreWentAway() {
    lock.lock()
    state = .coreGone
    let open = inflight.sorted { $0.value < $1.value }.map(\.key)
    inflight = [:]
    lock.unlock()
    for id in open { errorReply(id, stopped) }
    exitBridge()
  }

  // ---- offline ---------------------------------------------------------------------------------

  /// No core: every request waiting, and every one after it, gets `message`. Only ever from
  /// connecting, as in the Node bridge (each of its callers checks that first).
  private func goOffline(_ message: String) {
    lock.lock()
    guard state == .connecting else { lock.unlock(); return }
    state = .offline
    offlineMessage = message
    if sock >= 0 { shutdown(sock, SHUT_RDWR) }
    let lines = queued
    queued = []
    lock.unlock()
    var answeredAny = false
    for q in lines { if let id = q.id { errorReply(id, message); answeredAny = true } }
    if answeredAny { exitBridge() }
    DispatchQueue.global().asyncAfter(deadline: .now() + offlineWaitSeconds) { [self] in exitBridge() }
  }

  // ---- output ----------------------------------------------------------------------------------

  private func errorReply(_ id: [UInt8], _ message: String) {
    // As JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) writes it.
    let reply = Array(#"{"jsonrpc":"2.0","id":"#.utf8) + id + Array(#","error":{"code":-32000,"message":"#.utf8)
      + jsonString(message) + Array("}}\n".utf8)
    toAI { reply.withUnsafeBytes { writeAll(1, $0.baseAddress!, $0.count) } }
  }

  /// One whole line to the AI. If it went away (a broken pipe), so does the bridge, at once.
  private func toAI(_ write: () -> Bool) {
    outLock.lock()
    let ok = write()
    outLock.unlock()
    if !ok { _exit(0) }
  }

  private func exitBridge() -> Never {
    // A line another thread is writing gets to finish (2 s at most, as the Node bridge waits for
    // stdout to drain).
    _ = outLock.lock(before: Date(timeIntervalSinceNow: 2))
    _exit(0)
  }
}

// ---- lines ------------------------------------------------------------------------------------

/// Reads a descriptor and hands over each complete line, without its "\n" and one trailing
/// "\r". Line ends are looked for only in newly read bytes; what is left of a line moves to the
/// front of the buffer once per read at most, so a line of n bytes costs O(n).
private final class LineReader {
  enum End { case eof, failed, stopped }

  private let fd: Int32
  private var buf: UnsafeMutablePointer<UInt8>
  private var cap: Int
  private var len = 0
  private static let initial = 256 << 10
  private static let minRead = 64 << 10

  init(fd: Int32) {
    self.fd = fd
    cap = LineReader.initial
    buf = .allocate(capacity: cap)
  }

  deinit { buf.deallocate() }

  /// `line` gets the line and whether its "\n" follows it directly (no "\r" was dropped), so it
  /// can be passed on in one write. It returns false to stop reading.
  func run(_ line: (UnsafeBufferPointer<UInt8>, Bool) -> Bool) -> End {
    while true {
      if cap - len < LineReader.minRead { resize(cap * 2) }
      let n = read(fd, buf + len, cap - len)
      if n == 0 { return .eof }
      if n < 0 {
        if errno == EINTR { continue }
        if errno == EAGAIN { waitFor(fd, POLLIN); continue }
        return .failed
      }
      var start = 0
      var from = len // only the new bytes
      len += n
      while from < len, let hit = memchr(buf + from, 0x0A, len - from) {
        let nl = hit.assumingMemoryBound(to: UInt8.self) - buf
        var end = nl
        if end > start, buf[end - 1] == 0x0D { end -= 1 }
        if !line(UnsafeBufferPointer(start: buf + start, count: end - start), end == nl) { return .stopped }
        start = nl + 1
        from = start
      }
      if start > 0 {
        len -= start
        if len > 0 { memmove(buf, buf + start, len) }
        // After a very long line, give the memory back.
        if cap > 4 * LineReader.initial, len < LineReader.initial / 2 { resize(LineReader.initial) }
      }
    }
  }

  private func resize(_ size: Int) {
    let bigger = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
    bigger.update(from: buf, count: len)
    buf.deallocate()
    buf = bigger
    cap = size
  }
}

/// Is this line empty to JavaScript's trim() (the Node bridge skips those)? ASCII space, tab,
/// \n, \v, \f, \r, and in UTF-8: U+00A0, U+1680, U+2000-200A, U+2028, U+2029, U+202F, U+205F,
/// U+3000, U+FEFF.
private func isBlank(_ b: UnsafeBufferPointer<UInt8>) -> Bool {
  var i = 0
  let n = b.count
  while i < n {
    let c = b[i]
    if c == 0x20 || (0x09...0x0D).contains(c) { i += 1; continue }
    let c1: UInt8 = i + 1 < n ? b[i + 1] : 0
    let c2: UInt8 = i + 2 < n ? b[i + 2] : 0
    if c == 0xC2, c1 == 0xA0 { i += 2; continue }
    let three = (c == 0xE1 && c1 == 0x9A && c2 == 0x80)
      || (c == 0xE2 && c1 == 0x80 && ((0x80...0x8A).contains(c2) || c2 == 0xA8 || c2 == 0xA9 || c2 == 0xAF))
      || (c == 0xE2 && c1 == 0x81 && c2 == 0x9F)
      || (c == 0xE3 && c1 == 0x80 && c2 == 0x80)
      || (c == 0xEF && c1 == 0xBB && c2 == 0xBF)
    if three { i += 3; continue }
    return false
  }
  return true
}

/// Writes all of it: through partial writes, interruptions and a non-blocking descriptor.
private func writeAll(_ fd: Int32, _ p: UnsafeRawPointer, _ n: Int) -> Bool {
  var done = 0
  while done < n {
    let w = write(fd, p + done, n - done)
    if w > 0 { done += w; continue }
    if w < 0, errno == EINTR { continue }
    if w < 0, errno == EAGAIN { waitFor(fd, POLLOUT); continue }
    return false
  }
  return true
}

/// The line and its "\n": straight from the read buffer when the "\n" follows it there.
private func writeLine(_ fd: Int32, _ line: UnsafeBufferPointer<UInt8>, _ newlineFollows: Bool) -> Bool {
  let p = UnsafeRawPointer(line.baseAddress!)
  if newlineFollows { return writeAll(fd, p, line.count + 1) }
  var nl: UInt8 = 0x0A
  return writeAll(fd, p, line.count) && writeAll(fd, &nl, 1)
}

private func waitFor(_ fd: Int32, _ events: Int32) {
  var p = pollfd(fd: fd, events: Int16(events), revents: 0)
  while poll(&p, 1, -1) < 0, errno == EINTR {}
}

// ---- the socket -------------------------------------------------------------------------------

/// A connected Unix socket, or -1.
private func connectUnix(_ path: String) -> Int32 {
  var addr = sockaddr_un()
  let bytes = Array(path.utf8)
  guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return -1 } // too long for a socket
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { return -1 }
  var on: Int32 = 1
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
  addr.sun_family = sa_family_t(AF_UNIX)
  withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: bytes) } // zero-filled: ends in NUL
  let size = socklen_t(MemoryLayout<sockaddr_un>.size)
  addr.sun_len = UInt8(size)
  let r = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) } }
  if r != 0 { close(fd); return -1 }
  return fd
}

private func env(_ name: String) -> String {
  guard let v = getenv(name) else { return "" }
  return String(cString: v)
}

// ---- JSON ------------------------------------------------------------------------------------

/// The line as a JSON object, or nil (not JSON, or not an object). Call inside an
/// autoreleasepool: Foundation's parser leaves objects for it.
private func parseObject(_ line: UnsafeBufferPointer<UInt8>) -> [String: Any]? {
  guard let base = line.baseAddress, line.count > 0 else { return nil }
  let data = Data(bytesNoCopy: UnsafeMutableRawPointer(mutating: base), count: line.count, deallocator: .none)
  return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

/// A request's id as JSON, or nil when the line isn't a request (a string `method` and an id
/// that isn't null), exactly as the Node bridge decides.
private func requestId(_ line: UnsafeBufferPointer<UInt8>) -> [UInt8]? {
  autoreleasepool {
    guard let msg = parseObject(line), msg["method"] is String, let id = msg["id"], !(id is NSNull) else { return nil }
    return jsonValue(id)
  }
}

/// A value as JSON.stringify writes it, for ids: strings and numbers exactly; true, false, null;
/// anything else (JSON-RPC allows no other id) in Foundation's spelling.
private func jsonValue(_ v: Any) -> [UInt8] {
  if v is NSNull { return Array("null".utf8) }
  if let s = v as? String { return jsonString(s) }
  if let n = v as? NSNumber {
    if CFGetTypeID(n) == CFBooleanGetTypeID() { return Array((n.boolValue ? "true" : "false").utf8) }
    let type = String(cString: n.objCType)
    guard type == "d" || type == "f" else { return Array(n.stringValue.utf8) }
    let d = n.doubleValue
    if !d.isFinite { return Array("null".utf8) }
    if d == d.rounded(.towardZero), abs(d) < 9.007199254740992e15 { return Array(String(Int64(d)).utf8) } // 1.0 is 1, as in JavaScript
    return Array("\(d)".utf8)
  }
  if let d = try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed, .withoutEscapingSlashes]) { return Array(d) }
  return Array("null".utf8)
}

/// A string as JSON.stringify writes it: UTF-16 code units in, UTF-8 out; \" \\ \b \f \n \r \t,
/// other control characters and lone surrogates as lowercase \u escapes, the rest as is.
private func jsonString(_ s: String) -> [UInt8] {
  let units = Array(s.utf16)
  let hex = Array("0123456789abcdef".utf8)
  var out: [UInt8] = [0x22]
  out.reserveCapacity(units.count + 2)
  func escaped(_ u: UInt16) {
    out += [0x5C, 0x75, hex[Int(u >> 12)], hex[Int((u >> 8) & 0xF)], hex[Int((u >> 4) & 0xF)], hex[Int(u & 0xF)]]
  }
  var i = 0
  while i < units.count {
    let u = units[i]
    switch u {
    case 0x22: out += [0x5C, 0x22]
    case 0x5C: out += [0x5C, 0x5C]
    case 0x08: out += [0x5C, 0x62]
    case 0x0C: out += [0x5C, 0x66]
    case 0x0A: out += [0x5C, 0x6E]
    case 0x0D: out += [0x5C, 0x72]
    case 0x09: out += [0x5C, 0x74]
    case 0..<0x20: escaped(u)
    case 0x20..<0x80: out.append(UInt8(u))
    case 0x80..<0x800: out += [UInt8(0xC0 | (u >> 6)), UInt8(0x80 | (u & 0x3F))]
    case 0xD800..<0xDC00 where i + 1 < units.count && (0xDC00..<0xE000).contains(units[i + 1]):
      let c = 0x10000 + ((UInt32(u) - 0xD800) << 10) + (UInt32(units[i + 1]) - 0xDC00)
      out += [UInt8(0xF0 | (c >> 18)), UInt8(0x80 | ((c >> 12) & 0x3F)), UInt8(0x80 | ((c >> 6) & 0x3F)), UInt8(0x80 | (c & 0x3F))]
      i += 1
    case 0xD800..<0xE000: escaped(u) // a lone surrogate
    default: out += [UInt8(0xE0 | (u >> 12)), UInt8(0x80 | ((u >> 6) & 0x3F)), UInt8(0x80 | (u & 0x3F))]
    }
    i += 1
  }
  out.append(0x22)
  return out
}
