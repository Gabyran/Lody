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
- All machine access goes through the injected `IosSimulatorClient`
  (`WorkspaceRuntime.iosSimulator`). The UI never builds RPC requests, proofs or tokens,
  and never displays `viewerUrl` or a tunnel address; diagnostics go through
  `buildIosSimulatorDiagnostics`.
- One Session controls a device: never offer a takeover of an occupied device. Stop and
  Cancel end the preview only; they never shut the device down, and the copy says so.
- Poll and mount the viewer only while the panel is on screen (`active`). Unmount never
  stops a preview.
- Same-machine Electron is never blocked by cloud presence reporting its machine
  offline.
