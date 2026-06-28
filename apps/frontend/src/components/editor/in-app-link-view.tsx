import { useEffect } from "react"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { useParams } from "react-router-dom"
import { InAppLinkChip } from "@/components/in-app-link/in-app-link-chip"
import { useInAppLinkChip } from "@/hooks/use-in-app-link-chip"
import type { InAppLinkAttrs } from "./in-app-link-extension"

/**
 * In-composer chip for an in-app stream/message link (TipTap NodeView).
 * Resolves the live name (local cache → access-tiered backend) via the shared
 * `useInAppLinkChip` and renders the shared `InAppLinkChip`. When the node was
 * inserted without a cached name (pasted link), the resolved name is written
 * back so serialization carries a real label instead of the generic fallback.
 */
export function InAppLinkView({ node, updateAttributes }: NodeViewProps) {
  const attrs = node.attrs as InAppLinkAttrs
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const state = useInAppLinkChip({
    workspaceId: workspaceId ?? "",
    streamId: attrs.streamId,
    isMessage: Boolean(attrs.messageId),
    url: attrs.url,
  })

  const resolvedName = state.status === "resolved" ? state.label : null

  // Stamp the resolved name onto the node only when it was inserted without one
  // (pasted link). A user/compose-cached name is left as-is so the write-back
  // doesn't churn the undo history on every render.
  useEffect(() => {
    if (resolvedName && !attrs.name) {
      updateAttributes({ name: resolvedName })
    }
  }, [resolvedName, attrs.name, updateAttributes])

  const icon = state.status === "pending" ? undefined : state.icon
  const label = state.status === "pending" ? attrs.name || "Link" : state.label
  const prefix = state.status === "resolved" ? state.prefix : undefined
  const avatar = state.status === "resolved" ? state.avatar : undefined

  return (
    <NodeViewWrapper as="span" data-type="in-app-link">
      <InAppLinkChip icon={icon} prefix={prefix} label={label} avatar={avatar} />
    </NodeViewWrapper>
  )
}
