// swift-tools-version: 5.9
// kura-signer - Touch ID gated wallet key storage for kura

import PackageDescription

let package = Package(
  name: "KuraSigner",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "kura-signer", targets: ["KuraSigner"])
  ],
  targets: [
    .executableTarget(
      name: "KuraSigner",
      path: "Sources/KuraSigner"
    )
  ]
)
