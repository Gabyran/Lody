# iOS Simulator side panel: frontend

Status: proposed
Translation: current

[中文](2026-09-27-ios-simulator-panel-frontend.zh.md)

## Abstract

A Session running on a Mac needs a way to see and drive that Mac's iOS Simulators from Lody,
without the Browser tab growing simulator flags and without exposing the Mac to anyone else.
The frontend adds an independent iOS Simulator side-panel tab (and a mobile drill), shown only
when the Session's target machine is a Mac. It talks to the machine through one injected
`IosSimulatorClient` port, so every Machine RPC and all authentication stay with the runtime that
implements it. The panel, its states and tests are implemented; the typed RPC contract, the
viewer page and the runtime implementation are owned elsewhere and not yet integrated, so
nothing here has run against a real simulator.

## Decision

- **A separate tab, not a Browser mode.** `ios-simulator` is its own persisted side-panel tab id
  beside `browser`, with its own state, its own `?simulator=1` mobile drill and its own
  controller keyed by Session and machine. It has no address bar, history, annotation or share
  action: a simulator preview is never shared.
- **Gated on the target machine.** The tab exists only when the Session's machine meta says
  `os === 'darwin'`. A Mac whose Lody predates the protocol still shows the tab, which asks for an
  update instead of calling anything; `getIosSimulatorPanelAvailability` is the one place that
  reads the capability (currently the placeholder key `iosSimulator` v1, pending the shared
  contract).
- **One port, no auth in the UI.** `lib/ios-simulator/ios-simulator-types.ts` defines view types
  and `IosSimulatorClient` (`list`, `startPreview`, `status`, `cancelStart`, `stopPreview`),
  injected as the optional `WorkspaceRuntime.iosSimulator`. Transport failures reject; domain
  failures resolve as values. The only capability the UI touches is the opaque `viewerUrl`,
  loaded into a `no-referrer` iframe and never printed; copied diagnostics omit it and redact URLs,
  tokens, UUIDs and home-directory user names.
- **Control, not takeover.** Every device stays listed (grouped by runtime, searchable, filterable)
  with its state and occupancy. A device another Session controls shows who holds it when the
  requester may see that Session, and offers no action. Stopping a preview never shuts the device
  down, and the copy says so wherever Stop or Cancel appears.
- **Direct vs remote.** Same-machine Electron (`localMachineIdAtom` equals the Session machine) is
  never blocked by cloud presence reporting the machine offline; the status control says Direct.
  A remote preview says Remote and shows no tunnel address.
- **Visibility owns cost.** Polling (1.5 s while preparing, 15 s while ready) and the viewer iframe
  exist only while the panel is on screen; a hidden or collapsed panel holds no stream open.
  Unmounting never stops a preview (panel mount is not preview ownership).
- **Selection.** A device chosen in the panel wins, then this Session's live preview, then the
  remembered device (`lody:iosSimulatorSelectedDevice:<workspace>:<machine>:<session>`, a
  preference that survives cache clears), then a held, booted, or free device.

## Alternatives considered

- Extending `SessionBrowserPanel` with a simulator engine: rejected by the request ("no Browser
  flag soup") and because the Browser's address, history, annotation and sharing all have to be
  absent here.
- Calling `runtime.requestIosSimulator*` methods shaped like the Browser's: rejected so the
  frontend does not invent the authenticated wire contract; the runtime adapts its DTOs to the
  port instead.

## Verification and limits

- `tests/ios-simulator-model.test.ts` (grouping, actions, selection, polling, preference scope,
  redaction) and `tests/session-ios-simulator-panel.test.tsx` (upgrade and offline gates,
  same-machine bypass, start/boot, cancel racing a late start, stop, occupancy without takeover,
  visibility-gated polling and viewer, diagnostics) exercise the panel against a fake client.
- Storybook `Sessions/iOS Simulator/Panel` covers every state in light, dark, English and Chinese;
  checked in Chromium.
- Not verified: the real RPC contract, viewer handshake, remote tunnel, and whether
  `startPreview` on a second device atomically releases the first (the UI assumes it does and
  says so).
