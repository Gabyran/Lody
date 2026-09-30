import { describe, expect, it } from 'vitest';
import { readPastedSessionLink, resolveSessionLinkWorkspace } from '../src/lib/session-deep-link';
import {
  buildAppSessionUrl,
  getAppSessionUrlOrigins,
  isPlainLinkPasteShortcut,
  parseAppSessionUrl,
} from '../src/lib/session-app-url';

describe('workspace-scoped resource links', () => {
  const target = { sessionId: 'session_1', workspaceId: 'workspace_1' };
  const directory = {
    status: 'ready' as const,
    activeWorkspaceId: 'workspace_2',
    workspaces: [
      { id: 'workspace_1', slug: 'renamed', name: 'One', role: 'owner' },
      { id: 'workspace_2', slug: 'other', name: 'Two', role: 'owner' },
    ],
  };
  it('waits for startup and resolves the explicit ID even when another workspace is active', () => {
    expect(resolveSessionLinkWorkspace(target, { status: 'loading' }, 'workspace_2')).toEqual({
      kind: 'wait',
    });
    expect(resolveSessionLinkWorkspace(target, directory, null)).toEqual({ kind: 'wait' });
    expect(resolveSessionLinkWorkspace(target, directory, 'workspace_2')).toEqual({
      kind: 'open',
      workspaceId: 'workspace_1',
      slug: 'renamed',
    });
  });
  it('never falls back to the current workspace when the link belongs elsewhere', () => {
    expect(
      resolveSessionLinkWorkspace({ ...target, workspaceId: 'missing' }, directory, 'workspace_2')
    ).toEqual({ kind: 'unavailable', workspaceId: 'missing' });
    expect(
      readPastedSessionLink('lody://session/session_1?workspace=workspace_1', 'workspace_2')
    ).toBeNull();
    expect(
      readPastedSessionLink('lody://session/session_1?workspace=workspace_1', 'workspace_1')
    ).toEqual(target);
  });
});

describe('parseAppSessionUrl', () => {
  const allowedOrigins = ['https://lody.ai', 'http://localhost:5173'];

  it('accepts a session URL on an allowed app origin', () => {
    expect(
      parseAppSessionUrl('https://lody.ai/acme/sessions/ses_abc123', { allowedOrigins })
    ).toEqual({
      url: 'https://lody.ai/acme/sessions/ses_abc123',
      workspaceSlug: 'acme',
      sessionId: 'ses_abc123',
    });
  });

  it('keeps search and hash on the normalized url', () => {
    expect(
      parseAppSessionUrl('http://localhost:5173/acme/sessions/ses_1?tab=session:ses_1#top', {
        allowedOrigins,
      })
    ).toEqual({
      url: 'http://localhost:5173/acme/sessions/ses_1?tab=session:ses_1#top',
      workspaceSlug: 'acme',
      sessionId: 'ses_1',
    });
  });

  it('rejects a foreign host even when the path looks like a session', () => {
    expect(
      parseAppSessionUrl('https://evil.example/acme/sessions/ses_abc123', { allowedOrigins })
    ).toBeNull();
  });

  it('rejects text that is not a lone URL', () => {
    expect(
      parseAppSessionUrl('see https://lody.ai/acme/sessions/ses_abc123 please', {
        allowedOrigins,
      })
    ).toBeNull();
  });

  it('rejects non-session app paths', () => {
    expect(parseAppSessionUrl('https://lody.ai/acme/settings', { allowedOrigins })).toBeNull();
  });
});

describe('isPlainLinkPasteShortcut', () => {
  it('detects Cmd/Ctrl+Shift+V', () => {
    expect(isPlainLinkPasteShortcut({ shiftKey: true, metaKey: true, ctrlKey: false })).toBe(true);
    expect(isPlainLinkPasteShortcut({ shiftKey: true, metaKey: false, ctrlKey: true })).toBe(true);
    expect(isPlainLinkPasteShortcut({ shiftKey: false, metaKey: true, ctrlKey: false })).toBe(
      false
    );
  });
});

describe('getAppSessionUrlOrigins / buildAppSessionUrl', () => {
  it('dedupes page and share origins', () => {
    expect(
      getAppSessionUrlOrigins({
        pageOrigin: 'http://localhost:5173/',
        shareOrigin: 'http://localhost:5173',
      })
    ).toEqual(['http://localhost:5173']);
  });

  it('builds a share URL for a workspace session', () => {
    expect(buildAppSessionUrl('acme', 'ses_1')).toMatch(/\/acme\/sessions\/ses_1$/);
  });
});
