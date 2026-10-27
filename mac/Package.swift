// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "Todos",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Todos",
            path: "Sources/Todos",
            linkerSettings: [
                .linkedFramework("Carbon"),
                .linkedFramework("WebKit"),
            ]
        ),
        .testTarget(
            name: "TodosTests",
            dependencies: ["Todos"],
            path: "Tests/TodosTests"
        ),
    ]
)
