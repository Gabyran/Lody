import { getImageMimeTypeForPath, isSvgPath } from './image-file-preview';
import type { FileWorkspaceSnapshot } from './file-workspace-provider';

export type MarkdownImageSource = {
  readonly src: string;
  readonly revoke?: () => void;
};

/**
 * Turn an authorized workspace snapshot into a browser image source.
 *
 * Binary snapshots may already carry a provider-owned resource URL. Other
 * snapshots are kept in a short-lived object URL so image bytes never become
 * part of the Markdown string or a data URL.
 */
export function createMarkdownImageSource(
  path: string,
  snapshot: FileWorkspaceSnapshot
): MarkdownImageSource | null {
  if (snapshot.kind !== 'binary' && snapshot.kind !== 'text') return null;
  if (snapshot.kind === 'text' && !isSvgPath(path)) return null;

  const declaredMimeType =
    snapshot.kind === 'binary'
      ? snapshot.mimeType?.split(';', 1)[0]?.trim().toLowerCase()
      : undefined;
  const mimeType = declaredMimeType?.startsWith('image/')
    ? declaredMimeType
    : getImageMimeTypeForPath(path);
  if (!mimeType?.startsWith('image/')) return null;

  if (snapshot.kind === 'binary' && snapshot.url) {
    return { src: snapshot.url };
  }

  const bytes =
    snapshot.kind === 'binary'
      ? snapshot.bytes && snapshot.bytes.byteLength > 0
        ? Uint8Array.from(snapshot.bytes)
        : undefined
      : snapshot.text.trim()
        ? new TextEncoder().encode(snapshot.text)
        : undefined;
  if (!bytes || typeof URL.createObjectURL !== 'function') return null;

  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  return {
    src: blobUrl,
    revoke: () => URL.revokeObjectURL(blobUrl),
  };
}
