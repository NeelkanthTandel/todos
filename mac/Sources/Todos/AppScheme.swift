import Foundation
import WebKit

/// Serves the bundled web UI (a copy of the repo's `public/`) at `todos-app://app/`.
///
/// A custom scheme instead of `file://` gives the page a stable origin, so localStorage persists in
/// `WKWebsiteDataStore.default()`, and keeps relative paths and the page's CSP (`'self'`) working.
enum AppScheme {
    static let scheme = "todos-app"
    static let host = "app"
    static let origin = "\(scheme)://\(host)"
    static let startURL = URL(string: "\(origin)/index.html")!

    /// Maps a request URL to a file inside `root`, or nil when it isn't ours or would leave `root`.
    static func fileURL(for url: URL, root: URL) -> URL? {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == host else { return nil }
        // URL.path is already percent-decoded, so "%2e%2e" arrives here as "..".
        var path = url.path
        if path.isEmpty || path.hasSuffix("/") { path += "index.html" }
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        // Dot segments, hidden files and NUL bytes are never part of the site.
        guard !parts.isEmpty, !parts.contains(where: { $0.hasPrefix(".") || $0.contains("\0") || $0.contains("\\") }) else {
            return nil
        }
        let base = root.standardizedFileURL.resolvingSymlinksInPath()
        let file = parts.reduce(base) { $0.appendingPathComponent(String($1)) }.standardizedFileURL.resolvingSymlinksInPath()
        // Belt and braces: after resolving symlinks the file must still sit under root.
        guard file.path.hasPrefix(base.path + "/") else { return nil }
        return file
    }

    static func mimeType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "webmanifest": return "application/json"
        case "txt": return "text/plain; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        default: return "application/octet-stream"
        }
    }

    /// Where the bundled UI lives: `Contents/Resources/web` in the app, or `TODOS_WEB_DIR` for `make run-dev`.
    static func webRoot(bundle: Bundle = .main, environment: [String: String] = ProcessInfo.processInfo.environment) -> URL? {
        if let dir = environment["TODOS_WEB_DIR"], !dir.isEmpty { return URL(fileURLWithPath: dir, isDirectory: true) }
        return bundle.resourceURL?.appendingPathComponent("web", isDirectory: true)
    }
}

final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL

    init(root: URL) {
        self.root = root
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let url = task.request.url ?? AppScheme.startURL
        let method = task.request.httpMethod ?? "GET"
        guard method == "GET" || method == "HEAD" else { return respond(task, url: url, status: 405) }
        guard let file = AppScheme.fileURL(for: url, root: root), let data = try? Data(contentsOf: file) else {
            return respond(task, url: url, status: 404)
        }
        let headers = [
            "Content-Type": AppScheme.mimeType(forExtension: file.pathExtension),
            "Content-Length": String(data.count),
            // The files change with each app update, never while it runs; no-cache keeps an update from showing stale ones.
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
        ]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        if method == "GET" { task.didReceive(data) }
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int) {
        let body = Data((HTTPURLResponse.localizedString(forStatusCode: status) + "\n").utf8)
        let headers = ["Content-Type": "text/plain; charset=utf-8", "Content-Length": String(body.count)]
        task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(body)
        task.didFinish()
    }
}
