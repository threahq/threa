import { useMemo } from "react"
import type { MemoEmbedSummary } from "@threa/types"
import { extractMemoRefs } from "@/lib/markdown/memo-refs"
import { MemoEmbedBlock } from "@/lib/markdown/memo-embed-block"

/**
 * Renders a preview card for each memo referenced in a message body, stacked
 * below the message like link previews. The inline `memo:` chips stay in the
 * rendered markdown; this surfaces the full card once per referenced memo.
 *
 * Card content comes from `memoEmbeds` on the message — resolved server-side,
 * gated so that a summary only reaches a room that can open the memo, the same
 * way shared messages are hydrated. There is no client-side source and no
 * fetch: a memo the room cannot read, or one the server could not resolve at
 * all (a sealed body), renders its reference's label alone and stays that way.
 */
export function MemoPreviewList({
  contentMarkdown,
  memoEmbeds,
}: {
  contentMarkdown: string
  memoEmbeds?: MemoEmbedSummary[]
}) {
  const refs = useMemo(() => extractMemoRefs(contentMarkdown), [contentMarkdown])
  const summaries = useMemo(() => new Map((memoEmbeds ?? []).map((s) => [s.memoId, s])), [memoEmbeds])

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
