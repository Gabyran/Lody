# iOS Simulator

`CLAUDE.md` is a symlink to this file. CLI ancestor rules apply.

- `service.ts` owns ephemeral workspace/session preview operations; `control-leases.ts`
  is the machine Worker singleton that excludes other sessions across workspaces.
  Acquire before boot/download, revoke inputs and join cleanup before release. A stale
  operation must never release a replacement lease. Do not persist devices, frames,
  connection credentials, or heartbeats in Repo metadata.
- `devices.ts` is the only simctl adapter. Validate foreign JSON and UDIDs; invoke
  argv directly. Listing never downloads a runtime, starts devices or opens a tunnel.
- `gateway.ts` exposes only the fixed viewer and the bound device's stream. It is
  behind the authenticated preview proxy; never forward arbitrary Baguette routes or
  messages. Validate every input and active lease. Frames/status probes do not renew
  idle expiry; only explicit viewer heartbeat or valid input does.
- `viewer.ts` is the fixed iframe artifact, without React or annotation injection.
  Parent commands bind source, origin and operation id. Decode at most one JPEG
  with one replaceable pending frame; release touches on blur/cancel/disconnect.
- `baguette-worker.ts` owns the native process through an IPC lease. Owner loss must
  reap it; never terminate the worker as normal cleanup. All build compositions emit
  the same sibling worker entry. No user simulator is shut down during cleanup.
- Keep Baguette version, artifact digest and executable digest pinned in the manifest;
  no PATH/Homebrew discovery or upstream fallback. Fetch through the platform runtime
  artifact channel. License notices accompany the managed installation; see [README](README.md).
- Local controls use trusted Machine RPC without Cloud I/O. Remote commands require
  exact signed preview-control proofs, including list/status and the ephemeral response
  key. Never put a viewer URL in workspace-readable Streams. Revocation fences proof
  verification as well as startup; owner/machine reassignment closes existing viewers.
  Browser and Simulator have independent service/proxy owners and share only transport
  primitives. There is no simulator sharing route or anonymous viewer grant.
- Agent starts reserve/prepare but defer capture and transport selection to the first
  authorized panel start/status. Agent reads never attach or renew; cancellation and
  idle expiry must settle that wait and release its lease. Agent ingress derives the
  active invocation user in the daemon; never accept an agent-supplied requester.
