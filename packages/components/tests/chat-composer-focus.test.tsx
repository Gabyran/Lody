// @vitest-environment jsdom

import { act, createElement, createRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionMentionItems: () => [],
}));

vi.mock('../src/components/mentions/mention-agent-role-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgentRoleMentionItems: () => [],
}));

import { ChatComposer } from '../src/components/chat/chat-composer';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ChatComposer focusOnContainerClick', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('focuses textarea when clicking container background with focusOnContainerClick=true', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();
    await act(async () => {
      root.render(
        createElement(ChatComposer, {
          promptRef,
          promptValue: '',
          onPromptChange: () => undefined,
          focusOnContainerClick: true,
        })
      );
    });

    const boxContainer = container.querySelector('.group.relative') as HTMLElement;
    expect(boxContainer).not.toBeNull();
    expect(document.activeElement).not.toBe(promptRef.current);

    await act(async () => {
      boxContainer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.activeElement).toBe(promptRef.current);
  });

  it('does not focus textarea when focusOnContainerClick is false', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();
    await act(async () => {
      root.render(
        createElement(ChatComposer, {
          promptRef,
          promptValue: '',
          onPromptChange: () => undefined,
          focusOnContainerClick: false,
        })
      );
    });

    const boxContainer = container.querySelector('.group.relative') as HTMLElement;
    await act(async () => {
      boxContainer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.activeElement).not.toBe(promptRef.current);
  });

  it('does not focus textarea when clicking a button, input, or portalled element', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();
    const customInputRef = createRef<HTMLInputElement>();

    await act(async () => {
      root.render(
        createElement(ChatComposer, {
          promptRef,
          promptValue: '',
          onPromptChange: () => undefined,
          focusOnContainerClick: true,
          footerSelector: createElement('input', {
            ref: customInputRef,
            'aria-label': 'custom-input',
          }),
        })
      );
    });

    const input = customInputRef.current;
    expect(input).not.toBeNull();

    await act(async () => {
      input?.focus();
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.activeElement).toBe(input);
    expect(document.activeElement).not.toBe(promptRef.current);
  });

  it('opens the command menu above the composer and caps it to the frame', async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.hasAttribute('data-mention-frame')) {
        return DOMRect.fromRect({ x: 200, y: 600, width: 600, height: 100 });
      }
      return originalRect.call(this);
    };

    function ComposerWithCommand() {
      const [value, setValue] = useState('');
      return createElement(ChatComposer, {
        promptValue: value,
        onPromptChange: setValue,
        availableCommands: [{ name: 'review', description: 'Review changes' }],
      });
    }

    try {
      await act(async () => root.render(createElement(ComposerWithCommand)));
      const input = container.querySelector('textarea');
      expect(input).not.toBeNull();
      await act(async () => {
        input!.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
          input,
          '/'
        );
        input!.setSelectionRange(1, 1);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const menu = document.querySelector<HTMLElement>('[data-slot="mention-content"]');
      expect(menu).not.toBeNull();
      expect(menu?.style.maxHeight).toBe('576px');
      expect(menu?.style.getPropertyValue('--mention-input-width')).toBe('600px');
      expect(menu?.style.getPropertyValue('--mention-rise')).toBe('-4px');
      expect(menu?.textContent).toContain('review');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });
});

describe('ChatComposer image attachment peek', () => {
  let root: Root;
  let container: HTMLDivElement;

  const drainFrames = () =>
    act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

  const peekImage = () => document.body.querySelector<HTMLImageElement>('img[alt="Image preview"]');

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ChatComposer, {
          promptValue: '',
          onPromptChange: () => undefined,
          imageItems: [
            {
              id: 'image-1',
              name: 'mockup.png',
              previewUrl: 'blob:mockup',
              status: 'uploaded',
              progress: 100,
            },
          ],
        })
      );
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('opens a non-modal card beside the thumbnail and closes it on Escape', async () => {
    const thumbnail = container.querySelector<HTMLButtonElement>('button[aria-label="mockup.png"]');
    expect(thumbnail).not.toBeNull();
    expect(peekImage()).toBeNull();

    await act(async () => {
      thumbnail!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await drainFrames();

    const image = peekImage();
    expect(image?.getAttribute('src')).toBe('blob:mockup');
    expect(thumbnail!.getAttribute('aria-expanded')).toBe('true');
    // A peek, not a lightbox: nothing modal covers the draft.
    expect(document.body.querySelector('[aria-modal="true"]')).toBeNull();
    expect(image!.parentElement?.textContent).toContain('mockup.png');

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    await drainFrames();

    expect(thumbnail!.getAttribute('aria-expanded')).toBe('false');
  });
});
