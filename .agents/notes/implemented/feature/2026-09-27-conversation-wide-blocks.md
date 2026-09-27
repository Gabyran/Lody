# Conversation wide blocks

Status: implemented
Translation: current

[中文](2026-09-27-conversation-wide-blocks.zh.md)

## Abstract

The conversation column caps content at 768px so prose keeps a readable measure, but
tables, code, diagrams, diffs and terminal output are laid out by their content: in the
column they scroll sideways or wrap even when the pane has hundreds of spare pixels. On a
pane of at least 1024px, each such block now offers a toggle that widens it to the width
its content needs, centred on the column and bounded only by the pane, with an animated
width; display math, which cannot wrap, widens by itself. Widening every block
automatically was implemented and rejected in review: blocks of different widths moved
where each one started, and the eye had to hunt for the next line. This partly revisits
the [reading-contrast decision](2026-09-24-reading-contrast.md), which kept every block
in the column.

## Problem

`CONVERSATION_CONTENT_WIDTH_CLASS` holds every row to 768px. That width is right for
prose and wrong for content whose layout is fixed by the content itself: an eight-column
table wraps every cell, a long code line scrolls, a left-to-right flowchart is clipped
behind a scrollbar, and terminal output built from aligned columns wraps mid-column. On
a desktop pane the margins beside the column stay empty.

## Decision

- **Widening is the reader's choice.** Tables, fenced code (including `diff` fences),
  Mermaid blocks, tool diffs and terminal output keep the column width until the reader
  clicks `WideBlockToggle`; a second click restores it. Where a block already has
  controls the toggle joins them (code toolbar, Mermaid action bar, table hover
  actions beside Copy, tool diff header); a terminal has none, so the toggle waits in
  its top-right corner on hover. Icons: `UnfoldHorizontal` to widen, `FoldHorizontal`
  to restore.
- **Display math widens by itself.** A formula cannot wrap and is read as one unit.
- **The toggle appears only where it helps**: inside the conversation stream, on a pane
  of at least 1024px, and when the block's content is wider than the block (something
  scrolls sideways, or table cells or terminal lines wrap) or the block is already
  widened. A narrow table, a short code block or a top-down diagram shows none.
- **How wide**: `calc-size(max-content, min(size, cap))`, never narrower than the
  column. The cap, `--conversation-wide-block-max-width`, is the pane less the outline
  rail and 18px gutter on each side (`100cqw - 136px`), with no absolute limit, so the block stops exactly where its content no longer needs a scrollbar.
- **Where**: `left: 50%` plus `translate: -50%` on every candidate block, collapsed
  included (they cancel at the column width), so only the width animates (220ms,
  ease-out). `calc-size()` makes the width interpolable; WebKit lacks it and snaps.
  Reduced motion turns the transition off.
- **Scope**: only top-level Markdown blocks in assistant prose and activity-row tool
  diffs/terminals. Prose, lists, quotes, images, user messages, nested Markdown blocks
  and bordered panels (plans, tool-content Markdown, cards) never widen.
- The old diff workaround, which let a whole assistant row scroll sideways with a 480px
  minimum, is removed; the diff block owns its overflow.

## Responsibilities

- `ai-gui/wide-block-toggle.tsx` owns the control: which block it belongs to (found from
  its own position), whether that block qualifies and needs room, and the
  `data-wide-expanded` attribute it sets on the block.
- `tailwind/index.css` owns the geometry: centring, the width transition, the expanded
  width, automatic display math, and the 1024px pane gate for both widening and the
  toggle.
- `lib/conversation-layout.ts` owns the cap (`conversationWideBlockMaxWidth`);
  `ai-gui/view.tsx` sets it and `data-conversation-wide-scope` on the stream's scroll
  container.
- Hosts: `markdown-code-block.tsx`, `markdown-table.tsx`, `markdown-renderer.tsx`
  (Mermaid action portal), `terminal-component.tsx` (`wideToggle`) and `DiffViewer`'s
  `headerAccessory`.

## Alternatives

- **Widen automatically to content width**: implemented first and reviewed in the app.
  Each block started at a different x position, so the reading start kept moving.
  Rejected for everything except display math.
- **Automatic widening with a 72rem cap**: also tried; on a large screen a `diff` fence
  stopped at 1152px and scrolled beside empty margins. The on-request version keeps no
  absolute cap for the same reason.
- **Keep every block in the column**: the reading-contrast outcome. Wide content keeps
  scrolling or wrapping beside empty margins.
- **Always show the toggle**: a control that does nothing on a block that already fits
  is noise; it appears only when the content is wider than the block.
- **Negative margins instead of a transform**: require knowing the block's final width,
  which is content-sized; only the transform centres an unknown width.

## Verification and limits

- Chromium 145 via Storybook (`Sessions/SessionConversationPage` → Desktop Reading
  Review, 1600px viewport, 1150px pane): every block starts at 768px except display math
  (966px). Toggles appear on the wide table, the long code line, the `diff` fence, the
  left-to-right Mermaid diagram and the terminal, and not on the narrow table, the short
  code block or the top-down diagram. Widening: table 955px (its content width), code
  line, Mermaid and terminal 1014px (the pane bound); the label switches to "Fit to
  column". Per-frame samples of a widening code block: 768 → 855 (27ms) → 976 (94ms) →
  1014px (≈220ms). At a 1000px viewport every toggle is hidden and every block,
  math included, stays at 768px.
- With the cap variable raised to 3000px to stand in for a large pane, the long code
  line settled at 1224px, exactly its scroll width.
- Mermaid activation and pointer-anchored pinch zoom still work inside a translated
  block.
- The tool `DiffViewer` does not render its body in headless Storybook, before or after
  this change, so its toggle and widening were not observed; the header control and the
  shadow-root overflow check are in place.
- A block's widened state lives in its toggle and is lost when Virtua unmounts the row,
  like a code block's wrap toggle.
- No unit test: jsdom computes no layout, so whether a block needs room, and its width,
  cannot be observed there.
