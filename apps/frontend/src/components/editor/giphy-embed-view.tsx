import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { GiphyImage } from "@/components/giphy/giphy-image"
import type { GiphyEmbedAttrs } from "./giphy-embed-extension"

/**
 * In-composer GIF embed (TipTap NodeView). Renders the live GIF from its cached
 * Giphy CDN URL via the shared `GiphyImage`, so the composer preview matches the
 * sent message.
 */
export function GiphyEmbedView({ node }: NodeViewProps) {
  const attrs = node.attrs as GiphyEmbedAttrs
  return (
    <NodeViewWrapper as="span" data-type="giphy-embed" className="inline-block align-bottom">
      <GiphyImage url={attrs.giphyUrl} title={attrs.title} className="my-1" />
    </NodeViewWrapper>
  )
}
