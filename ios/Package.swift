// swift-tools-version: 5.9
// AnchorKit — Swift wrapper over the anchor-core C ABI.
//
// AnchorCore.xcframework is a build artifact, not a checked-in file. Build
// it first with `tools/build-xcframework.sh`, which drops it into Frameworks/.

import PackageDescription

let package = Package(
    name: "AnchorKit",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "AnchorKit", targets: ["AnchorKit"]),
    ],
    targets: [
        // Produced by tools/build-xcframework.sh from the Rust static library.
        .binaryTarget(
            name: "AnchorCore",
            path: "Frameworks/AnchorCore.xcframework"
        ),
        .target(
            name: "AnchorKit",
            dependencies: ["AnchorCore"],
            linkerSettings: [
                // rustls resolves native roots through Security on Apple platforms.
                .linkedFramework("Security"),
                .linkedFramework("CoreFoundation"),
            ]
        ),
        .testTarget(
            name: "AnchorKitTests",
            dependencies: ["AnchorKit"]
        ),
    ]
)
