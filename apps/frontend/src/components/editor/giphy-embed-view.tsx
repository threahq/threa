import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { GifChip } from "@/components/giphy/gif-chip"
import type { GiphyEmbedAttrs } from "./giphy-embed-extension"

/**
 * In-composer GIF reference (TipTap NodeView). Renders the same inline chip the
 * timeline shows; the GIF preview itself surfaces below the message, mirroring
 * memo embeds and attachments rather than embedding the image mid-line.
 */
export function GiphyEmbedView({ node }: NodeViewProps) {
  const attrs = node.attrs as GiphyEmbedAttrs
  return (
    <NodeViewWrapper as="span" data-type="giphy-embed" className="inline">
      <GifChip label={attrs.title || "GIF"} />
    </NodeViewWrapper>
  )
}
