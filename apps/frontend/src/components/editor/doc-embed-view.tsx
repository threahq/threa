import { useEffect } from "react"
import { useParams } from "react-router-dom"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { DocChip } from "@/components/docs/doc-chip"
import { useLiveDocTitle } from "@/components/docs/use-live-doc-title"
import type { DocEmbedAttrs } from "./doc-embed-extension"
import { stampNodeAttrs } from "./stamp-node-attrs"

/**
 * In-editor doc chip. A node inserted without a title (a pasted doc link) gets the doc's real name
 * written back, so serialization carries it instead of the generic "Doc".
 */
export function DocEmbedView({ node, editor, getPos }: NodeViewProps) {
  const attrs = node.attrs as DocEmbedAttrs
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { title, label } = useLiveDocTitle(workspaceId, attrs.docId, attrs.title)

  useEffect(() => {
    if (title && !attrs.title) stampNodeAttrs({ editor, getPos }, "docEmbed", { title })
  }, [title, attrs.title, editor, getPos])

  return (
    <NodeViewWrapper as="span" data-type="doc-embed">
      <DocChip label={label} />
    </NodeViewWrapper>
  )
}
