import Darwin
import Foundation
import Network

// Apple's Bonjour API performs browsing, TXT decoding and service resolution.
// TCP connections only resolve/probe advertised endpoints; no print data is sent.
struct DiscoveredDevice: Encodable {
  let identity: String
  enum CodingKeys: String, CodingKey { case name, kind, address, location }
  let name: String
  let kind: String
  let address: String
  let location: String
}
struct Snapshot: Encodable {
  let version = 1
  let source = "macos-bonjour"
  let generatedAt: String
  let devices: [DiscoveredDevice]
  let warnings: [String]
}

final class Discovery {
  let output: URL
  var browsers: [NWBrowser] = []
  var results: [String: Set<NWBrowser.Result>] = [:]
  var connections: [NWEndpoint: NWConnection] = [:]
  var candidates: [NWEndpoint: DiscoveredDevice] = [:]
  var errors: [String: String] = [:]
  var timer: DispatchSourceTimer?
  var signals: [DispatchSourceSignal] = []
  var previousAddresses: Set<String> = []

  init(output: URL) { self.output = output }

  func write() {
    let devices = Dictionary(
      candidates.values.map { ($0.identity, $0) },
      uniquingKeysWith: { first, next in
        (first.address.hasPrefix("ipps:") || first.address.contains(":https://")) ? first : next
      }
    )
    .values.sorted { $0.address < $1.address }
    let snapshot = Snapshot(
      generatedAt: ISO8601DateFormatter().string(from: Date()),
      devices: Array(devices.prefix(100)), warnings: Array(errors.values).sorted())
    do {
      let data = try JSONEncoder().encode(snapshot)
      try data.write(to: output, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: output.path)
      let addresses = Set(devices.map { $0.address })
      if addresses != previousAddresses {
        print("macOS Bonjour: \(devices.count) advertised devices discovered.")
        fflush(stdout)
        previousAddresses = addresses
      }
    } catch {
      fputs("Could not write the discovery snapshot. Check folder permissions.\n", stderr)
      exit(1)
    }
  }

  func refresh() {
    let current = Set(results.values.flatMap { $0 }.map { $0.endpoint })
    for endpoint in Array(candidates.keys) where !current.contains(endpoint) {
      candidates.removeValue(forKey: endpoint)
    }
    for (endpoint, connection) in Array(connections) {
      if !current.contains(endpoint) {
        connection.cancel()
        connections.removeValue(forKey: endpoint)
      }
    }
    for result in results.values.flatMap({ $0 }).prefix(100) {
      let endpoint = result.endpoint
      guard connections[endpoint] == nil,
        case .service(let name, let type, _, _) = endpoint,
        case .bonjour(let txt) = result.metadata
      else { continue }
      let options = NWParameters.tcp
      (options.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options)?.version = .v4
      let connection = NWConnection(to: endpoint, using: options)
      connections[endpoint] = connection
      connection.stateUpdateHandler = { [weak self, weak connection] state in
        guard let self, let connection, self.connections[endpoint] === connection else { return }
        if ProcessInfo.processInfo.environment["OWP_DISCOVERY_DEBUG"] == "1" {
          print(
            "Connection state: \(state); endpoint: \(String(describing: connection.currentPath?.remoteEndpoint))"
          )
          fflush(stdout)
        }
        if case .ready = state,
          case .hostPort(let host, let port) = connection.currentPath?.remoteEndpoint
        {
          // IPv4 is reachable from Docker Desktop; link-local IPv6 scopes aren't portable.
          guard case .ipv4(let address) = host else {
            connection.cancel()
            return
          }
          var url = URLComponents()
          let scanner = type.hasPrefix("_uscan")
          url.scheme =
            scanner
            ? (type.hasPrefix("_uscans.") ? "https" : "http")
            : (type.hasPrefix("_ipps.") ? "ipps" : "ipp")
          url.host = address.rawValue.map { String($0) }.joined(separator: ".")
          url.port = Int(port.rawValue)
          url.path =
            "/"
            + (scanner ? (txt["rs"] ?? "eSCL") : (txt["rp"] ?? "ipp/print")).trimmingCharacters(
              in: CharacterSet(charactersIn: "/"))
          if let uri = url.url?.absoluteString {
            let backendName = String(name.prefix(65)).replacingOccurrences(of: ":", with: " ")
            self.candidates[endpoint] = DiscoveredDevice(
              identity:
                "\(scanner ? "scanner" : "printer"):\(txt["UUID"]?.lowercased() ?? "\(url.host ?? "")/\(name)")",
              name: scanner ? "\(backendName) · Scanner" : String(name.prefix(80)),
              kind: scanner ? "scanner" : "printer",
              address: scanner ? "airscan:escl:\(backendName):\(uri)" : uri,
              location: String((txt["note"] ?? "").prefix(80)))
            self.write()
          }
          connection.cancel()
        } else if case .failed = state {
          self.candidates.removeValue(forKey: endpoint)
          connection.cancel()
          self.write()
        }
      }
      connection.start(queue: .main)
      DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self, weak connection] in
        guard let self, let connection, self.connections[endpoint] === connection else { return }
        if case .cancelled = connection.state {
          // A successful probe already cancelled its connection after recording the candidate.
        } else {
          self.candidates.removeValue(forKey: endpoint)
          self.write()
        }
        connection.cancel()
        self.connections.removeValue(forKey: endpoint)
      }
    }
    write()
  }

  func start() {
    for type in ["_ipp._tcp", "_ipps._tcp", "_uscan._tcp", "_uscans._tcp"] {
      let parameters = NWParameters.tcp
      // Resolve to IPv4 so container clients can use the result without host .local DNS.
      (parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options)?.version = .v4
      let browser = NWBrowser(
        for: .bonjourWithTXTRecord(type: type, domain: "local."), using: parameters)
      browser.browseResultsChangedHandler = { [weak self] found, _ in
        if ProcessInfo.processInfo.environment["OWP_DISCOVERY_DEBUG"] == "1" {
          print("Browser \(type): \(found.count) results")
          fflush(stdout)
        }
        self?.results[type] = found
        self?.refresh()
      }
      browser.stateUpdateHandler = { [weak self] state in
        guard let self else { return }
        switch state {
        case .failed, .waiting:
          self.errors[type] =
            "macOS Bonjour browsing is unavailable. Check Local Network permission for the terminal running the helper."
          self.results[type] = []
        case .ready: self.errors.removeValue(forKey: type)
        default: break
        }
        self.refresh()
      }
      browsers.append(browser)
      browser.start(queue: .main)
    }
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now(), repeating: 10)
    timer.setEventHandler { [weak self] in self?.refresh() }
    self.timer = timer
    timer.resume()
    for number in [SIGTERM, SIGINT] {
      signal(number, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
      source.setEventHandler { [weak self] in
        guard let self else { exit(0) }
        self.browsers.forEach { $0.cancel() }
        self.connections.values.forEach { $0.cancel() }
        try? FileManager.default.removeItem(at: self.output)
        exit(0)
      }
      signals.append(source)
      source.resume()
    }
    print(
      "Browsing IPP/IPPS and eSCL with macOS Bonjour. Keep this helper running; stop with Ctrl+C.")
    fflush(stdout)
  }
}

guard CommandLine.arguments.count == 2 else {
  fputs("Usage: discovery-macos /absolute/path/devices.json\n", stderr)
  exit(1)
}
let discovery = Discovery(output: URL(fileURLWithPath: CommandLine.arguments[1]))
discovery.start()
dispatchMain()
