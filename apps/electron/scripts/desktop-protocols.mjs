/** Keep shared resource URLs separate from channel-specific callback dispatch. */
export function withDesktopResourceProtocols(protocols) {
  const entries = protocols == null ? [] : Array.isArray(protocols) ? protocols : [protocols]
  const schemes = new Set(entries.flatMap((entry) => entry.schemes ?? []))
  if (![...schemes].some((scheme) => ['lody', 'lody-oss', 'ai.lody.nightly'].includes(scheme)))
    return entries
  const callback = schemes.has('ai.lody.nightly')
    ? 'ai.lody.nightly'
    : schemes.has('lody-oss')
      ? 'lody-oss'
      : 'ai.lody.stable'
  const missing = ['lody', callback].filter((scheme) => !schemes.has(scheme))
  return missing.length ? [...entries, { name: 'Lody links', schemes: missing }] : entries
}
