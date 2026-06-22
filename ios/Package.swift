// swift-tools-version:5.9
import PackageDescription

// Host-runnable contract-parity harness for the GhostAgent iOS client.
//
// This package exists ONLY to exercise the *real* networking + model code of the
// app (APIClient.swift, Models.swift) on the host toolchain, with no Firebase /
// SwiftUI / simulator dependency, so the HTTP contract can be verified with a
// plain `swift test` in CI that has no Xcode. The app itself is still built with
// XcodeGen + xcodebuild (see ios/GhostAgent/project.yml); this package never
// ships and is not part of the app target.
let package = Package(
    name: "GhostAgentContract",
    platforms: [.macOS(.v12)],
    targets: [
        // Reuse the exact, unmodified client source the app compiles. Only the
        // two pure-Foundation files are pulled in via an explicit `sources` list
        // so none of the SwiftUI/Firebase files are dragged into the host build.
        .target(
            name: "GhostAgentContract",
            path: "GhostAgent/GhostAgent",
            sources: ["APIClient.swift", "Models.swift"]
        ),
        .testTarget(
            name: "ContractParityTests",
            dependencies: ["GhostAgentContract"],
            path: "contract/SwiftContractTests"
        )
    ]
)
