import AppKit
import WebKit

/// Reads plain text from a pasteboard, unless the app that wrote it marked it as private.
///
/// Password managers mark copies with the nspasteboard.org types: concealed (a password) or transient
/// (only meant to live for a moment). Those are never read, so they can't end up on the board.
enum PasteboardFilter {
    static let skippedTypes: Set<NSPasteboard.PasteboardType> = [
        NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"),
        NSPasteboard.PasteboardType("org.nspasteboard.TransientType"),
    ]

    static func isPrivate(_ types: [NSPasteboard.PasteboardType]) -> Bool {
        types.contains(where: skippedTypes.contains)
    }

    static func text(from pasteboard: NSPasteboard) -> String? {
        guard let types = pasteboard.types, !isPrivate(types) else { return nil }
        return pasteboard.string(forType: .string)
    }
}

/// The page's way to read the pasteboard: `await webkit.messageHandlers.todosClipboard.postMessage("read")`.
///
/// WKWebView can't read the clipboard without a click each time, so the web UI's clipboard suggestions
/// (public/app.js, filtered by public/clipboard.js) ask here instead. It answers only while Todos is the
/// active app, only to the bundled page, and returns "" for anything private.
final class ClipboardBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "todosClipboard"

    var pasteboard: NSPasteboard = .general
    var isAppActive: () -> Bool = { NSApp.isActive }

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        let origin = message.frameInfo.securityOrigin
        let fromApp = message.frameInfo.isMainFrame && origin.protocol == AppScheme.scheme && origin.host == AppScheme.host
        guard fromApp, message.body as? String == "read", isAppActive() else { return replyHandler("", nil) }
        replyHandler(PasteboardFilter.text(from: pasteboard) ?? "", nil)
    }
}
