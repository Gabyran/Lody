import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { FoldHorizontal, UnfoldHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';

/**
 * Marks the conversation stream's scroll container. It carries
 * `--conversation-wide-block-max-width`; a block outside it (a portaled peek, a
 * file preview) has nothing to grow into, so its toggle never shows.
 */
export const CONVERSATION_WIDE_SCOPE_ATTR = 'data-conversation-wide-scope';

/**
 * Blocks that may widen on request. Markdown blocks qualify only at the top
 * level of assistant prose (a nested one would centre on its list or quote);
 * tool diffs and terminals opt in with `conversation-wide-block`. A previewed
 * Markdown fence holds prose, which keeps the column's measure.
 */
const WIDE_BLOCK_SELECTOR = [
  '.conversation-wide-markdown > div > [data-markdown-table-frame]',
  ".conversation-wide-markdown > div > [data-streamdown='code-block']:not([data-markdown-preview='true'])",
  ".conversation-wide-markdown > div > [data-streamdown='mermaid-block']",
  '.conversation-wide-block',
].join(', ');

const CANDIDATE_SELECTOR =
  "[data-markdown-table-frame], [data-streamdown='code-block'], [data-streamdown='mermaid-block'], .conversation-wide-block";

/** Elements whose own horizontal scroll means the content is wider than the block. */
const SCROLLER_SELECTOR =
  "[data-markdown-table], [data-streamdown='code-block-body'], [data-streamdown='mermaid'] > div";

/** The tool diff's code grid, inside the `@pierre/diffs` shadow root. */
const SHADOW_SCROLLER_SELECTOR = '[data-code]';

/** Elements that wrap instead of scrolling: table cells and terminal output. */
const WRAPPING_SELECTOR = 'th, td, pre';

/** Visual lines of an element's text, counted by distinct line-box tops. */
function visualLineCount(element: Element): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  const tops = new Set<number>();
  for (const rect of range.getClientRects()) {
    if (rect.width > 0) tops.add(Math.round(rect.top));
  }
  return tops.size;
}

/** Lines the text would have with unlimited width: hard breaks plus one. */
function logicalLineCount(element: Element): number {
  const text = element.textContent ?? '';
  return text.replace(/\n$/u, '').split('\n').length + element.querySelectorAll('br').length;
}

/**
 * Whether the block's content is wider than the block: something scrolls
 * sideways, or wraps where it would not with room. Wrapping is only checked
 * on the block's own text, so a code block in wrap mode counts as fitting.
 */
export function wideBlockNeedsRoom(block: Element): boolean {
  const overflows = (scroller: Element) => scroller.scrollWidth > scroller.clientWidth + 1;
  for (const scroller of block.querySelectorAll(SCROLLER_SELECTOR)) {
    if (overflows(scroller)) return true;
  }
  for (const host of block.querySelectorAll('*')) {
    const scroller = host.shadowRoot?.querySelector(SHADOW_SCROLLER_SELECTOR);
    if (scroller && overflows(scroller)) return true;
  }
  if (block.matches('[data-streamdown="code-block"], [data-streamdown="mermaid-block"]')) {
    return false;
  }
  for (const element of block.querySelectorAll(WRAPPING_SELECTOR)) {
    if (element.closest('[data-streamdown="code-block"]')) continue;
    if (visualLineCount(element) > logicalLineCount(element)) return true;
  }
  return false;
}

/**
 * Lets the reader widen one block past the prose column. The block grows to
 * its content (up to the pane), centred on the column, with an animated width
 * (`tailwind/index.css`, `[data-wide-expanded]`); a second click puts it back.
 * Only shown where widening helps: inside the conversation stream, on a pane of
 * at least 1024px (CSS), and when the content is wider than the block or the
 * block is already expanded.
 *
 * The block is found from the button's own position, so the same control sits
 * in a code toolbar, a Mermaid action bar, a table's hover actions, a diff
 * header or a terminal's hover corner.
 */
export function WideBlockToggle({ className }: { readonly className?: string }) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [block, setBlock] = useState<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [needsRoom, setNeedsRoom] = useState(false);

  useLayoutEffect(() => {
    const candidate =
      buttonRef.current?.parentElement?.closest<HTMLElement>(CANDIDATE_SELECTOR) ?? null;
    const eligible =
      candidate !== null &&
      candidate.matches(WIDE_BLOCK_SELECTOR) &&
      candidate.closest(`[${CONVERSATION_WIDE_SCOPE_ATTR}]`) !== null;
    setBlock(eligible ? candidate : null);
  }, []);

  const measure = useCallback(() => {
    if (block) setNeedsRoom(wideBlockNeedsRoom(block));
  }, [block]);

  useEffect(() => {
    if (!block) return undefined;
    measure();
    const stopObserving = observeResizeOnAnimationFrame(block, measure);
    // Content can outgrow the block without resizing it (a code block's
    // streamed lines, a diagram that finishes rendering), and hover is when
    // the reader looks for the control.
    block.addEventListener('pointerenter', measure);
    return () => {
      stopObserving();
      block.removeEventListener('pointerenter', measure);
    };
  }, [block, measure]);

  useEffect(() => {
    if (!block) return undefined;
    if (expanded) block.setAttribute('data-wide-expanded', 'true');
    else block.removeAttribute('data-wide-expanded');
    return () => block.removeAttribute('data-wide-expanded');
  }, [block, expanded]);

  const label = expanded
    ? t('sessions.wideBlock.collapse', 'Fit to column')
    : t('sessions.wideBlock.expand', 'Widen to fit content');
  const Icon = expanded ? FoldHorizontal : UnfoldHorizontal;
  const available = block !== null && (expanded || needsRoom);

  return (
    <button
      ref={buttonRef}
      type="button"
      data-wide-block-toggle=""
      hidden={!available}
      aria-label={label}
      aria-pressed={expanded}
      title={label}
      // Diff and terminal headers toggle their card on click; this must not.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        setExpanded((current) => !current);
      }}
      className={className}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
