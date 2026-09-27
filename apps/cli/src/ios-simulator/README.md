# Simulator preview implementation

`service.ts` owns ephemeral operations, `control-leases.ts` excludes competing
sessions across workspaces, and `devices.ts` is the simctl boundary. Lifecycle RPC
uses the shared `iosSimulator: 1` capability and `ios-simulator/control` command
union. Browser owns a separate service and separate transport instances.

The pinned Baguette executable runs in an IPC-owned worker. The native HTTP API
stays on loopback; only the bound device's MJPEG stream and validated single-pointer
input cross `gateway.ts`. The gateway serves the fixed `viewer.ts` artifact. The
React iframe validates source/origin/operation before accepting viewer state;
frames never enter React, RPC, or synchronized documents.

## Runtime artifact

`baguette-manifest.json` pins the upstream archive and executable digests. The
installer fetches only the platform runtime channel:

```
/api/runtimes/baguette/0.2.0/darwin-arm64/baguette_v0.2.0_macOS_arm64.tar.gz
```

The deployment composition must publish these exact bytes before shipping. The
private distribution repository provides `mirror-agent-runtimes.mjs --runtime
baguette` (use `--dry-run` to inspect the plan). There is no upstream, Homebrew or
PATH fallback. Reuse the verified versioned cache; downloads need connectivity,
while a cached same-machine preview does not require Cloud authorization.

`baguette-notices.json` contains Baguette's MIT license and licenses/notices from
the exact dependency revisions in v0.2.0's `Package.resolved`; source URLs accompany
each notice. The installer writes them as `THIRD_PARTY_NOTICES.txt`. Version changes
must refresh both digests and notices, then rerun native compatibility checks.

Supported native artifact: Apple Silicon, macOS 15+, Xcode and an installed iOS
runtime. Intel has no pinned artifact. Local smoke evidence used Xcode 26.6 / iOS
26.5 and verified device enumeration, managed installation, real JPEG delivery and
preview cleanup. Full Electron sidebar, remote Quick Tunnel and mobile E2E remain
unverified. H.264, multitouch, keyboard and device configuration are later work.

## Verification

Run the simulator tests plus the existing local-proxy and Quick Tunnel regressions.
`baguette-process.test.ts` checks real worker/native-child reaping with an isolated
fixture; lifecycle and gateway tests cover cancellation, cross-workspace exclusion,
stale stops, idle expiry, denied media access, input filtering and touch release.
The frontend controller/facade tests cover routing and the exact-origin handshake.
