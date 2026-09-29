# Keep the main composer mention menu above the caret

Status: implemented
Translation: current

[中文版](2026-09-29-main-composer-mention-above-frame.zh.md)

## Abstract

The main composer mention menu follows the caret above it. It falls below only
when the top edge cannot fit one option, rather than anchoring to the frame or
disappearing at zero height.

## Decision

The main chat composer prefers `menuSide="top"` but retains the caret anchor.
Anchoring to `[data-mention-frame]` kept a long menu above the input, but left
completions behind as the user typed; a browser test measured the menu at the
frame's x=336px even after the caret moved to x≈445px. The frame anchor remains
available for other explicit callers and for the mobile dock, not this desktop
menu.

The floating positioner normally flips an oversized top menu below the caret.
For an explicit top caret menu, `MentionContent` keeps that side while one row
fits, and caps the surface to the visible room above the caret. At the top edge
where no row fits, it falls below rather than rendering a zero-height menu. The list scrolls within
the cap. A short viewport with one result group hides its redundant heading so
the first option remains visible; multi-group labels and a category's Back
control remain available. Default caret menus, including inline edit and
dialog surfaces, still prefer below and flip when needed.

## Verification

Playwright tests use the real session composer with 24 synthetic commands. They
verify that typing moves the menu horizontally with the caret, the menu stays
above the caret at 650×250, its first row is visible, the top-edge fallback
returns above after a layout move, Enter selects a filtered command, and
textarea focus persists. Before/after screenshots capture the
same caret position; the pre-fix caret-following assertion failed at x=336px.
The browser story was also exercised at mobile width, with resize and editor
scale. Packaged Electron behavior remains unverified.

## Links

- [Placement Spec](../../../../specs/composer-mention-menu-placement.md)
- [Composer caller](../../../../packages/components/src/components/chat/chat-composer.tsx)
- [Placement test](../../../../packages/components/tests/e2e/composer-mention-placement.spec.ts)
- [PR #1140](https://github.com/LodyAI/Lody/pull/1140)
