# Patched Baguette runtime for WebSocket sleep crashes

Status: implemented
Translation: current

[中文](2026-09-29-baguette-runtime-sleep.zh.md)

## Abstract

Baguette v0.2.0 aborts when its WebSocket automatic-ping task returns from the first 30-second sleep. A symbolized Release build confirms `WebSocketHandler.runAutoPingLoop` as the failing caller, and the same sleep form also crashes in the close-handshake task. Replace the three `Task.sleep(for:)` calls in the pinned swift-websocket dependency with `ContinuousClock.sleep(until:)`, preserving cancellation and timing. Distribute the verified native build as `0.2.0-lody.1`, with its patch and provenance, rather than changing upstream-version bytes.

## Evidence and decision

The official binary aborted after 30.15 seconds; an unmodified source build using Apple Swift 6.3.3 aborted after 31.20 seconds. Both reported `freed pointer was not the last allocation` in `swift_task_dealloc`. Source symbols identify `WebSocketHandler.swift:227` in swift-websocket 1.5.0. Changing only the ping-loop sleeps survived three pings but exposed the same failure at line 191 during shutdown. Changing all three calls survived 92.7 seconds, delivered 106 JPEG frames and three pings, and exited with code 0 after deliberate test cleanup.

This confirms the failing sleep path and workaround, not the exact compiler/ABI mechanism. [Swift issue 86204](https://github.com/swiftlang/swift/issues/86204) documents a matching specialization failure. Rebuilding with the locally available newer compiler alone was insufficient. Disabling automatic ping would remove useful connection liveness and would leave the close-handshake path unfixed.

## Artifact ownership

The [runtime manifest](../../../../apps/cli/src/ios-simulator/baguette-manifest.json) pins archive/executable digests and records the upstream and dependency revisions, patch digest, compiler and command. The [packager](../../../../scripts/package-baguette-runtime.mjs) retains the verified executable unchanged and emits deterministic archives with resources, notices, patch and provenance. The [runtime README](../../../../apps/cli/src/ios-simulator/README.md) owns rebuild/packaging instructions.

The separate Lody revision gives a new download key and installation cache. Existing upstream-version caches and immutable objects remain valid. Publication must verify the local archive and remote readback before shipping the updated manifest. Subsequent mirror runs reuse that exact published artifact; changing build bytes requires another runtime revision.

## Verification limits

The native test exercised MJPEG, three real ping cycles and shutdown on Apple Silicon/macOS 26.6.2. It is not a long soak or complete Electron/remote/mobile acceptance test. Packaging tests exercise layout, deterministic metadata and rejection of changed executable, patch, resources and symlinks. The runtime still requires its existing Xcode/iOS compatibility checks when any dependency or toolchain changes.
