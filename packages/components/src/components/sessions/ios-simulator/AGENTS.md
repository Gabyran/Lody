# components/sessions/ios-simulator

`CLAUDE.md` symlinks here. Edit `AGENTS.md` only. Parent rules apply.
Decision and rationale:
[iOS Simulator panel note](../../../../../../.agents/notes/proposed/feature/2026-09-27-ios-simulator-panel-frontend.md).

- The iOS Simulator is its own side-panel tab (`ios-simulator`, mobile `?simulator=1`),
  never a Browser mode: no address bar, history, annotation or sharing, and no state
  shared with `SessionBrowserPanel`.
- The tab exists only when the Session's TARGET machine is a Mac; read that and the
  protocol capability through `getIosSimulatorPanelAvailability` only. An old Mac keeps
  the tab and asks for an update without calling it.
- Every machine call is `runtime.requestIosSimulatorControl` (`ios-simulator/control`).
  The UI never builds proofs or tokens, never displays `viewerUrl` or a tunnel address,
  and maps wire DTOs only in `lib/ios-simulator/ios-simulator-model.ts`.
- The viewer keeps its own origin for the exact-origin handshake, so a `viewerUrl` that
  is not http(s) or shares the app's origin is rejected, never rendered. Accept viewer
  `state` only from that frame's window, origin and operation.
- One Session controls a device: never offer a takeover of an occupied device. Stop and
  Cancel are `stop{operationId}`; they end the preview only, never shut the device down.
- Poll only while preparing, bounded, and only while on screen. A hidden panel keeps
  the viewer mounted and sends `visibility`; unmount never stops a preview.
- Same-machine Electron is never blocked by cloud presence reporting its machine
  offline.
