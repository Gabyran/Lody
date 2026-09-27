# iOS Simulator preview

Status: draft
Translation: current

[中文](ios-simulator-preview.zh.md)

A session assigned to a macOS machine can open an iOS Simulator panel beside Browser.
The list comes from that target machine, independent of the viewer's OS. Listing is
read-only: no download, boot or tunnel. Show unavailable runtimes and device occupancy.
A stopped device offers Start and preview; a running device offers Preview.

The panel contains a device selector, connection status and an aspect-fit interactive
screen. Connection details offer cancellation, retry and stop. Hide addresses, browser
navigation and annotation. Simulator preview has no sharing controls, public links or
anonymous viewing. Custom hardware/configuration controls are future typed capabilities.

Same-machine Electron uses direct local transport, including offline operation. Remote
viewing by the authorized session uses Quick Tunnel internally. Both routes authorize
access; remote control binds a short-lived proof to the exact session, device/operation,
action and daemon instance. OS controls discoverability; a versioned machine capability
controls compatibility. Public local-only builds make no authenticated cloud calls.

Each device allows only one controlling Lody session across all workspaces on the
machine. Other sessions show occupied, with no takeover. Native Simulator tools remain
outside this coordination. Browser and simulator previews coexist independently.
Repeated starts coalesce. Stop also cancels preparation; stale completions cannot restore
a cancelled connection. Switching devices releases the previous device. Cleanup closes
viewers and owned native processes before releasing control, but never shuts down a
Simulator device. Session archive/delete and daemon exit clean up their operations.

Hidden viewers stop decoding, input and heartbeat. Hiding does not immediately end the
operation. The connection expires after one hour without foreground heartbeat or valid
input; emitted video, polling and probes do not renew it. Devices/frames/endpoints are
in-memory runtime state; selected-device preferences are client-local and scoped to the
account/workspace/session/machine. Credentials never enter session documents.

The initial stream uses MJPEG with bounded decoding/backpressure and single-pointer
input. H.264, multi-touch, keyboard and device configuration require separate acceptance.
Readiness separates preparation/transport from the first decoded frame.

Evidence: [design note](../.agents/notes/implemented/architecture/2026-09-27-ios-simulator-panel.md),
[CLI boundary](../apps/cli/src/ios-simulator/AGENTS.md). Implementation and validation are
recorded in the note; this draft does not claim human approval or deployment.

Remote viewer credentials are encrypted to an ephemeral requester key bound into the signed command. Other workspace members cannot recover them by reading retained RPC streams. Revocation covers in-flight authorization; owner or machine reassignment invalidates existing viewers.
