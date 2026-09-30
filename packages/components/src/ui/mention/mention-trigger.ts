export type TriggerCandidate = {
  trigger: string;
  index: number;
};

export function findTriggerCandidates(
  value: string,
  triggers: string[],
  fromIndex: number,
): TriggerCandidate[] {
  const clampedFromIndex = Math.max(0, Math.min(fromIndex, value.length));
  const candidates: TriggerCandidate[] = [];

  for (const trigger of triggers) {
    if (!trigger) continue;
    const index = value.lastIndexOf(trigger, clampedFromIndex);
    if (index !== -1) candidates.push({ trigger, index });
  }

  candidates.sort((a, b) => b.index - a.index);
  return candidates;
}

const DOMAIN_QUERY_RE = /^[\w-]+(?:\.[\w-]+)+$/;

/**
 * Whether a trigger sits glued to non-whitespace text before it
 * (`gabi@example.com`, `price$100`) rather than standing alone at the start of
 * the input or after a space (`@README.md`, `hey @alpha`).
 *
 * The single owner of this shape: the `$` word guard treats a glued `$` as
 * part of code, and the email check only fires on a glued trigger.
 */
export function isTriggerGluedToWord(value: string, triggerIndex: number): boolean {
  const charBeforeTrigger = value.slice(0, triggerIndex).slice(-1);
  return charBeforeTrigger !== '' && !/\s/.test(charBeforeTrigger);
}

/**
 * Whether the trigger and the query after it read as a finished email address
 * — a glued trigger followed by a domain, `gabi@example.com`, `me@mail.co.uk`.
 *
 * Typing one is not a mention attempt: the menu gives up once the query takes
 * this shape, so a finished address is never matched against skills, files, or
 * sessions. A standalone trigger with a dotted query (`@README.md`) is a file
 * mention and keeps its menu. The partial query (`user@example`) is
 * deliberately left alone — it is still ambiguous, and mid-sentence mentions
 * after an English word (`fix this bug@alpha`) must keep working.
 */
export function looksLikeEmailAddress(
  value: string,
  triggerIndex: number,
  search: string
): boolean {
  return isTriggerGluedToWord(value, triggerIndex) && DOMAIN_QUERY_RE.test(search);
}

const NAMESPACE_SEARCH_RE = /^([a-z][a-z0-9-]*):(.*)$/;

/**
 * Split the text between the trigger and the caret into a drill-down namespace
 * and the term scoped to it — `issue:foo` becomes `{ namespace: 'issue', term:
 * 'foo' }`. Returns null for anything that is not a namespaced search, which is
 * how path drill-downs (`src/`) stay out of the grammar.
 *
 * The single owner of the `@<ns>:` syntax: the menu resolves its level from
 * this, and Backspace pops a bare prefix from it, so the two cannot disagree
 * about what counts as a namespace.
 */
export function parseMentionNamespaceSearch(
  search: string
): { namespace: string; term: string } | null {
  const match = NAMESPACE_SEARCH_RE.exec(search);
  if (!match?.[1]) return null;
  return { namespace: match[1], term: match[2] ?? '' };
}

/**
 * Whether the text between the trigger and the caret is a bare category
 * drill-down prefix — the `issue:` in `@issue:`. Backspace pops such a prefix
 * back to the bare trigger in one keystroke instead of deleting the colon.
 *
 * Path drill-downs (`src/`) are deliberately excluded: inside a path, Backspace
 * must keep deleting one character at a time.
 */
export function isMentionNavigationPrefix(search: string): boolean {
  return parseMentionNamespaceSearch(search)?.term === '';
}
