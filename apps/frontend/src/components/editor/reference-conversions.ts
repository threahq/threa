import type { Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { classifyDraftLink } from "@/lib/in-app-links"
import { buildMessageLink } from "@/lib/stream-links"

interface MessageRef {
  from: number
  to: number
  streamId: string
  messageId: string
}

function linkMarkMessage(node: PMNode): { href: string; streamId: string; messageId: string } | null {
  const href = node.marks.find((mark) => mark.type.name === "link")?.attrs.href
  if (typeof href !== "string") return null
  const link = classifyDraftLink(href)
  return link?.kind === "message" ? { href, streamId: link.streamId, messageId: link.messageId } : null
}

function messageLinkRanges(doc: PMNode, streamIds: Set<string>): MessageRef[] {
  const ranges: (MessageRef & { href?: string })[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === "inAppLink") {
      const { streamId, messageId } = node.attrs as { streamId: string | null; messageId: string | null }
      if (streamId && messageId && streamIds.has(streamId)) {
        ranges.push({ from: pos, to: pos + node.nodeSize, streamId, messageId })
      }
      return false
    }
    if (!node.isText) return true
    const link = linkMarkMessage(node)
    if (!link || !streamIds.has(link.streamId)) return false
    // A link mark over differently formatted text spans several text nodes.
    const last = ranges[ranges.length - 1]
    if (last?.href === link.href && last.to === pos) last.to = pos + node.nodeSize
    else ranges.push({ from: pos, to: pos + node.nodeSize, ...link })
    return false
  })
  return ranges
}

function dispatchReplacements(editor: Editor, refs: MessageRef[], build: (ref: MessageRef) => PMNode): void {
  if (refs.length === 0) return
  const { tr } = editor.state
  for (const ref of [...refs].sort((a, b) => b.from - a.from)) {
    tr.replaceRangeWith(ref.from, ref.to, build(ref))
  }
  editor.view.dispatch(tr)
}

/** Every message link (chip or link-marked text) into one of `streamIds` becomes a share block. */
export function linksToShares(editor: Editor, streamIds: string[]): void {
  const { schema } = editor.state
  dispatchReplacements(editor, messageLinkRanges(editor.state.doc, new Set(streamIds)), ({ streamId, messageId }) =>
    schema.nodes.sharedMessage.create({ streamId, messageId })
  )
}

/** Every share or quote block from one of `streamIds` becomes a paragraph with a link chip to that message. */
export function sharesToLinks(editor: Editor, workspaceId: string, streamIds: string[]): void {
  const wanted = new Set(streamIds)
  const { schema, doc } = editor.state
  const refs: MessageRef[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== "sharedMessage" && node.type.name !== "quoteReply") return true
    const { streamId, messageId } = node.attrs as { streamId: string | null; messageId: string | null }
    if (streamId && messageId && wanted.has(streamId)) {
      refs.push({ from: pos, to: pos + node.nodeSize, streamId, messageId })
    }
    return false
  })
  dispatchReplacements(editor, refs, ({ streamId, messageId }) =>
    schema.nodes.paragraph.create(
      null,
      schema.nodes.inAppLink.create({ url: buildMessageLink(workspaceId, streamId, messageId), streamId, messageId })
    )
  )
}
