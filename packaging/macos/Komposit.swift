// Komposit.app: the menu-bar half of Komposit on a tester's Mac.
//
// It starts the bundled Node server (Contents/MacOS/node running
// Contents/Resources/app/companion/server.mjs), keeps it alive, and opens the
// UI in the browser. Because the server is our child process, macOS
// attributes its permission prompts (controlling Adobe apps, reading the
// Desktop) to Komposit.
import Cocoa
import ServiceManagement

let PORTS = Array(4321...4330)
let CHROMIUM = ["com.google.Chrome", "com.google.Chrome.canary", "com.google.Chrome.beta", "com.brave.Browser",
                "com.microsoft.edgemac", "company.thebrowser.Browser", "com.vivaldi.Vivaldi",
                "com.operasoftware.Opera", "org.chromium.Chromium", "org.mozilla.firefox"]

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private var statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
  private var loginItem = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
  private var server: Process?
  private var port: Int?
  private var attached = false        // using a server that was already running
  private var quitting = false
  private var restarts: [Date] = []
  // Test switches: KOMPOSIT_NO_BROWSER=1 never opens the browser on its own;
  // KOMPOSIT_SPAWN=1 starts this app's server even if another one is running.
  private let env = ProcessInfo.processInfo.environment
  private lazy var openWhenReady = env["KOMPOSIT_NO_BROWSER"] != "1"
  private var logHandle: FileHandle?
  private var lineBuffer = ""

  private let logDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Komposit")
  private var logURL: URL { logDir.appendingPathComponent("server.log") }
  private let dataDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Komposit")

  // The hosted UI, if this build points at one (Info.plist KompositWebURL).
  private var webURL: String? {
    let v = (Bundle.main.object(forInfoDictionaryKey: "KompositWebURL") as? String) ?? ""
    return v.isEmpty ? nil : v
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()
    startOrAttach()
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    openUI()
    return false
  }

  func applicationWillTerminate(_ notification: Notification) {
    quitting = true
    stopServer(wait: true)
  }

  // MARK: menu

  private func buildMenu() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    statusItem.button?.image = Self.menuIcon()
    statusItem.button?.toolTip = "Komposit"
    let menu = NSMenu()
    menu.addItem(withTitle: "Open Komposit", action: #selector(openUIAction), keyEquivalent: "o")
    menu.addItem(.separator())
    statusLine.isEnabled = false
    menu.addItem(statusLine)
    menu.addItem(withTitle: "Restart", action: #selector(restartAction), keyEquivalent: "r")
    menu.addItem(withTitle: "Show Log", action: #selector(showLog), keyEquivalent: "")
    menu.addItem(withTitle: "Show Data Folder", action: #selector(showData), keyEquivalent: "")
    menu.addItem(.separator())
    menu.addItem(loginItem)
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit Komposit", action: #selector(quitAction), keyEquivalent: "q")
    for item in menu.items { item.target = self }
    statusItem.menu = menu
    refreshLoginItem()
  }

  // The Komposit mark (04.C solid tile, arrow knocked out), drawn as a
  // template so it follows the menu bar's light/dark appearance.
  static func menuIcon() -> NSImage {
    let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { r in
      let mark = kompositTile(in: r.insetBy(dx: 1.5, dy: 1.5))
      let p = mark.tile
      p.append(mark.arrow)
      p.windingRule = .evenOdd
      NSColor.black.setFill()
      p.fill()
      return true
    }
    img.isTemplate = true
    return img
  }

  private func setStatus(_ text: String) {
    DispatchQueue.main.async { self.statusLine.title = text }
  }

  // MARK: server

  private func startOrAttach() {
    setStatus("Starting…")
    let forceSpawn = env["KOMPOSIT_SPAWN"] == "1"
    DispatchQueue.global(qos: .userInitiated).async {
      if !forceSpawn, let p = Self.findRunningServer() {
        DispatchQueue.main.async {
          self.port = p
          self.attached = true
          self.setStatus("Running on port \(p)")
          if self.openWhenReady { self.openWhenReady = false; self.openUI() }
        }
        return
      }
      DispatchQueue.main.async { self.spawnServer() }
    }
  }

  static func findRunningServer() -> Int? {
    for p in PORTS {
      guard let url = URL(string: "http://127.0.0.1:\(p)/api/hello") else { continue }
      var req = URLRequest(url: url)
      req.timeoutInterval = 0.6
      let sem = DispatchSemaphore(value: 0)
      var ok = false
      URLSession.shared.dataTask(with: req) { data, _, _ in
        if let d = data, let s = String(data: d, encoding: .utf8), s.contains("\"komposit\":true") { ok = true }
        sem.signal()
      }.resume()
      _ = sem.wait(timeout: .now() + 1.0)
      if ok { return p }
    }
    return nil
  }

  private func openLog() {
    try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
    let old = logDir.appendingPathComponent("server.previous.log")
    try? FileManager.default.removeItem(at: old)
    try? FileManager.default.moveItem(at: logURL, to: old)
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    logHandle = try? FileHandle(forWritingTo: logURL)
  }

  private func spawnServer() {
    guard let node = Bundle.main.url(forAuxiliaryExecutable: "node"),
          let res = Bundle.main.resourceURL else { setStatus("Damaged install: node missing"); return }
    let script = res.appendingPathComponent("app/companion/server.mjs")
    openLog()

    let p = Process()
    p.executableURL = node
    p.arguments = [script.path]
    p.currentDirectoryURL = res.appendingPathComponent("app")
    var env = ProcessInfo.processInfo.environment
    env["KOMPOSIT_APP"] = "1"
    if let helper = Bundle.main.url(forAuxiliaryExecutable: "komposit-helper") { env["KOMPOSIT_HELPER"] = helper.path }
    if let web = webURL { env["KOMPOSIT_WEB_URL"] = web }
    p.environment = env

    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    out.fileHandleForReading.readabilityHandler = { [weak self] h in
      let data = h.availableData
      guard let self = self, !data.isEmpty else { return }
      self.logHandle?.write(data)
      guard let s = String(data: data, encoding: .utf8) else { return }
      self.lineBuffer += s
      while let nl = self.lineBuffer.firstIndex(of: "\n") {
        let line = String(self.lineBuffer[..<nl])
        self.lineBuffer = String(self.lineBuffer[self.lineBuffer.index(after: nl)...])
        if line.hasPrefix("KOMPOSIT_READY port="), let n = Int(line.dropFirst("KOMPOSIT_READY port=".count)) {
          DispatchQueue.main.async { self.serverReady(port: n) }
        }
      }
    }
    p.terminationHandler = { [weak self] proc in
      DispatchQueue.main.async { self?.serverExited(code: proc.terminationStatus) }
    }
    do {
      try p.run()
      server = p
      attached = false
    } catch {
      setStatus("Couldn't start: \(error.localizedDescription)")
    }
  }

  private func serverReady(port: Int) {
    self.port = port
    setStatus("Running on port \(port)")
    if openWhenReady { openWhenReady = false; openUI() }
  }

  private func serverExited(code: Int32) {
    server = nil
    port = nil
    if quitting { return }
    // Restart after a crash, but give up if it keeps failing.
    let now = Date()
    restarts = restarts.filter { now.timeIntervalSince($0) < 60 } + [now]
    if restarts.count > 4 {
      setStatus("Stopped. Choose Restart, or see the log")
      return
    }
    setStatus("Restarting…")
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.startOrAttach() }
  }

  private func stopServer(wait: Bool) {
    guard let p = server, p.isRunning else { return }
    p.terminate() // SIGTERM: the server stops any running turn, then exits
    if wait {
      let deadline = Date().addingTimeInterval(3)
      while p.isRunning && Date() < deadline { usleep(50_000) }
      if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }
  }

  // MARK: actions

  private func defaultBrowserReachesLocalhost() -> Bool {
    guard let probe = URL(string: "https://example.com"),
          let app = NSWorkspace.shared.urlForApplication(toOpen: probe),
          let id = Bundle(url: app)?.bundleIdentifier else { return false }
    return CHROMIUM.contains(id)
  }

  private func openUI() {
    guard let port = port else { startOrAttach(); openWhenReady = true; return }
    // The hosted page can talk to this Mac from Chromium browsers and
    // Firefox. Safari can't, so it gets the page this app serves itself.
    let useHosted = webURL != nil && defaultBrowserReachesLocalhost()
    let path = useHosted ? "/connect" : "/"
    if let url = URL(string: "http://127.0.0.1:\(port)\(path)") { NSWorkspace.shared.open(url) }
  }

  @objc private func openUIAction() { openUI() }

  @objc private func restartAction() {
    restarts.removeAll()
    if attached { startOrAttach(); return }
    if let p = server, p.isRunning {
      p.terminationHandler = { [weak self] _ in
        DispatchQueue.main.async { self?.server = nil; self?.startOrAttach() }
      }
      stopServer(wait: false)
    } else {
      startOrAttach()
    }
  }

  @objc private func showLog() { NSWorkspace.shared.open(logURL) }

  @objc private func showData() {
    try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
    NSWorkspace.shared.open(dataDir)
  }

  @objc private func quitAction() { NSApp.terminate(nil) }

  // MARK: open at login (macOS 13+)

  private func refreshLoginItem() {
    loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
  }

  @objc private func toggleLogin() {
    do {
      if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
      else { try SMAppService.mainApp.register() }
    } catch {
      NSSound.beep()
    }
    refreshLoginItem()
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)

// `kill` (SIGTERM) quits like the menu does, so the server is stopped too.
signal(SIGTERM, SIG_IGN)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { NSApp.terminate(nil) }
sigterm.resume()

app.run()

// The Komposit mark (04.C solid tile) drawn into `rect`: the rounded tile, and
// the arrow as a separate subpath so callers can fill it or knock it out.
func kompositTile(in rect: NSRect) -> (tile: NSBezierPath, arrow: NSBezierPath) {
  let k = rect.width / 140
  func pt(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: rect.minX + x * k, y: rect.maxY - y * k) }
  let tile = NSBezierPath(roundedRect: rect, xRadius: 32.083 * k, yRadius: 32.083 * k)
  let p = NSBezierPath()
  // 04.C arrow, in tile units (140 × 140, y down), from the Illustrator spec.
  p.move(to: pt(26.04, 57.207))
  p.curve(to: pt(26.906, 53.977), controlPoint1: pt(24.99, 56.156), controlPoint2: pt(25.47, 54.362))
  p.curve(to: pt(102.174, 33.809), controlPoint1: pt(26.906, 53.977), controlPoint2: pt(102.174, 33.809))
  p.curve(to: pt(106.517, 39.468), controlPoint1: pt(105.496, 32.919), controlPoint2: pt(108.236, 36.49))
  p.curve(to: pt(87.903, 71.707), controlPoint1: pt(106.517, 39.468), controlPoint2: pt(87.903, 71.707))
  p.curve(to: pt(87.731, 72.351), controlPoint1: pt(87.79, 71.903), controlPoint2: pt(87.731, 72.125))
  p.curve(to: pt(87.731, 109.577), controlPoint1: pt(87.731, 72.351), controlPoint2: pt(87.731, 109.577))
  p.curve(to: pt(81.141, 112.307), controlPoint1: pt(87.731, 113.017), controlPoint2: pt(83.573, 114.739))
  p.curve(to: pt(26.04, 57.207), controlPoint1: pt(81.141, 112.307), controlPoint2: pt(26.04, 57.207))
  p.close()
  return (tile, p)
}
// Keep in sync with packaging/macos/make-icon.swift and brand/*.svg.
