# iOS Simulator side panel: frontend

Status: proposed
Translation: current

[中文](2026-09-27-ios-simulator-panel-frontend.zh.md)

## Abstract

A Session running on a Mac needs a way to see and drive that Mac's iOS Simulators from Lody,
without the Browser tab growing simulator flags and without exposing the Mac to anyone else.
The frontend adds an independent iOS Simulator side-panel tab (and a mobile drill), shown only
when the Session's target machine is a Mac. Every machine call goes through one typed Machine RPC,
`ios-simulator/control`, reached directly on the same machine and with a signed preview-control
proof otherwise; the viewer page is a separate origin the panel greets with an exact-origin
handshake. The panel, facade wiring and tests are implemented against the shared contract, whose
types, local schema and remote client are owned and landed separately; nothing here has run
against a real simulator yet.

## Decision

- **A separate tab, not a Browser mode.** `ios-simulator` is its own persisted side-panel tab id
  beside `browser`, with its own state, its own `?simulator=1` mobile drill and its own
  controller keyed by Session and machine. It has no address bar, history, annotation or share
  action: a simulator preview is never shared.
- **Gated on the target machine.** The tab exists only when the Session's machine meta says
  `os === 'darwin'`. A Mac without the `iosSimulator` protocol still shows the tab, which asks for
  an update instead of calling anything; `getIosSimulatorPanelAvailability` is the one reader.
- **One RPC, auth below the UI.** `WorkspaceRuntime.requestIosSimulatorControl` carries a command
  (`list`, `start`, `status`, `stop`). On the local plane it goes to this machine's daemon with no
  proof and no cloud; otherwise it checks the protocol, then signs the exact command through the
  existing preview-control nonce and proof path. Transport failures resolve as
  `{ success: false, error: 'failed' }`. `lib/ios-simulator/ios-simulator-model.ts` is the only
  place that maps wire DTOs onto view state.
- **Operations, not a session.** `list` never boots. `start` answers with an operation, whose
  `status` is polled every second while preparing, booting or connecting — at most 180 times, then
  shown as a timeout with Try again and Stop. Ready is not polled. Cancel and Stop are
  `stop{operationId}`; Restore after `closed` is a new `start`.
- **Viewer handshake.** After each load the panel posts `init {operationId, visible}` to the
  viewer's exact origin, accepts `state` only from that frame's window, origin and operation, and
  posts `visibility` when the panel or document is hidden or shown. The frame stays mounted while
  hidden. It keeps its own origin (`allow-scripts allow-same-origin`) so the handshake can name it,
  which is safe only because a `viewerUrl` that is not http(s) or shares the app's origin is
  rejected. The address is never displayed; copied diagnostics omit it and redact URLs, tokens,
  UUIDs and home-directory user names.
- **Control, not takeover.** Every device stays listed (grouped by runtime, searchable,
  filterable) with its state and occupancy. A device another Session controls offers no action.
  Stopping never shuts the device down, and the copy says so wherever Stop or Cancel appears.
- **Local vs remote.** Same-machine Electron (`localMachineIdAtom` equals the Session machine) is
  never blocked by cloud presence reporting the machine offline; the status control says Direct.
  A remote preview says Remote and shows no tunnel address.
- **Selection.** A device chosen in the panel wins, then this Session's live preview, then the
  remembered device (`lody:iosSimulatorSelectedDevice:<workspace>:<machine>:<session>`, a
  preference that survives cache clears), then a held, booted, or free device.

## Alternatives considered

- Extending `SessionBrowserPanel` with a simulator engine: rejected by the request ("no Browser
  flag soup") and because the Browser's address, history, annotation and sharing all have to be
  absent here.
- A frontend-only client port the runtime would adapt to (the first draft on this branch):
  superseded once the parent fixed one typed command RPC; the facade now calls it directly.
- `sandbox="allow-scripts"` alone: the frame would have an opaque origin, which an exact-origin
  `postMessage` cannot address.

## Verification and limits

- `tests/ios-simulator-model.test.ts` (runtime parsing, state normalisation, grouping, status
  mapping and viewer-origin rejection, actions, selection, handshake parsing, preference scope,
  redaction), `tests/session-ios-simulator-panel.test.tsx` (upgrade and offline gates, same-machine
  bypass, start and bounded polling to ready, exact-origin handshake and foreign-source rejection,
  visibility while hidden, cancel by operation, timeout, restore after close, occupancy without
  takeover, diagnostics) and three `workspace-machine-rpc-facade` cases (local route without proof
  or cloud, remote proof over the exact command, unsupported remote before any handshake).
- Storybook `Sessions/iOS Simulator/Panel` covers every state; checked in Chromium.
- Not verified: the real daemon, viewer page, tunnel, or screen sizes (the contract carries none;
  aspect-fit uses a per-family default).
