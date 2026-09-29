# Pin the main chat composer's mention menu above its frame

Status: implemented
Translation: current

[中文版](2026-09-29-main-composer-mention-above-frame.zh.md)

## Abstract

The main desktop chat composer inherited the caret menu's downward preference,
so a long slash-command panel could extend across the composer and beyond the
visible area. The main composer now explicitly uses the existing frame anchor
and pins its mention menu above it. The menu receives the frame's width and
available-height caps; the dialog composer and inline editor retain caret
placement. Browser verification remains pending in this checkout.

## Decision

`ChatComposer` selects `menuAnchor="composer"` and `menuSide="top"` for its
framed, non-dialog branch. `MentionContent` already measures
`[data-mention-frame]`, disables flipping for that anchor, and caps height to
the space above. The menu's list already scrolls inside that cap. This restores
the main composer's fixed placement without changing the shared primitive or
the dialog and inline callers.

The earlier [caret-placement decision](2026-09-29-composer-mention-follows-caret.md)
still describes the caret measurement and the floating editor's behavior; its
default is no longer the main chat composer's choice. The earlier
[top-pinning decision](2026-09-26-mention-menu-pinned-above-input.md) explains
why a menu attached to this frame stays above it even when the list grows.

## Verification

The owning composer test opens a real slash-command menu and checks the upper
room cap, frame-width variable, and top-side placement. Dependencies are absent
from this nested checkout, so the test and browser rendering could not be run
here. The repository documentation check found no errors in the changed files;
it still reports broken links to absent submodules elsewhere in this checkout.

## Links

- [Placement Spec](../../../../specs/composer-mention-menu-placement.md)
- [Composer caller](../../../../packages/components/src/components/chat/chat-composer.tsx)
- [Composer test](../../../../packages/components/tests/chat-composer-focus.test.tsx)
