import AppKit
import WebKit

/// `TODOS_SELFTEST=<folder> Todos.app/Contents/MacOS/Todos` checks the real bundle end to end, then quits:
/// the board renders, the page keeps its CSP and storage, the native bridge is there, and the ⌥Space
/// toggle hides and shows the window. It writes report.json and board.png into the folder. Used by CI and
/// for local checks where the screen can't be captured. It never reads the pasteboard or your list.
@MainActor
enum SelfTest {
    static func run(board: BoardWindowController, hotKeyRegistered: Bool, folder: URL) {
        Task { @MainActor in
            var report: [String: Any] = ["hotKeyRegistered": hotKeyRegistered]
            let web = board.webView
            var lanes = 0
            for _ in 0..<100 where lanes != 4 {
                try? await Task.sleep(nanoseconds: 100_000_000)
                lanes = (try? await web.evaluateJavaScript("document.querySelectorAll('.lane').length")) as? Int ?? 0
            }
            report["lanes"] = lanes
            let page = try? await web.callAsyncJavaScript(
                """
                let csp = "allowed";
                try { await fetch("https://example.com/"); } catch { csp = "blocked"; }
                const k = "todos.selftest";
                localStorage.setItem(k, "1");
                const storage = localStorage.getItem(k) === "1";
                localStorage.removeItem(k);
                return { origin: location.origin, title: document.title, secureContext: isSecureContext,
                  webCrypto: typeof crypto.subtle === "object", storage, csp,
                  nativeClipboard: !!window.webkit?.messageHandlers?.todosClipboard,
                  composer: !!document.getElementById("new"), font: document.fonts.check("16px 'Schibsted Grotesk'") };
                """, contentWorld: .page)
            report["page"] = page ?? "unavailable"

            // The same path ⌥Space takes, minus the key press (which needs a real keyboard).
            @MainActor func windowState() -> [String: Bool] {
                ["active": NSApp.isActive, "visible": board.window?.isVisible ?? false, "hidden": NSApp.isHidden]
            }
            try? await Task.sleep(nanoseconds: 800_000_000)
            var toggles = [windowState()]
            for _ in 0..<3 {
                board.toggle()
                try? await Task.sleep(nanoseconds: 1_200_000_000)
                toggles.append(windowState())
            }
            report["toggles"] = toggles

            board.show()
            try? await Task.sleep(nanoseconds: 500_000_000)
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            if let image = try? await web.takeSnapshot(configuration: nil), let tiff = image.tiffRepresentation,
                let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
            {
                try? png.write(to: folder.appendingPathComponent("board.png"))
                report["snapshot"] = "board.png"
            }
            if let json = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
                try? json.write(to: folder.appendingPathComponent("report.json"))
            }
            NSApp.terminate(nil)
        }
    }
}
