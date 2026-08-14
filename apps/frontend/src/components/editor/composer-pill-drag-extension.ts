import { Extension } from "@tiptap/core"
import { Fragment, Slice, type Node as ProseMirrorNode, type ResolvedPos } from "@tiptap/pm/model"
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state"
import { dropPoint } from "@tiptap/pm/transform"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import type { AttachmentReferenceAttrs } from "./attachment-reference-extension"

export const COMPOSER_PILL_NODE_NAMES = [
  "mention",
  "channelLink",
  "slashCommand",
  "attachmentReference",
  "memoEmbed",
  "inAppLink",
  "giphyEmbed",
] as const

const COMPOSER_PILL_NODE_NAME_SET = new Set<string>(COMPOSER_PILL_NODE_NAMES)

export const MOUSE_DRAG_THRESHOLD_PX = 6
export const COMPOSER_PILL_TOUCH_DRAG_MODE = "hold-or-selected"

/**
 * What is being dragged. A `doc` source is a pill already in the document and
 * moves; a `tray` source is an attachment chip and always inserts a new node,
 * so it has no position to leave behind.
 */
export type ComposerPillDragSource =
  | { kind: "doc"; pos: number }
  | { kind: "tray"; attachmentId: string; attrs: AttachmentReferenceAttrs }

export interface ComposerPillDragState {
  source: ComposerPillDragSource
  dropPos: number | null
}

/** The node a drag carries: the live one for a doc source, a fresh one for a tray source. */
export function composerPillDragNode(state: EditorState, source: ComposerPillDragSource): ProseMirrorNode | null {
  if (source.kind === "doc") {
    const node = state.doc.nodeAt(source.pos)
    return isComposerPillNode(node) ? node : null
  }
  return state.schema.nodes.attachmentReference?.create(source.attrs) ?? null
}

export const ComposerPillDragPluginKey = new PluginKey<ComposerPillDragState | null>("composerPillDrag")

export function isComposerPillNode(node: ProseMirrorNode | null | undefined): node is ProseMirrorNode {
  return Boolean(node?.isInline && node.isAtom && COMPOSER_PILL_NODE_NAME_SET.has(node.type.name))
}

function pillSlice(node: ProseMirrorNode): Slice {
  return new Slice(Fragment.from(node), 0, 0)
}

/**
 * Keep pill drops between lexical tokens. Text-node boundaries alone are not
 * enough because marks can split one word into several nodes; only whitespace,
 * non-text inline nodes, and the parent edges form real insertion slots.
 */
const INLINE_TOKEN_BOUNDARY_CACHE = new WeakMap<ProseMirrorNode, readonly number[]>()

function inlineTokenBoundaryOffsets(parent: ProseMirrorNode): readonly number[] {
  const cached = INLINE_TOKEN_BOUNDARY_CACHE.get(parent)
  if (cached) return cached

  const candidates = new Set<number>([0, parent.content.size])
  parent.forEach((child, offset) => {
    if (!child.isText) {
      if (child.isInline) {
        candidates.add(offset)
        candidates.add(offset + child.nodeSize)
      }
      return
    }

    const text = child.text ?? ""
    for (let index = 0; index < text.length; index++) {
      if (!/\s/u.test(text[index] ?? "")) continue
      candidates.add(offset + index)
      candidates.add(offset + index + 1)
    }
  })

  const result = [...candidates].sort((left, right) => left - right)
  INLINE_TOKEN_BOUNDARY_CACHE.set(parent, result)
  return result
}

function nearestInlineTokenBoundary(doc: ProseMirrorNode, pos: number): number {
  const $pos = doc.resolve(pos)
  const parent = $pos.parent
  if (!parent.inlineContent) return pos

  const parentStart = $pos.start()
  const relativePos = pos - parentStart
  const candidates = inlineTokenBoundaryOffsets(parent)
  let low = 0
  let high = candidates.length
  while (low < high) {
    const middle = (low + high) >> 1
    if ((candidates[middle] ?? 0) < relativePos) low = middle + 1
    else high = middle
  }

  const before = candidates[Math.max(0, low - 1)]
  const after = candidates[Math.min(low, candidates.length - 1)]
  if (before === undefined) return parentStart + (after ?? relativePos)
  if (after === undefined) return parentStart + before
  return parentStart + (relativePos - before <= after - relativePos ? before : after)
}

export function composerPillDropPoint(doc: ProseMirrorNode, rawPos: number, node: ProseMirrorNode): number | null {
  if (rawPos < 0 || rawPos > doc.content.size) return null
  const slice = pillSlice(node)
  const point = dropPoint(doc, rawPos, slice)
  if (point === null || !doc.resolve(point).parent.inlineContent) return null

  const snappedPoint = dropPoint(doc, nearestInlineTokenBoundary(doc, point), slice)
  if (snappedPoint === null || !doc.resolve(snappedPoint).parent.inlineContent) return null
  return snappedPoint
}

