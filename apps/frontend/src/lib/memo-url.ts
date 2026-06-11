/**
 * Build the canonical in-app deep link to a memo in the memory explorer.
 * Inverse of `parseMemoUrl` below — keep the two in sync.
 */
export function memoDeepLink(workspaceId: string, memoId: string): string {
  return `/w/${encodeURIComponent(workspaceId)}/memory?memo=${encodeURIComponent(memoId)}`
}

/**
 * Extract a memo id from an in-app memory-explorer link
 * (`…/w/{workspaceId}/memory?memo=memo_xxx`). Returns `null` for any other
 * URL, off-origin link, or unparseable text. Used by the composer to turn a
 * pasted memo link into an embed card instead of a plain hyperlink.
 */
export function parseMemoUrl(text: string): string | null {
  let url: URL
  try {
    url = new URL(text, window.location.origin)
  } catch {
    return null
  }

  if (url.origin !== window.location.origin) return null
  // Match only the workspace memory route, not any path ending in "/memory".
  if (!/^\/w\/[^/]+\/memory\/?$/.test(url.pathname)) return null

  const memoId = url.searchParams.get("memo")
  if (!memoId || !memoId.startsWith("memo_")) return null

  return memoId
}
