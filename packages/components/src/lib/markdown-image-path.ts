const SCHEME_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:/u;

function decodeRelativePath(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('\\') || trimmed.startsWith('//')) {
    return null;
  }
  if (SCHEME_PATTERN.test(trimmed)) return null;

  const queryIndex = trimmed.search(/[?#]/u);
  const pathPart = queryIndex === -1 ? trimmed : trimmed.slice(0, queryIndex);
  if (!pathPart) return null;

  try {
    const decoded = decodeURIComponent(pathPart).replace(/\\/g, '/');
    if (!decoded || decoded.startsWith('/')) return null;
    return decoded;
  } catch {
    return null;
  }
}

/** Whether an image source is a workspace-relative Markdown reference. */
export function isRelativeMarkdownImageSource(source: string): boolean {
  return decodeRelativePath(source) !== null;
}

/**
 * Resolve a Markdown image reference against its document while keeping the
 * result inside the workspace-relative path namespace.
 */
export function resolveMarkdownImagePath(markdownPath: string, imageSource: string): string | null {
  const documentPath = markdownPath.trim().replace(/\\/g, '/');
  if (!documentPath || documentPath.startsWith('/') || SCHEME_PATTERN.test(documentPath)) {
    return null;
  }

  const documentSegments = documentPath.split('/');
  documentSegments.pop();
  const segments: string[] = [];
  for (const segment of documentSegments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }

  const relativePath = decodeRelativePath(imageSource);
  if (!relativePath) return null;
  for (const segment of relativePath.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.length > 0 ? segments.join('/') : null;
}