/**
 * A pill landing flush against another pill takes a separating space on that
 * side: without one there is no usable caret slot between them — un-tappable
 * on touch, and the pair reads as one blob. Text neighbors stay untouched;
 * the drop point already snaps to token boundaries.
 */
function paddedPillInsert(
  $insert: ResolvedPos,
  node: ProseMirrorNode,
  state: EditorState
): { fragment: Fragment; caretOffset: number } {
  const parts: ProseMirrorNode[] = []
  if (isComposerPillNode($insert.nodeBefore)) parts.push(state.schema.text(" "))
  const caretOffset = (parts[0]?.nodeSize ?? 0) + node.nodeSize
  parts.push(node)
  if (isComposerPillNode($insert.nodeAfter)) parts.push(state.schema.text(" "))
  return { fragment: Fragment.from(parts), caretOffset }
}

/**
 * The separator a pill earned via {@link paddedPillInsert} leaves with the
 * pill: deleting or moving one away must not orphan its space into a double
 * gap or a dangling edge. A separator is any lone " " text node beside the
 * pill — deliberately including one the user typed there themselves, which is
 * indistinguishable and wants the same fate: a bare space left clinging to a
 * paragraph edge after its pill leaves is never what was meant. Anything
 * longer is the user's text (their space merges into it on the next
 * keystroke) and is never touched.
 */
function composerPillDeleteRange(
  doc: ProseMirrorNode,
  pos: number,
  node: ProseMirrorNode
): { from: number; to: number } {
  const $pos = doc.resolve(pos)
  const $end = doc.resolve(pos + node.nodeSize)
  const isSeparator = (candidate: ProseMirrorNode | null) => candidate?.isText === true && candidate.text === " "
  const spaceBefore = isSeparator($pos.nodeBefore)
  const spaceAfter = isSeparator($end.nodeAfter)
  if (spaceBefore && spaceAfter) return { from: pos, to: pos + node.nodeSize + 1 }
  if (spaceBefore && $end.nodeAfter === null) return { from: pos - 1, to: pos + node.nodeSize }
  if (spaceAfter && $pos.nodeBefore === null) return { from: pos, to: pos + node.nodeSize + 1 }
  return { from: pos, to: pos + node.nodeSize }
}

export function createComposerPillMoveTransaction(
  state: EditorState,
  sourcePos: number,
  requestedDropPos: number
): Transaction | null {
  const node = state.doc.nodeAt(sourcePos)
  if (!isComposerPillNode(node)) return null

  const dropPos = composerPillDropPoint(state.doc, requestedDropPos, node)
  if (dropPos === null || dropPos === sourcePos || dropPos === sourcePos + node.nodeSize) return null

  const deletion = composerPillDeleteRange(state.doc, sourcePos, node)
  const tr = state.tr.delete(deletion.from, deletion.to)
  const insertPos = tr.mapping.map(dropPos)
  const $insert = tr.doc.resolve(insertPos)
  if (
    !$insert.parent.inlineContent ||
    !$insert.parent.canReplaceWith($insert.index(), $insert.index(), node.type, node.marks)
  ) {
    return null
  }

  const { fragment, caretOffset } = paddedPillInsert($insert, node, state)
  tr.insert(insertPos, fragment)
  tr.setSelection(Selection.near(tr.doc.resolve(insertPos + caretOffset), 1))
  return tr
}

/**
 * Sibling of {@link createComposerPillMoveTransaction} for a source that has no
 * position in the document: the tray is an inventory, so a drag out of it copies
 * the chip in and never empties it.
 */
export function createComposerPillInsertTransaction(
  state: EditorState,
  node: ProseMirrorNode,
  requestedDropPos: number
): Transaction | null {
  if (!isComposerPillNode(node)) return null

  const dropPos = composerPillDropPoint(state.doc, requestedDropPos, node)
  if (dropPos === null) return null

  const $insert = state.doc.resolve(dropPos)
  if (
    !$insert.parent.inlineContent ||
    !$insert.parent.canReplaceWith($insert.index(), $insert.index(), node.type, node.marks)
  ) {
    return null
  }

  const { fragment, caretOffset } = paddedPillInsert($insert, node, state)
  const tr = state.tr.insert(dropPos, fragment)
  tr.setSelection(Selection.near(tr.doc.resolve(dropPos + caretOffset), 1))
  return tr
}

