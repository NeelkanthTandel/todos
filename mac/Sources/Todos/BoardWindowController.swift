import AppKit
import UniformTypeIdentifiers
import WebKit

/// The one window: a WKWebView showing the bundled web UI, plus the native pieces a browser would provide
/// (downloads, the file picker, opening links elsewhere).
@MainActor
final class BoardWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
    WKDownloadDelegate
{
    let webView: WKWebView

    init(webRoot: URL) {
        let config = WKWebViewConfiguration()
        // The default store persists to disk, so the list (localStorage) survives restarts. It's the app's own
        // store, so the app keeps a separate list from any browser; device sync links the two.
        config.websiteDataStore = .default()
        config.setURLSchemeHandler(AppSchemeHandler(root: webRoot), forURLScheme: AppScheme.scheme)
        config.userContentController.addScriptMessageHandler(ClipboardBridge(), contentWorld: .page, name: ClipboardBridge.name)
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        config.applicationNameForUserAgent = "TodosMac/" + version
        webView = WKWebView(frame: .zero, configuration: config)
        webView.isInspectable = ProcessInfo.processInfo.environment["TODOS_INSPECT"] == "1"

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Todos"
        window.minSize = NSSize(width: 420, height: 360)
        window.isReleasedWhenClosed = false  // closing only hides it; ⌥Space or the Dock icon brings it back
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenPrimary]
        window.contentView = webView
        window.center()
        // Restores the saved size and position if there is one, and saves every change from now on.
        window.setFrameAutosaveName("TodosBoard")
        super.init(window: window)

        window.delegate = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.load(URLRequest(url: AppScheme.startURL))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    // MARK: Showing and hiding

    func toggle() {
        guard let window else { return }
        switch WindowToggle.action(appActive: NSApp.isActive, windowVisible: window.isVisible, windowMiniaturized: window.isMiniaturized) {
        case .hide: NSApp.hide(nil)  // also hands focus back to the app you came from
        case .show: show()
        }
    }

    func show() {
        guard let window else { return }
        NSApp.unhide(nil)
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        window.makeFirstResponder(webView)
    }

    // MARK: Navigation: only the bundled UI loads here; links open in your browser

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        if navigationAction.shouldPerformDownload { return .download }
        guard let url = navigationAction.request.url else { return .cancel }
        switch url.scheme?.lowercased() {
        case AppScheme.scheme where url.host?.lowercased() == AppScheme.host: return .allow
        case "about": return .allow
        case "blob" where navigationAction.targetFrame?.isMainFrame == true: return .download
        case "http", "https", "mailto":
            NSWorkspace.shared.open(url)
            return .cancel
        default: return .cancel
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        navigationResponse.canShowMIMEType ? .allow : .download
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: Export: downloads go where you choose

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.canCreateDirectories = true
        let response: NSApplication.ModalResponse
        if let window, window.isVisible { response = await panel.beginSheetModal(for: window) } else { response = panel.runModal() }
        guard response == .OK, let url = panel.url else { return nil }
        // The save panel already asked about replacing; WKDownload fails if the file is still there.
        try? FileManager.default.removeItem(at: url)
        return url
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        NSLog("Todos: download failed: \(error.localizedDescription)")
    }

    // MARK: Import, links that open a new window, and JavaScript dialogs

    func webView(
        _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        // The page's input asks for JSON backups (accept="application/json,.json").
        panel.allowedContentTypes = [.json]
        guard let window else { return completionHandler(panel.runModal() == .OK ? panel.urls : nil) }
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(
        _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }
}
