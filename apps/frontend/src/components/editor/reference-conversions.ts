import type { Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import type { Transaction } from "@tiptap/pm/state"
import { classifyDraftLink } from "@/lib/in-app-links"
import { buildMessageLink } from "@/lib/stream-links"
import { referenceKeyOf, type ComposerReference, type SendTone } from "@/lib/reference-audience"

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

type Convertible = (ref: ComposerReference) => boolean

/** Refs into `streamIds`, except those in `sent`: an edit's earlier refs were already answered for. */
function convertibleIn(streamIds: string[], sent: ReadonlySet<string> = new Set()): Convertible {
  const streams = new Set(streamIds)
  return (ref) => streams.has(ref.streamId) && !sent.has(referenceKeyOf(ref))
}

function messageLinkRanges(doc: PMNode, convertible: Convertible): MessageRef[] {
  const ranges: LinkRange[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === "inAppLink") {
      const { streamId, messageId } = node.attrs as { streamId: string | null; messageId: string | null }
      if (streamId && messageId && convertible({ kind: "link", streamId, messageId })) {
        ranges.push({ from: pos, to: pos + node.nodeSize, streamId, messageId })
      }
      return false
    }
    if (!node.isText) return true
    const link = linkMarkMessage(node)
    if (!link || !convertible({ kind: "link", streamId: link.streamId, messageId: link.messageId })) return false
    // A link mark over differently formatted text spans several text nodes.
    const last = ranges[ranges.length - 1]
    if (last?.href === link.href && last.to === pos) last.to = pos + node.nodeSize
    else ranges.push({ from: pos, to: pos + node.nodeSize, ...link })
    return false
  })
  return ranges.map(({ from, to, streamId, messageId }) => ({ from, to, streamId, messageId }))
}

function messageBlockRanges(doc: PMNode, convertible: Convertible): MessageRef[] {
  const ranges: MessageRef[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== "sharedMessage" && node.type.name !== "quoteReply") return true
    const { streamId, messageId } = node.attrs as { streamId: string | null; messageId: string | null }
    if (streamId && messageId && convertible({ kind: "share", streamId, messageId })) {
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
export function linksToShares(editor: Editor, streamIds: string[], sent?: ReadonlySet<string>): void {
  const { schema, doc } = editor.state
  dispatchReplacements(editor, messageLinkRanges(doc, convertibleIn(streamIds, sent)), (tr, ref) => {
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
export function sharesToLinks(
  editor: Editor,
  workspaceId: string,
  streamIds: string[],
  sent?: ReadonlySet<string>
): void {
  const { schema, doc } = editor.state
  dispatchReplacements(
    editor,
    messageBlockRanges(doc, convertibleIn(streamIds, sent)),
    (tr, { from, to, streamId, messageId }) =>
      tr.replaceRangeWith(
        from,
        to,
        schema.nodes.paragraph.create(
          null,
          schema.nodes.inAppLink.create({
            url: buildMessageLink(workspaceId, streamId, messageId),
            streamId,
            messageId,
          })
        )
      )
  )
}

/** A question's alternative: a reveal's shares become links, an unreachable link becomes a share. */
export function convertForAlternative(
  editor: Editor,
  workspaceId: string,
  { tone, convertibleStreamIds }: { tone: SendTone; convertibleStreamIds: string[] },
  sent?: ReadonlySet<string>
): void {
  if (tone === "reveal") sharesToLinks(editor, workspaceId, convertibleStreamIds, sent)
  else linksToShares(editor, convertibleStreamIds, sent)
}
