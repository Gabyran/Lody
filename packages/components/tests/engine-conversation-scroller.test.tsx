// @vitest-environment jsdom
import { act, createRef, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import { EngineConversationScroller } from '../src/components/ai-gui/conversation-list/engine-conversation-scroller';
import type {
  ConversationListHandle,
  ConversationRowComponentProps,
  ConversationScrollerState,
} from '../src/components/ai-gui/conversation-list/types';
import { clearSavedScrollStates } from '../src/lib/conversation-scroll/saved-state';
import type { EngineRow } from '../src/lib/conversation-scroll/types';
import { createFrameHarness, type FrameHarness } from './support/scroll-frame-harness';

/**
 * The engine's React adapter under browser-ordered scroll events and
 * ResizeObserver deliveries (see the frame harness), with real React commits.
 * The same scenario that leaves the Virtua path hidden for good
 * (`sticky-scroll-open-stall.test.tsx`) must leave this one covered, with the
 * reader's row where it was.
 */

const VIEWPORT = 400;
const ROW = 100;

function Row({ index, ...props }: ConversationRowComponentProps) {
  return <div {...props} data-virtual-index={index} />;
}

const meta = (key: string, turnIndex: number): EngineRow => ({
  key,
  turnId: key.split('.')[0]!,
  turnIndex,
  itemIndex: key.includes('.') ? Number(key.split('.')[1]) : null,
  itemIdentity: null,
  firstItemIndex: key.includes('.') ? Number(key.split('.')[1]) : null,
  placeholder: false,
  fixed: null,
  estimate: ROW,
});

type Ctx = {
  harness: FrameHarness;
  host: HTMLElement;
  root: ReturnType<typeof createRoot>;
  handle: { current: ConversationListHandle | null };
  state: { current: ConversationScrollerState | null };
  setKeys: (keys: string[]) => void;
  viewport: () => HTMLElement;
  settle: () => Promise<void>;
};

let offsetParentDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  offsetParentDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  clearSavedScrollStates();
});

afterEach(() => {
  if (offsetParentDescriptor)
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParentDescriptor);
  vi.unstubAllGlobals();
});

function mount(sessionId: SessionId, initialKeys: string[], harnessToReuse?: FrameHarness): Ctx {
  let keys = initialKeys;
  const px = (value: string | undefined) => parseFloat(value ?? '0') || 0;
  const harness =
    harnessToReuse ??
    createFrameHarness({
      viewportHeight: () => VIEWPORT,
      scrollHeightOf: (viewport) => {
        const container = viewport.firstElementChild as HTMLElement | null;
        const spacer = container?.nextElementSibling as HTMLElement | null;
        return px(container?.style.height) + px(spacer?.style.height);
      },
      sizeOf: (element) => {
        const el = element as HTMLElement;
        if (el.hasAttribute('data-message-selection-scroll')) return VIEWPORT;
        if (el.hasAttribute('data-virtual-index')) return ROW;
        return undefined;
      },
      rectOf: (element, scrollTop) => {
        const el = element as HTMLElement;
        if (el.hasAttribute('data-message-selection-scroll')) return { top: 0, height: VIEWPORT };
        if (
          el.parentElement?.hasAttribute('data-message-selection-scroll') &&
          !el.hasAttribute('data-conversation-reply-room')
        )
          return { top: -scrollTop, height: px(el.style.height) };
        if (el.hasAttribute('data-virtual-index'))
          return { top: px(el.style.top) - scrollTop, height: ROW };
        return undefined;
      },
    });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const handle = createRef<ConversationListHandle>() as { current: ConversationListHandle | null };
  const state: Ctx['state'] = { current: null };
  let attached = false;
  const onStateChange = (next: ConversationScrollerState) => {
    state.current = next;
    if (next.scrollElement && !attached) {
      attached = true;
      harness.attachViewport(next.scrollElement);
    }
  };
  const render = () =>
    root.render(
      <EngineConversationScroller
        sessionId={sessionId}
        rows={keys.map((key): ReactElement => (
          <div key={key} data-row-key={key}>
            {key}
          </div>
        ))}
        rowMeta={keys.map((key, index) => meta(key, index))}
        item={Row}
        initialWindowReady
        onStateChange={onStateChange}
        layoutKey="14"
        bufferSize={800}
        handleRef={handle}
      />
    );
  act(render);
  return {
    harness,
    host,
    root,
    handle,
    state,
    viewport: () => host.firstElementChild as HTMLElement,
    setKeys(next) {
      keys = next;
      act(render);
    },
    async settle() {
      for (let i = 0; i < 30; i++) {
        let delivered = false;
        await act(async () => {
          delivered = harness.frame();
          await Promise.resolve();
        });
        if (!delivered) return;
      }
      throw new Error('frames did not settle');
    },
  };
}

