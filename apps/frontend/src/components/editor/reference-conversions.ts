import type { Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import type { Transaction } from "@tiptap/pm/state"
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

type LinkRange = MessageRef & { href?: string }

function messageLinkRanges(doc: PMNode, streamIds: Set<string>): MessageRef[] {
  const ranges: LinkRange[] = []
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
  return ranges.map(({ from, to, streamId, messageId }) => ({ from, to, streamId, messageId }))
}

function messageBlockRanges(doc: PMNode, streamIds: Set<string>): MessageRef[] {
  const ranges: MessageRef[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== "sharedMessage" && node.type.name !== "quoteReply") return true
    const { streamId, messageId } = node.attrs as { streamId: string | null; messageId: string | null }
    if (streamId && messageId && streamIds.has(streamId)) {
      ranges.push({ from: pos, to: pos + node.nodeSize, streamId, messageId })
    }
    return false
  })
  return ranges
}

function dispatchReplacements(
  editor: Editor,
  refs: MessageRef[],
  apply: (tr: Transaction, ref: MessageRef) => void
): void {
  if (refs.length === 0) return
  const { tr } = editor.state
  for (const ref of [...refs].sort((a, b) => b.from - a.from)) apply(tr, ref)
  editor.view.dispatch(tr)
}

/** Every message link (chip or link-marked text) into one of `streamIds` becomes a share block. */
export function linksToShares(editor: Editor, streamIds: string[]): void {
  const { schema, doc } = editor.state
  dispatchReplacements(editor, messageLinkRanges(doc, new Set(streamIds)), (tr, ref) => {
    const share = schema.nodes.sharedMessage.create({ streamId: ref.streamId, messageId: ref.messageId })
    const $from = tr.doc.resolve(ref.from)
    if ($from.depth <= 1) {
      tr.replaceRangeWith(ref.from, ref.to, share)
      return
    }
    // Shares round-trip through markdown only as top-level blocks, so a link
    // nested in a list or quote lands after the outermost block instead. A
    // textblock the link filled goes with it, as does every ancestor it leaves empty.
    const emptied = $from.parent.content.size === ref.to - ref.from
    let depth = $from.depth
    while (emptied && depth > 1 && $from.node(depth - 1).childCount === 1) depth--
    if (depth === 1) {
      tr.replaceWith($from.before(1), $from.after(1), share)
      return
    }
    tr.insert($from.after(1), share)
    if (emptied) tr.delete($from.before(depth), $from.after(depth))
    else tr.delete(ref.from, ref.to)
  })
}

/** Every share or quote block from one of `streamIds` becomes a paragraph with a link chip to that message. */
export function sharesToLinks(editor: Editor, workspaceId: string, streamIds: string[]): void {
  const { schema, doc } = editor.state
  dispatchReplacements(editor, messageBlockRanges(doc, new Set(streamIds)), (tr, { from, to, streamId, messageId }) =>
    tr.replaceRangeWith(
      from,
      to,
      schema.nodes.paragraph.create(
        null,
        schema.nodes.inAppLink.create({ url: buildMessageLink(workspaceId, streamId, messageId), streamId, messageId })
      )
    )
  )
}
