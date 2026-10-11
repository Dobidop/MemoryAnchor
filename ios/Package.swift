// swift-tools-version: 5.9
// MemoryAnchorKit — Swift wrapper over the memoryanchor-core C ABI.
//
// MemoryAnchorCore.xcframework is a build artifact, not a checked-in file. Build
// it first with `tools/build-xcframework.sh`, which drops it into Frameworks/.

import PackageDescription

let package = Package(
    name: "MemoryAnchorKit",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "MemoryAnchorKit", targets: ["MemoryAnchorKit"]),
    ],
    targets: [
        // Produced by tools/build-xcframework.sh from the Rust static library.
        .binaryTarget(
            name: "MemoryAnchorCore",
            path: "Frameworks/MemoryAnchorCore.xcframework"
        ),
        .target(
            name: "MemoryAnchorKit",
            dependencies: ["MemoryAnchorCore"],
            linkerSettings: [
                // rustls resolves native roots through Security on Apple platforms.
                .linkedFramework("Security"),
                .linkedFramework("CoreFoundation"),
            ]
        ),
        .testTarget(
            name: "MemoryAnchorKitTests",
            dependencies: ["MemoryAnchorKit"]
        ),
    ]
)
