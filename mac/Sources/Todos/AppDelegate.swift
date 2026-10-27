import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var board: BoardWindowController?
    private var hotKey: GlobalHotKey?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A second copy would fight over ⌥Space and the same storage: hand over to the first and leave.
        let me = NSRunningApplication.current
        if let other = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .first(where: { $0 != me })
        {
            other.activate()
            NSApp.terminate(nil)
            return
        }

        buildMainMenu()
        guard let root = AppScheme.webRoot(), FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path) else {
            let alert = NSAlert()
            alert.messageText = "Todos is missing its web files."
            alert.informativeText = "Rebuild the app with `make app` in the mac folder."
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        let board = BoardWindowController(webRoot: root)
        self.board = board
        hotKey = GlobalHotKey(keyCode: GlobalHotKey.optionSpace.keyCode, modifiers: GlobalHotKey.optionSpace.modifiers) { [weak board] in
            board?.toggle()
        }
        board.show()
        if let folder = ProcessInfo.processInfo.environment["TODOS_SELFTEST"], !folder.isEmpty {
            SelfTest.run(board: board, hotKeyRegistered: hotKey != nil, folder: URL(fileURLWithPath: folder, isDirectory: true))
        }
    }

    // Closing the window keeps Todos running, so ⌥Space keeps working.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        board?.show()
        return true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    @objc private func openWebsite(_ sender: Any?) {
        NSWorkspace.shared.open(URL(string: "https://todos.always17.com")!)
    }

    @objc private func openSource(_ sender: Any?) {
        NSWorkspace.shared.open(URL(string: "https://github.com/NeelkanthTandel/todos")!)
    }

    // MARK: Menus. The Edit menu is what makes ⌘C, ⌘V, ⌘X, ⌘A and ⌘Z work inside the web view.

    private func buildMainMenu() {
        let main = NSMenu()

        let app = NSMenu(title: "Todos")
        app.addItem(withTitle: "About Todos", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Todos", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit Todos", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(submenu(app))

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        main.addItem(submenu(edit))

        let view = NSMenu(title: "View")
        let full = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        main.addItem(submenu(view))

        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        window.addItem(.separator())
        window.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        main.addItem(submenu(window))
        NSApp.windowsMenu = window

        let help = NSMenu(title: "Help")
        help.addItem(withTitle: "Todos Website", action: #selector(openWebsite(_:)), keyEquivalent: "").target = self
        help.addItem(withTitle: "Source Code on GitHub", action: #selector(openSource(_:)), keyEquivalent: "").target = self
        main.addItem(submenu(help))
        NSApp.helpMenu = help

        NSApp.mainMenu = main
    }

    private func submenu(_ menu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }
}
