/**
 * Shared max content width for the session conversation column.
 *
 * Consumed via `ConversationColumn`
 * (`@/components/shared/conversation-column`) — the message thread rows, the
 * child-tab suggestions, pinned-message content, context strip, composer
 * content, floating permission surface, and notification prompt all render
 * inside it so they read as ONE centered column, declared once here.
 *
 * Why this is a repeated inner wrapper and NOT a single page-level parent:
 * the message list is a virtua `VList` whose scroller must span the full pane
 * (scrollbar at the pane edge, wheel works over the side margins), and the
 * composer/strip band paints a full-bleed background. Backgrounds + scroll
 * containers stay full-width; each region mounts one `ConversationColumn`.
 *
 * Horizontal gutter MUST live on `ConversationColumn` (not on the VList):
 * Virtua positions rows with `position:absolute; left:0`, which is relative to
 * the padding edge and therefore ignores the scroller's horizontal padding.
 * Putting `px-*` only on the VList made agent/user avatars flush to the screen
 * edge while the header and composer (normal flow) stayed inset.
 *
 * Do not put `ml-*` / left margin on `ConversationColumn` instances: it
 * overrides the auto left margin from `mx-auto` and pins that row to the
 * pane edge. Indent with padding or an inner wrapper instead.
 */
/** Horizontal inset shared by stream rows, context strip, composer. */
export const CONVERSATION_GUTTER_X_CLASS = 'px-[14px] sm:px-[18px]';

// 768px of content (48rem), plus the gutter on each side: the column caps the
// CONTENT box, so the max width adds the per-breakpoint gutter (14px / 18px).
// Narrow enough for prose to stay readable; blocks whose layout is set by their
// content rather than by line length break out of it (see below).
export const CONVERSATION_CONTENT_WIDTH_CLASS = `mx-auto w-full max-w-[calc(48rem+28px)] sm:max-w-[calc(48rem+36px)] ${CONVERSATION_GUTTER_X_CLASS}`;

/**
 * Wide blocks — tables, fenced code and diffs, Mermaid diagrams, display math,
 * and tool diffs/terminal output — grow past the prose column when their
 * content needs it, centred on the column, up to the pane width less
 * `sideReservePx` on each side. There is no absolute cap: on a large screen a
 * long diff line uses the whole pane rather than scrolling beside empty space.
 * Narrower content keeps the column width.
 *
 * Returned as a CSS length for the `--conversation-wide-block-max-width`
 * variable, which the `.conversation-wide-*` rules in `tailwind/index.css` read.
 * `100cqw` resolves against the conversation pane's `@container` (the stream's
 * `ContainerQueryProvider`): no container may sit between it and a wide block.
 * Outside the stream the variable is unset and the rules fall back to 100%.
 */
export function conversationWideBlockMaxWidth(sideReservePx: number): string {
  return `calc(100cqw - ${2 * sideReservePx}px)`;
}
