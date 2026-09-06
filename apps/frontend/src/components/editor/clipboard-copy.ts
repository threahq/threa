/**
 * Clipboard `text/plain` serializer for editor copy/cut.
 *
 * ProseMirror's default text serialization is bare `textContent` — code
 * fences, quote markers, list bullets, and chip references (mentions, quote
 * replies, shared messages) all vanish, so pasting back can never restore
 * them. Markdown is the editor's canonical text form and the paste path
 * parses it, closing the copy → paste roundtrip.
 *
 * Styling is written only when the selection actually contains the boundary
 * that produces it: text taken from inside a code block, quote, list item or
 * heading copies bare, and a mark run the selection cuts into copies
 * unmarked. Selecting a whole block (or across its edges) still copies the
 * block form. An in-app paste is unaffected either way — it restores the
 * exact document from the `data-pm-slice` HTML flavour — so this only
 * governs plain-text targets: another app, a code block (ProseMirror pastes
 * text into `code` blocks), and paste-without-formatting.
 */
import { Fragment, type Mark, type Node as PMNode, type Slice } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import { serializeToMarkdown } from "@threahq/prosemirror"
import type { JSONContent } from "@threahq/types"

export function serializeClipboardSlice(slice: Slice, view?: EditorView): string {
  if (slice.content.size === 0) return ""

  // A NodeSelection of an inline atom (a chip) yields a slice whose top level
  // is inline content; the serializer expects blocks, so wrap it.
  if (slice.content.firstChild?.isInline) {
    return serializeBlocks([{ type: "paragraph", content: slice.content.toJSON() as JSONContent[] }])
  }

  const unwrapped = dropUnselectedBlocks(slice)
  if (typeof unwrapped === "string") return unwrapped

  return serializeBlocks(dropMarkRunsCutBySelection(unwrapped, view).toJSON() as JSONContent[] | null)
}

function serializeBlocks(content: JSONContent[] | null): string {
  if (!content || content.length === 0) return ""
  return serializeToMarkdown({ type: "doc", content })
}

/**
 * Peel the wrappers the selection never entered. A slice open at both ends
 * sits strictly inside its outermost block, so that block's markdown (fence,
 * `>`, bullet, `#`) belongs to text the user did not copy. Returns a string
 * when the innermost wrapper is a code block: its text carries no inline
 * markup, so it is the copy verbatim, escaping included.
 */
function dropUnselectedBlocks(slice: Slice): Fragment | string {
  let content = slice.content
  let open = Math.min(slice.openStart, slice.openEnd)

  while (open > 0 && content.childCount === 1 && content.firstChild) {
    const only = content.firstChild
    if (only.isTextblock) {
      if (only.type.spec.code) return only.textContent
      return Fragment.from(only.type.schema.nodes.paragraph.create(null, only.content))
    }
    content = only.content
    open -= 1
  }

  return content
}

/**
 * Drop marks whose run continues past the selection edge — the `**` the user
 * left behind is not theirs to copy. A run fully inside the selection keeps
 * its marks; only the leading and trailing runs are trimmed, and only for the
 * marks that actually straddle the edge.
 */
function dropMarkRunsCutBySelection(content: Fragment, view?: EditorView): Fragment {
  const selection = view?.state.selection
  if (!(selection instanceof TextSelection)) return content

  const before = selection.$from.nodeBefore
  const after = selection.$to.nodeAfter
  const cutAtStart = before?.isText ? before.marks : []
  const cutAtEnd = after?.isText ? after.marks : []
  if (cutAtStart.length === 0 && cutAtEnd.length === 0) return content

  return dropEdgeMarks(content, cutAtStart, cutAtEnd, true, true)
}

function dropEdgeMarks(
  fragment: Fragment,
  cutAtStart: readonly Mark[],
  cutAtEnd: readonly Mark[],
  atStart: boolean,
  atEnd: boolean
): Fragment {
  const children: PMNode[] = []
  fragment.forEach((child, _offset, index) => {
    const isFirst = atStart && index === 0
    const isLast = atEnd && index === fragment.childCount - 1

    if (child.isTextblock) {
      children.push(child.copy(dropInlineEdgeMarks(child.content, isFirst ? cutAtStart : [], isLast ? cutAtEnd : [])))
      return
    }
    if (child.isLeaf) {
      children.push(child)
      return
    }
    children.push(child.copy(dropEdgeMarks(child.content, cutAtStart, cutAtEnd, isFirst, isLast)))
  })
  return Fragment.fromArray(children)
}

function dropInlineEdgeMarks(content: Fragment, cutAtStart: readonly Mark[], cutAtEnd: readonly Mark[]): Fragment {
  const nodes: PMNode[] = []
  content.forEach((node) => nodes.push(node))

  for (const mark of cutAtStart) {
    for (let index = 0; index < nodes.length && mark.isInSet(nodes[index].marks); index++) {
      nodes[index] = nodes[index].mark(mark.type.removeFromSet(nodes[index].marks))
    }
  }
  for (const mark of cutAtEnd) {
    for (let index = nodes.length - 1; index >= 0 && mark.isInSet(nodes[index].marks); index--) {
      nodes[index] = nodes[index].mark(mark.type.removeFromSet(nodes[index].marks))
    }
  }

  return Fragment.fromArray(nodes)
}