/**
 * Pills are `user-select: none`, so no engine paints the selection highlight
 * over one even when it sits squarely inside the range — the surrounding text
 * highlights and the pill looks untouched. The range is real (copy carries the
 * pill), so the only thing missing is the paint, and the app supplies it.
 */
function selectedPillDecorations(state: EditorState): Decoration[] {
  const { selection } = state
  if (selection.empty || selection instanceof NodeSelection) return []

  const decorations: Decoration[] = []
  state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (!isComposerPillNode(node) || pos < selection.from || pos + node.nodeSize > selection.to) return
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "composer-pill-in-selection" }))
  })
  return decorations
}

function dragDecorations(state: EditorState): Decoration[] {
  const drag = ComposerPillDragPluginKey.getState(state)
  if (!drag) return []

  // Only a doc source has something in the document to grey out.
  const decorations: Decoration[] = []
  if (drag.source.kind === "doc") {
    const sourceNode = state.doc.nodeAt(drag.source.pos)
    if (!isComposerPillNode(sourceNode)) return []
    decorations.push(
      Decoration.node(drag.source.pos, drag.source.pos + sourceNode.nodeSize, {
        class: "composer-pill-dragging",
        "data-composer-pill-dragging": "true",
      })
    )
  }

  if (drag.dropPos !== null) {
    const dropPos = drag.dropPos
    decorations.push(
      Decoration.widget(
        dropPos,
        () => {
          const cursor = document.createElement("span")
          cursor.className = "composer-pill-drop-cursor"
          cursor.setAttribute("aria-hidden", "true")
          return cursor
        },
        {
          key: "composer-pill-drop-cursor",
          side: drag.source.kind === "doc" && dropPos <= drag.source.pos ? -1 : 1,
          ignoreSelection: true,
        }
      )
    )
  }

  return decorations
}

/**
 * The attachment whose inline references should read as "already in the
 * message". Asked for on demand — while its tray chip is dragged, or hovered
 * with a mouse — rather than painted on permanently. A live drag outranks a
 * stale hover left behind on another chip.
 */
export const ComposerPillHighlightPluginKey = new PluginKey<string | null>("composerPillHighlight")

function highlightedAttachmentId(state: EditorState): string | null {
  const drag = ComposerPillDragPluginKey.getState(state)
  if (drag?.source.kind === "tray") return drag.source.attachmentId
  return ComposerPillHighlightPluginKey.getState(state) ?? null
}

function highlightDecorations(state: EditorState): DecorationSet | null {
  const attachmentId = highlightedAttachmentId(state)
  if (!attachmentId) return null

  const decorations: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (node.type.name !== "attachmentReference" || node.attrs.id !== attachmentId) return
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "composer-pill-highlighted" }))
  })
  return decorations.length === 0 ? null : DecorationSet.create(state.doc, decorations)
}

/** The one write path for the hover half of the highlight; never enters history. */
export function setComposerPillHighlight(view: EditorView, attachmentId: string | null) {
  if ((ComposerPillHighlightPluginKey.getState(view.state) ?? null) === attachmentId) return
  view.dispatch(view.state.tr.setMeta(ComposerPillHighlightPluginKey, attachmentId).setMeta("addToHistory", false))
}

function pillDecorations(state: EditorState): DecorationSet | null {
  const decorations = [...dragDecorations(state), ...selectedPillDecorations(state)]
  return decorations.length === 0 ? null : DecorationSet.create(state.doc, decorations)
}

function mappedDragState(tr: Transaction, current: ComposerPillDragState | null): ComposerPillDragState | null {
  const meta = tr.getMeta(ComposerPillDragPluginKey) as ComposerPillDragState | null | undefined
  if (meta !== undefined) return meta
  if (!current || !tr.docChanged) return current

  const anchorPos = current.source.kind === "doc" ? current.source.pos : null
  const dropAssociation = anchorPos !== null && current.dropPos !== null && current.dropPos <= anchorPos ? -1 : 1
  const dropPos = current.dropPos === null ? null : tr.mapping.map(current.dropPos, dropAssociation)
  if (anchorPos === null) return { source: current.source, dropPos }

  const sourcePos = tr.mapping.map(anchorPos, 1)
  return isComposerPillNode(tr.doc.nodeAt(sourcePos)) ? { source: { kind: "doc", pos: sourcePos }, dropPos } : null
}

export function isComposerPillSelected(state: EditorState, pos: number): boolean {
  const { selection } = state
  return selection instanceof NodeSelection && selection.from === pos && isComposerPillNode(selection.node)
}

