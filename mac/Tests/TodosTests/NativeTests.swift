import AppKit
import XCTest

@testable import Todos

final class PasteboardFilterTests: XCTestCase {
    private var pasteboard: NSPasteboard!

    override func setUp() {
        pasteboard = NSPasteboard(name: NSPasteboard.Name("todos-test-\(UUID().uuidString)"))
    }

    override func tearDown() {
        pasteboard.releaseGlobally()
    }

    func testReadsPlainText() {
        pasteboard.clearContents()
        pasteboard.setString("Buy oat milk", forType: .string)
        XCTAssertEqual(PasteboardFilter.text(from: pasteboard), "Buy oat milk")
    }

    func testSkipsConcealedCopies() {
        pasteboard.clearContents()
        pasteboard.declareTypes([.string, NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")], owner: nil)
        pasteboard.setString("hunter2", forType: .string)
        XCTAssertNil(PasteboardFilter.text(from: pasteboard))
    }

    func testSkipsTransientCopies() {
        pasteboard.clearContents()
        pasteboard.declareTypes([.string, NSPasteboard.PasteboardType("org.nspasteboard.TransientType")], owner: nil)
        pasteboard.setString("482913", forType: .string)
        XCTAssertNil(PasteboardFilter.text(from: pasteboard))
    }

    func testNothingWithoutText() {
        pasteboard.clearContents()
        XCTAssertNil(PasteboardFilter.text(from: pasteboard))
        pasteboard.setData(Data([1, 2, 3]), forType: .png)
        XCTAssertNil(PasteboardFilter.text(from: pasteboard))
    }

    func testIsPrivate() {
        XCTAssertFalse(PasteboardFilter.isPrivate([.string, .html]))
        XCTAssertTrue(PasteboardFilter.isPrivate([.string, NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")]))
    }
}

final class WindowToggleTests: XCTestCase {
    func testHidesOnlyWhenInFrontAndVisible() {
        XCTAssertEqual(WindowToggle.action(appActive: true, windowVisible: true, windowMiniaturized: false), .hide)
    }

    func testShowsFromAnotherApp() {
        // Window open, but behind the app you're using: the shortcut brings it forward instead of hiding it.
        XCTAssertEqual(WindowToggle.action(appActive: false, windowVisible: true, windowMiniaturized: false), .show)
        XCTAssertEqual(WindowToggle.action(appActive: false, windowVisible: false, windowMiniaturized: false), .show)
    }

    func testShowsAClosedOrMinimizedWindow() {
        XCTAssertEqual(WindowToggle.action(appActive: true, windowVisible: false, windowMiniaturized: false), .show)
        XCTAssertEqual(WindowToggle.action(appActive: true, windowVisible: true, windowMiniaturized: true), .show)
    }

    func testShortcutIsOptionSpace() {
        XCTAssertEqual(GlobalHotKey.optionSpace.keyCode, 49)  // kVK_Space
        XCTAssertEqual(GlobalHotKey.optionSpace.modifiers, 0x0800)  // optionKey
    }
}
