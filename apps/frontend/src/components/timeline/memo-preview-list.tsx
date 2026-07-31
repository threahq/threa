import { useMemo } from "react"
import type { JSONContent, MemoEmbedSummary } from "@threa/types"
import { extractMemoRefs } from "@/lib/markdown/memo-refs"
import { MemoEmbedBlock } from "@/lib/markdown/memo-embed-block"
import { collectNodeMemoSummaries } from "@/lib/markdown/memo-node-summaries"

/**
 * Renders a preview card for each memo referenced in a message body, stacked
 * below the message like link previews. The inline `memo:` chips stay in the
 * rendered markdown; this surfaces the full card once per referenced memo.
 *
 * Card content comes from the message itself — never a fetch. Two sources, in
 * order of authority:
 *
 * 1. `memoEmbeds` from the server, resolved when the message was written or
 *    edited and re-resolved on bootstrap. It reflects the memo as of that write.
 * 2. The `summary` stamped onto the `memoEmbed` node by the composer, which is
 *    all there is for a sealed stream (the server never sees the body) or an
 *    optimistic send (no round trip yet).
 *
 * A memo with neither renders its reference's label alone, and stays that way.
 */
export function MemoPreviewList({
  contentMarkdown,
  contentJson,
  memoEmbeds,
}: {
  contentMarkdown: string
  /** Read only for the composer-stamped fallback; the refs themselves come from the markdown. */
  contentJson?: JSONContent
  memoEmbeds?: MemoEmbedSummary[]
}) {
  const refs = useMemo(() => extractMemoRefs(contentMarkdown), [contentMarkdown])
  const summaries = useMemo(() => {
    const byId = new Map<string, MemoEmbedSummary>()
    if (contentJson) {
      for (const summary of collectNodeMemoSummaries(contentJson)) byId.set(summary.memoId, summary)
    }
    // Server last: it wins where both exist.
    for (const summary of memoEmbeds ?? []) byId.set(summary.memoId, summary)
    return byId
  }, [contentJson, memoEmbeds])

  if (refs.length === 0) return null

  return (
    <div className="mt-2 flex flex-col gap-2">
      {refs.map((ref) => (
        <MemoEmbedBlock
          key={ref.memoId}
          memoId={ref.memoId}
          title={ref.title}
          summary={summaries.get(ref.memoId) ?? null}
        />
      ))}
    </div>
  )
}
