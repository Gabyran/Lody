import { fromMarkdown } from 'mdast-util-from-markdown';
import { buildSessionLink, parseSessionLink } from './session-link';

type MarkdownNode = {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
};

/** Preserve original Markdown bytes outside resource URIs, including nested code examples. */
export function normalizeSessionLinksForExport(markdown: string, workspaceId?: string): string {
  if (!markdown.includes('://')) return markdown;
  const opaque: { start: number; end: number }[] = [];
  const visit = (node: MarkdownNode): void => {
    if (['code', 'inlineCode', 'html', 'image'].includes(node.type)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) opaque.push({ start, end });
      return;
    }
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(markdown));
  let rangeIndex = 0;
  return markdown.replace(
    /(?:session|lody|lody-oss|ai\.lody\.(?:nightly|stable)):\/\/[^\s<>()[\]`"']+/gu,
    (raw, offset: number) => {
      while (opaque[rangeIndex] && opaque[rangeIndex]!.end <= offset) rangeIndex += 1;
      const protectedRange = opaque[rangeIndex];
      if (protectedRange && protectedRange.start < offset + raw.length) return raw;
      // A URI embedded in another URL (e.g. ?next=session://...) is not a resource link.
      if (offset > 0 && !/[\s(<]/u.test(markdown[offset - 1]!)) return raw;
      const link = parseSessionLink(raw);
      return link
        ? buildSessionLink({ ...link, workspaceId: link.workspaceId ?? workspaceId })
        : raw;
    }
  );
}
