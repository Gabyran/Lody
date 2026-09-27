# Conversation wide blocks

Status: implemented
Translation: current

[中文](2026-09-27-conversation-wide-blocks.zh.md)

## Abstract

The conversation column caps content at 768px so prose keeps a readable measure, but
tables, code, diagrams, display math, diffs and terminal output are laid out by their
content, not by line length: in the column they scroll sideways or wrap even when the
pane has hundreds of spare pixels. On a pane of at least 1024px these blocks now grow to
the width their content needs, centred on the column, up to 72rem and to the pane less
the outline rail and gutter on each side; narrower content keeps the column width.
This partly reverses the [reading-contrast decision](2026-09-24-reading-contrast.md),
which reverted an earlier breakout because blocks jutting out of the column looked odd.
Whether sizing to content and the 1024px gate answer that is a judgement for review in
the app.

## Problem

`CONVERSATION_CONTENT_WIDTH_CLASS` holds every row to 768px. That width is right for
prose and wrong for content whose layout is fixed by the content itself: an eight-column
table wraps every cell, a long code line scrolls, a left-to-right flowchart is clipped
behind a scrollbar, and terminal output built from aligned columns wraps mid-column. On
a desktop pane the margins beside the column stay empty.

## Decision

- **What grows**: top-level Markdown tables, fenced code (including `diff` fences),
  Mermaid blocks and display math in assistant prose, plus tool diffs and terminal
  output in activity rows. Prose, headings, lists, quotes, images, user messages and
  bordered panels (plans, tool content Markdown, cards) keep the column.
- **How wide**: `width: max-content`, never below the column (`min-width: 100%`), capped
  by `--conversation-wide-block-max-width` = `min(100cqw - 2 × (rail + 18px), 72rem)`.
  A short code block or a two-column table therefore keeps exactly the column width, and
  content wider than the cap still scrolls inside its block.
- **Where**: `left: 50%` plus `translate: -50%` centre the block on the column at any
  width. The column itself is centred in the pane, so the block stays clear of the
  left outline rail at the same margin on both sides.
- **When**: only when the pane is at least 1024px wide (a container query on the
  pane's `@container`). Below that the gain is under 60px a side and reads as a
  misaligned edge.
- The old diff workaround, which let a whole assistant row scroll sideways with a
  480px minimum, is removed; the diff block now owns its width and overflow.

## Responsibilities

- `lib/conversation-layout.ts` owns the cap (`conversationWideBlockMaxWidth`,
  `CONVERSATION_WIDE_BLOCK_MAX_WIDTH_REM`).
- `ai-gui/view.tsx` sets the variable on the stream's scroll container (reserving
  `RAIL_WIDTH` + 18px), opts assistant prose in through `MarkdownBlock`'s `wideBlocks`,
  and tags activity-row diffs and terminals with `conversation-wide-block`.
- `tailwind/index.css` holds the one rule. Outside the stream the variable is unset,
  the cap falls back to 100%, and the rule is a no-op.

## Alternatives

- **Keep every block in the column**: the reading-contrast outcome, after an earlier
  breakout was reverted in review. Wide content keeps scrolling or wrapping beside
  empty margins. Sizing to content means only blocks that need the room leave the column.
- **Extend only to the right, left edge on the rail**: keeps the left edge aligned, but
  uses only half the spare width and makes the column read as off-centre.
- **Widen the whole column**: loses the prose measure the column exists for.
- **Negative margins instead of a transform**: require knowing the block's final width,
  which is content-sized; only the transform centres an unknown width.

## Verification and limits

- Chromium via Storybook (`Sessions/SessionConversationPage` → Desktop Reading Review,
  1600px viewport, 1150px pane): the eight-column table grew to 955px, a long code line
  and display formula to 966–1014px, the Mermaid flowchart and wrapped terminal output to
  the 1014px cap; the narrow table, short code block and top-down diagram stayed at
  768px. Every block's centre matched the column's. At a 1000px viewport every block
  stayed at 768px.
- Mermaid activation and pointer-anchored pinch zoom still work inside a translated
  block.
- The tool `DiffViewer` does not render its body in headless Storybook, before or after
  this change. A synthetic element copying the `@pierre/diffs` code grid (a content-sized number
  column, a `1fr` code column, `white-space: pre`) grew to the cap inside the real
  wrapper; the real component was not observed.
- A streaming code block widens as longer lines arrive.
