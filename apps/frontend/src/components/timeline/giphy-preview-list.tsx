import { useMemo } from "react"
import { extractGiphyRefs } from "@/lib/markdown/giphy-refs"
import { GiphyEmbedBlock } from "@/lib/markdown/giphy-embed-block"

/**
 * Renders a GIF preview card for each `giphy:` reference in a message body,
 * stacked below the message like attachment and memo previews. The inline
 * `giphy:` chips stay in the rendered markdown; this surfaces the actual GIFs.
 * Returns nothing when the body has no GIF references.
 */
export function GiphyPreviewList({ contentMarkdown }: { contentMarkdown: string }) {
  const refs = useMemo(() => extractGiphyRefs(contentMarkdown), [contentMarkdown])
  if (refs.length === 0) return null

  return (
    <div className="mt-2 flex flex-col items-start gap-2">
      {refs.map((ref) => (
        <GiphyEmbedBlock
          key={ref.giphyUrl}
          giphyUrl={ref.giphyUrl}
          title={ref.title}
          width={ref.width}
          height={ref.height}
        />
      ))}
    </div>
  )
}
