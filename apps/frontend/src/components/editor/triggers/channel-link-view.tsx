import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { InAppLinkChip } from "@/components/in-app-link/in-app-link-chip"
import { useChannelChipById } from "@/lib/markdown/channel-link-context"
import { streamChipParts } from "@/lib/streams"
import { StreamTypes } from "@threa/types"
import type { ChannelNodeAttrs } from "./channel-extension"

/**
 * In-composer chip for a `#` stream link (TipTap NodeView). Reads the target's
 * live name and type off the authoritative `attrs.id` (INV-64) through the same
 * provider the timeline renders from, so the composer and the posted message
 * show the identical chip and a rename lands in a draft that already holds the
 * link. `attrs.slug` is the display-only fallback for a target with no cached
 * row — including every render outside a `ChannelLinkProvider`.
 */
export function ChannelLinkView({ node }: ReactNodeViewProps) {
  const { id, slug } = node.attrs as ChannelNodeAttrs
  const target = useChannelChipById()(id)
  const parts = streamChipParts(target?.type ?? StreamTypes.CHANNEL, target?.label ?? slug)

  return (
    <NodeViewWrapper as="span" data-type="channelLink" data-id={id} data-slug={slug}>
      <InAppLinkChip icon={parts.icon} prefix={parts.prefix} label={parts.label} />
    </NodeViewWrapper>
  )
}
