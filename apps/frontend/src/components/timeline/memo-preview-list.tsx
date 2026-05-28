import { useMemo } from "react"
import { extractMemoRefs } from "@/lib/markdown/memo-refs"
import { MemoEmbedBlock } from "@/lib/markdown/memo-embed-block"

/**
 * Renders a hydrated preview card for each memo referenced in a message body,
 * stacked below the message like link previews. The inline `memo:` chips stay
 * in the rendered markdown; this surfaces the full card (title, type, tags,
 * date) once per referenced memo. Returns nothing when the body has no memo
 * references.
 */
export function MemoPreviewList({ contentMarkdown }: { contentMarkdown: string }) {
  const refs = useMemo(() => extractMemoRefs(contentMarkdown), [contentMarkdown])
  if (refs.length === 0) return null

  return (
    <div className="mt-2 flex flex-col gap-2">
      {refs.map((ref) => (
        <MemoEmbedBlock key={ref.memoId} memoId={ref.memoId} title={ref.title} />
      ))}
    </div>
  )
}
