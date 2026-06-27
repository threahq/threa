import type { JSONContent } from "@threa/types"
import { collectLinkUrls } from "@threa/prosemirror"

/** Mirrors the backend `parseInAppLink` path shapes (`url-utils.ts`). */
const STREAM_PATH = /^\/w\/[^/]+\/s\/[^/]+$/
const MEMO_PATH = /^\/w\/[^/]+\/memos\/[^/]+$/

/**
 * Matches the server's MAX_PREVIEWS_PER_MESSAGE so the composer never previews
 * more links than a posted message would.
 */
const MAX_IN_APP_PREVIEWS = 5

function currentOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin
}

function isInAppUrl(href: string, origin: string): boolean {
  try {
    const url = new URL(href)
    if (url.origin !== origin) return false
    // Message links are stream links carrying `?m=…`, so they match the stream
    // path too; the query survives in the returned href for the resolver.
    return STREAM_PATH.test(url.pathname) || MEMO_PATH.test(url.pathname)
  } catch {
    return false
  }
}

/**
 * In-app link URLs (stream / message / memo) referenced by draft content, so the
 * composer can preview the same links a posted message would. Reuses
 * {@link collectLinkUrls} (link marks + bare-text URLs), then filters to this
 * app's origin and the in-app path shapes. Deduped, document order, capped.
 *
 * `origin` defaults to the current window origin and is injectable for tests.
 */
export function extractInAppLinkUrls(
  content: JSONContent | null | undefined,
  origin: string | null = currentOrigin()
): string[] {
  if (!content || !origin) return []

  const seen = new Set<string>()
  const result: string[] = []
  for (const href of collectLinkUrls(content)) {
    if (seen.has(href) || !isInAppUrl(href, origin)) continue
    seen.add(href)
    result.push(href)
    if (result.length >= MAX_IN_APP_PREVIEWS) break
  }
  return result
}
