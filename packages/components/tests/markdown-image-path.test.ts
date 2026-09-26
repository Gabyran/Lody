import { describe, expect, it } from 'vitest';
import {
  isRelativeMarkdownImageSource,
  resolveMarkdownImagePath,
} from '../src/lib/markdown-image-path';
import { createMarkdownImageSource } from '../src/lib/markdown-image-source';

describe('markdown image paths', () => {
  it('resolves references relative to the Markdown document', () => {
    expect(resolveMarkdownImagePath('docs/report.md', './images/diagram.png')).toBe(
      'docs/images/diagram.png'
    );
    expect(resolveMarkdownImagePath('docs/report.md', '../assets/diagram.png?raw=1#view')).toBe(
      'assets/diagram.png'
    );
  });

  it('rejects references that leave the workspace or use another URL scheme', () => {
    expect(resolveMarkdownImagePath('README.md', '../outside.png')).toBeNull();
    expect(resolveMarkdownImagePath('README.md', '/outside.png')).toBeNull();
    expect(resolveMarkdownImagePath('README.md', 'https://example.com/image.png')).toBeNull();
    expect(isRelativeMarkdownImageSource('assets/image.png')).toBe(true);
    expect(isRelativeMarkdownImageSource('data:image/png;base64,AAAA')).toBe(false);
  });

  it('turns authorized provider image snapshots into renderable sources', () => {
    expect(
      createMarkdownImageSource('assets/diagram.png', {
        kind: 'binary',
        url: 'lody-resource://test/diagram.png',
        mimeType: 'image/png',
      })
    ).toEqual({ src: 'lody-resource://test/diagram.png' });
    expect(
      createMarkdownImageSource('assets/diagram.txt', {
        kind: 'text',
        text: '<svg />',
      })
    ).toBeNull();
    expect(
      createMarkdownImageSource('assets/diagram.svg', {
        kind: 'text',
        text: '<svg />',
      })?.src.startsWith('blob:')
    ).toBe(true);
  });
});
