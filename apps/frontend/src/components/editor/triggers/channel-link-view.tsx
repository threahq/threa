import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { StreamChip } from "@/lib/markdown/stream-chip"
import type { ChannelNodeAttrs } from "./channel-extension"

/**
 * In-composer chip for a `#` stream link (TipTap NodeView). The identity
 * attributes (`data-type`/`data-id`/`data-slug`) live on the outer element the
 * factory builds, not here — see `createTriggerExtension`.
 */
export function ChannelLinkView({ node }: ReactNodeViewProps) {
  const { id, slug } = node.attrs as ChannelNodeAttrs
  return (
    <NodeViewWrapper as="span">
      <StreamChip id={id} slug={slug ?? ""} />
    </NodeViewWrapper>
  )
}