function unmount(ctx: Ctx, restoreHarness = true) {
  act(() => ctx.root.unmount());
  ctx.host.remove();
  if (restoreHarness) ctx.harness.restore();
}

const rowKeys = (count: number) => Array.from({ length: count }, (_, i) => `r${i}`);

const expandAbove = (keys: string[], n: number) =>
  keys.flatMap((key) => (key === 'r5' ? Array.from({ length: n }, (_, i) => `r5.${i}`) : [key]));

function mountedKeys(ctx: Ctx): string[] {
  return [...ctx.viewport().querySelectorAll<HTMLElement>('[data-row-key]')].map(
    (el) => el.dataset.rowKey!
  );
}

function screenTopOf(ctx: Ctx, key: string): number | null {
  const row = ctx.viewport().querySelector<HTMLElement>(`[data-row-key="${key}"]`)?.parentElement;
  if (!row) return null;
  return (parseFloat(row.style.top) || 0) - ctx.harness.scrollTop;
}

function keysOnScreen(keys: string[], scrollTop: number): string[] {
  const first = Math.floor(scrollTop / ROW);
  const last = Math.ceil((scrollTop + VIEWPORT) / ROW) - 1;
  return keys.slice(first, last + 1);
}

it('opens at the real bottom and never hides the viewport', async () => {
  const keys = rowKeys(60);
  const ctx = mount('engine-open' as SessionId, keys);
  try {
    await ctx.settle();
    expect(ctx.viewport().style.visibility).toBe('');
    expect(ctx.harness.scrollTop).toBe(60 * ROW - VIEWPORT);
    expect(ctx.state.current?.isSticky).toBe(true);
    expect(ctx.state.current?.revealed).toBe(true);
    expect(mountedKeys(ctx)).toEqual(
      expect.arrayContaining(keysOnScreen(keys, ctx.harness.scrollTop))
    );
  } finally {
    unmount(ctx);
  }
});

it('restores a reading position and keeps it covered when rows far beyond the overscan expand above it', async () => {
  const sessionId = 'engine-restore' as SessionId;
  const keys = rowKeys(60);
  const first = mount(sessionId, keys);
  await first.settle();
  await act(async () => {
    first.handle.current?.scrollRowToTop(30, { smooth: false, offset: 0 });
  });
  await first.settle();
  expect(screenTopOf(first, 'r30')).toBe(0);
  expect(first.state.current?.isSticky).toBe(false);
  unmount(first, false);

  // Reopen, and before any frame the placeholder above becomes fourteen rows.
  const ctx = mount(sessionId, keys, first.harness);
  try {
    const expanded = expandAbove(keys, 14);
    ctx.setKeys(expanded);
    await ctx.settle();
    expect(screenTopOf(ctx, 'r30')).toBe(0);
    const onScreen = keysOnScreen(expanded, ctx.harness.scrollTop);
    expect(mountedKeys(ctx)).toEqual(expect.arrayContaining(onScreen));
    expect(ctx.viewport().style.visibility).toBe('');
  } finally {
    unmount(ctx);
  }
});

it('returns to following with the handle and keeps the latest row on screen as it grows', async () => {
  const keys = rowKeys(40);
  const ctx = mount('engine-follow' as SessionId, keys);
  try {
    await ctx.settle();
    await act(async () => {
      ctx.handle.current?.scrollRowToTop(5, { smooth: false, offset: 0 });
    });
    await ctx.settle();
    expect(ctx.state.current?.isSticky).toBe(false);
    await act(async () => {
      ctx.handle.current?.scrollToBottom();
    });
    await ctx.settle();
    expect(ctx.state.current?.isSticky).toBe(true);
    ctx.setKeys([...keys, 'r40', 'r41']);
    await ctx.settle();
    expect(ctx.harness.scrollTop).toBe(42 * ROW - VIEWPORT);
    expect(mountedKeys(ctx)).toContain('r41');
  } finally {
    unmount(ctx);
  }
});
