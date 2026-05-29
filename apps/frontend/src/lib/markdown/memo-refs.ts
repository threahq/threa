/**
 * Memo reference scanned out of a message's `contentMarkdown`. The title is the
 * pre-hydration label parsed from the link text; `memoId` keys the live lookup.
 */
export interface MemoRef {
  memoId: string
  title: string
}

// Mirrors the memo branch of `INLINE_MARKDOWN_PATTERN`: `[title](memo:id)` with
// the title allowing escaped brackets/backslashes.
const MEMO_REF_PATTERN = /\[((?:\\.|[^\\\]])+)\]\(memo:([\w-]+)\)/g

/**
 * Extract every memo reference in `markdown`, de-duplicated by `memoId` (first
 * title wins). Used by `MemoPreviewList` to render one hydrated preview card per
 * referenced memo below the message — the inline chips remain in the body.
 */
export function extractMemoRefs(markdown: string): MemoRef[] {
  const refs: MemoRef[] = []
  const seen = new Set<string>()
  for (const match of markdown.matchAll(MEMO_REF_PATTERN)) {
    const memoId = match[2]
    if (seen.has(memoId)) continue
    seen.add(memoId)
    const title = match[1].replace(/\\([\]\\])/g, "$1")
    refs.push({ memoId, title })
  }
  return refs
}
