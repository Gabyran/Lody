import { buildSessionLink, parseSessionLink, type SessionLink } from '@lody/shared/session-link';
import { atom } from 'jotai';
import type { WorkspacesState } from '@lody/platform';

export const pendingSessionLinkAtom = atom<SessionLink | null>(null);

export const SESSION_DEEP_LINK_EVENT = 'lody:open-session-link';

export function openSessionDeepLink(target: SessionLink): void {
  window.dispatchEvent(
    new CustomEvent(SESSION_DEEP_LINK_EVENT, { detail: buildSessionLink(target) })
  );
}

/** Paste only within the known source workspace; never reinterpret a foreign ID. */
export function readPastedSessionLink(raw: string, workspaceId: string | null): SessionLink | null {
  const link = parseSessionLink(raw.trim());
  return link && workspaceId && (!link.workspaceId || link.workspaceId === workspaceId)
    ? link
    : null;
}

export function resolveSessionLinkWorkspace(
  link: SessionLink,
  workspaces: WorkspacesState,
  currentWorkspaceId: string | null
):
  | { kind: 'wait' }
  | { kind: 'unavailable'; workspaceId: string }
  | { kind: 'open'; workspaceId: string; slug: string } {
  if (workspaces.status !== 'ready' || !currentWorkspaceId) return { kind: 'wait' };
  const workspaceId = link.workspaceId ?? currentWorkspaceId;
  const workspace = workspaces.workspaces.find((item) => item.id === workspaceId);
  return workspace?.slug
    ? { kind: 'open', workspaceId, slug: workspace.slug }
    : { kind: 'unavailable', workspaceId };
}
