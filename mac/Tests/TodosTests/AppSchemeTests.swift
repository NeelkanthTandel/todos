import XCTest

@testable import Todos

final class AppSchemeTests: XCTestCase {
    private var root: URL!
    private var outside: URL!

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("todos-scheme-\(UUID().uuidString)")
        root = base.appendingPathComponent("web")
        outside = base.appendingPathComponent("secret.txt")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("fonts"), withIntermediateDirectories: true)
        for name in ["index.html", "app.js", "styles.css", "fonts/a.woff2"] {
            try Data("x".utf8).write(to: root.appendingPathComponent(name))
        }
        try Data("secret".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("link.txt"), withDestinationURL: outside)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root.deletingLastPathComponent())
    }

    private func resolve(_ string: String) -> String? {
        AppScheme.fileURL(for: URL(string: string)!, root: root).map {
            String($0.path.dropFirst(root.resolvingSymlinksInPath().path.count))
        }
    }

    func testServesFilesInsideTheWebFolder() {
        XCTAssertEqual(resolve("todos-app://app/index.html"), "/index.html")
        XCTAssertEqual(resolve("todos-app://app/app.js?v=2#x"), "/app.js")
        XCTAssertEqual(resolve("todos-app://app/fonts/a.woff2"), "/fonts/a.woff2")
        XCTAssertEqual(resolve("TODOS-APP://APP/styles.css"), "/styles.css")
    }

    func testRootAndFoldersMeanIndex() {
        XCTAssertEqual(resolve("todos-app://app/"), "/index.html")
        XCTAssertEqual(resolve("todos-app://app"), "/index.html")
    }

    func testRejectsOtherSchemesAndHosts() {
        XCTAssertNil(resolve("https://app/index.html"))
        XCTAssertNil(resolve("file:///etc/passwd"))
        XCTAssertNil(resolve("todos-app://evil/index.html"))
    }

    func testNoPathTraversal() {
        XCTAssertNil(resolve("todos-app://app/../secret.txt"))
        XCTAssertNil(resolve("todos-app://app/fonts/../../secret.txt"))
        XCTAssertNil(resolve("todos-app://app/%2e%2e/secret.txt"))
        XCTAssertNil(resolve("todos-app://app/%2E%2E%2Fsecret.txt"))
        XCTAssertNil(resolve("todos-app://app/..%5Csecret.txt"))
        XCTAssertNil(resolve("todos-app://app/.hidden"))
        XCTAssertNil(resolve("todos-app://app/index.html%00.js"))
    }

    func testSymlinksCannotLeaveTheWebFolder() {
        XCTAssertNil(resolve("todos-app://app/link.txt"))
    }

    func testMimeTypes() {
        XCTAssertEqual(AppScheme.mimeType(forExtension: "html"), "text/html; charset=utf-8")
        XCTAssertEqual(AppScheme.mimeType(forExtension: "JS"), "text/javascript; charset=utf-8")
        XCTAssertEqual(AppScheme.mimeType(forExtension: "css"), "text/css; charset=utf-8")
        XCTAssertEqual(AppScheme.mimeType(forExtension: "woff2"), "font/woff2")
        XCTAssertEqual(AppScheme.mimeType(forExtension: "json"), "application/json")
        XCTAssertEqual(AppScheme.mimeType(forExtension: "svg"), "image/svg+xml")
        XCTAssertEqual(AppScheme.mimeType(forExtension: "exe"), "application/octet-stream")
        XCTAssertEqual(AppScheme.mimeType(forExtension: ""), "application/octet-stream")
    }

    func testWebRootPrefersTheDevOverride() {
        XCTAssertEqual(AppScheme.webRoot(environment: ["TODOS_WEB_DIR": "/tmp/public"])?.path, "/tmp/public")
        XCTAssertEqual(AppScheme.webRoot(environment: [:])?.lastPathComponent, "web")
    }
}