function pillAtPosition(doc: ProseMirrorNode, pos: number): { node: ProseMirrorNode; pos: number } | null {
  for (const candidate of [pos, pos - 1]) {
    if (candidate < 0) continue
    const node = doc.nodeAt(candidate)
    if (isComposerPillNode(node)) return { node, pos: candidate }
  }
  return null
}

function eventElement(target: EventTarget | null): Element | null {
  if (!target) return null
  if (target instanceof Element) return target
  return target instanceof Node ? target.parentElement : null
}

export function pillFromDom(view: EditorView, target: EventTarget | null): { element: Element; pos: number } | null {
  let element = eventElement(target)
  while (element && element !== view.dom) {
    if (element.hasAttribute("data-type")) {
      try {
        const found = pillAtPosition(view.state.doc, view.posAtDOM(element, 0))
        if (found) return { element, pos: found.pos }
      } catch {
        // A nested React node-view element may not map directly; its wrapper does.
      }
    }
    element = element.parentElement
  }
  return null
}

/** Resolve viewport coordinates to the pill drop position the plugin should paint. */
export function dropPositionAt(view: EditorView, x: number, y: number, sourceNode: ProseMirrorNode): number | null {
  const hit = view.dom.ownerDocument.elementFromPoint(x, y)
  if (hit && hit !== view.dom && !view.dom.contains(hit)) return null

  const hoveredPill = pillFromDom(view, hit)
  let rawPos: number | null = null
  if (hoveredPill) {
    const hoveredNode = view.state.doc.nodeAt(hoveredPill.pos)
    if (hoveredNode) {
      const rect = hoveredPill.element.getBoundingClientRect()
      rawPos = x < rect.left + rect.width / 2 ? hoveredPill.pos : hoveredPill.pos + hoveredNode.nodeSize
    }
  }

  if (rawPos === null) rawPos = view.posAtCoords({ left: x, top: y })?.pos ?? null
  return rawPos === null ? null : composerPillDropPoint(view.state.doc, rawPos, sourceNode)
}

/** The one write path into the plugin's drag state; drags never enter history. */
export function setComposerPillDragState(view: EditorView, next: ComposerPillDragState | null) {
  const current = ComposerPillDragPluginKey.getState(view.state) ?? null
  if (current === next) return
  if (current && next && current.source === next.source && current.dropPos === next.dropPos) return
  view.dispatch(view.state.tr.setMeta(ComposerPillDragPluginKey, next).setMeta("addToHistory", false))
}

export const ComposerPillDragExtension = Extension.create({
  name: "composerPillDrag",

  addProseMirrorPlugins() {
    return [
      new Plugin<ComposerPillDragState | null>({
        key: ComposerPillDragPluginKey,
        state: {
          init: () => null,
          apply: mappedDragState,
        },
        props: {
          decorations: pillDecorations,
          // Typing over a node-selected pill must not silently destroy it: a
          // tap selects the pill (that's the touch drag-eligibility gesture),
          // so the very next keystroke — a space, a letter — would replace the
          // node under ProseMirror's default. Step the caret past the pill and
          // let the text land after it; Backspace/Delete still delete.
          handleTextInput(view, _from, _to, text) {
            const { selection } = view.state
            if (!(selection instanceof NodeSelection) || !isComposerPillNode(selection.node)) return false
            const tr = view.state.tr.insertText(text, selection.to, selection.to)
            tr.setSelection(TextSelection.create(tr.doc, selection.to + text.length))
            view.dispatch(tr)
            return true
          },
          handleKeyDown(view, event) {
            if (event.key !== "Backspace" && event.key !== "Delete") return false
            const { selection } = view.state
            if (!(selection instanceof NodeSelection) || !isComposerPillNode(selection.node)) return false
            const { from, to } = composerPillDeleteRange(view.state.doc, selection.from, selection.node)
            const tr = view.state.tr.delete(from, to)
            tr.setSelection(Selection.near(tr.doc.resolve(from), -1))
            view.dispatch(tr)
            return true
          },
        },
        view(view) {
          const reflectActive = (target: EditorView) => {
            target.dom.classList.toggle(
              "composer-pill-drag-active",
              ComposerPillDragPluginKey.getState(target.state) != null
            )
          }
          return {
            update: reflectActive,
            destroy: () => view.dom.classList.remove("composer-pill-drag-active"),
          }
        },
      }),
      new Plugin<string | null>({
        key: ComposerPillHighlightPluginKey,
        state: {
          init: () => null,
          apply: (tr, current) => {
            const meta = tr.getMeta(ComposerPillHighlightPluginKey) as string | null | undefined
            return meta === undefined ? current : meta
          },
        },
        props: {
          decorations: highlightDecorations,
        },
      }),
    ]
  },
})
