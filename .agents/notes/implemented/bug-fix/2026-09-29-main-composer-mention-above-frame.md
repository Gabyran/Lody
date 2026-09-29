# Keep the main composer mention menu above the caret

Status: implemented
Translation: current

[中文版](2026-09-29-main-composer-mention-above-frame.zh.md)

## Abstract

The main composer mention menu follows the caret and prefers the space above
it. Long command descriptions no longer stretch the popup across the desktop.

## Decision

The main chat composer prefers `menuSide="top"` but retains the caret anchor.
Anchoring to `[data-mention-frame]` kept a long menu above the input, but left
completions behind as the user typed; a browser test measured the menu at the
frame's x=336px even after the caret moved to x≈445px. The frame anchor remains
available for other explicit callers and for the mobile dock, not this desktop
menu.

The floating positioner can flip the preferred top menu when the caret is near
the top edge. It also writes an inline `max-width` based on the viewport. That
inline value overrode the menu's input-width cap: with a 1422px input in a
2048px desktop, a long synthetic command description expanded the popup to
2048px. The menu now gives its input-width cap precedence over the positioner's
inline width while preserving viewport fit. Default caret menus, including
inline edit and dialog surfaces, still prefer below and flip when needed.

## Verification

Playwright tests use the session composer with 24 synthetic commands. At
2048×1098, a long description reproduces the original horizontal overflow
before the width fix and remains within the 1422px input afterward. Tests also
cover caret movement, a top-edge fallback, scrolling and keyboard selection,
focus, resize, editor scale, and an inline editor at mobile width. Before/after
screenshots use the same wide desktop viewport. An earlier 650×250 screenshot
was an invalid proxy for a desktop window, whose minimum height is 600px; it is
superseded by the wide-viewport evidence. Packaged Electron behavior remains
unverified.

## Links

- [Placement Spec](../../../../specs/composer-mention-menu-placement.md)
- [Composer caller](../../../../packages/components/src/components/chat/chat-composer.tsx)
- [Placement test](../../../../packages/components/tests/e2e/composer-mention-placement.spec.ts)
- [PR #1140](https://github.com/LodyAI/Lody/pull/1140)
