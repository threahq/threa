import { parseGiphyHref } from "@threa/prosemirror"

/**
 * Giphy reference scanned out of a message's `contentMarkdown`. The title is the
 * pre-render label parsed from the link text; `giphyUrl` is the validated CDN
 * URL the preview card renders.
 */
export interface GiphyRef {
  giphyUrl: string
  title: string
  /** Intrinsic pixel size of the rendition, when the wire carried it, so the
   *  preview card reserves an aspect-ratio box before the GIF loads. */
  width?: number
  height?: number
}

// Mirrors the giphy branch of the serializer: `[title](giphy:<encoded-url>)`.
// The encoded URL never contains whitespace or a closing paren.
const GIPHY_REF_PATTERN = /\[((?:\\.|[^\\\]])+)\]\(giphy:([^)\s]+)\)/g

/**
 * Extract every Giphy reference in `markdown`, de-duplicated by URL (first title
 * wins). Used by `GiphyPreviewList` to render one GIF card per reference below
 * the message — the inline chips stay in the body. Non-Giphy hosts are rejected
 * by `parseGiphyHref` and skipped.
 */
export function extractGiphyRefs(markdown: string): GiphyRef[] {
  const refs: GiphyRef[] = []
  const seen = new Set<string>()
  for (const match of markdown.matchAll(GIPHY_REF_PATTERN)) {
    const parsed = parseGiphyHref(`giphy:${match[2]}`)
    if (!parsed || seen.has(parsed.giphyUrl)) continue
    seen.add(parsed.giphyUrl)
    const title = match[1].replace(/\\([\]\\])/g, "$1")
    refs.push({ giphyUrl: parsed.giphyUrl, title, width: parsed.width, height: parsed.height })
  }
  return refs
}
