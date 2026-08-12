import { Extension } from "@tiptap/core"
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model"
import { NodeSelection, Plugin, PluginKey, Selection, type EditorState, type Transaction } from "@tiptap/pm/state"
import { dropPoint } from "@tiptap/pm/transform"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"

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

export interface ComposerPillDragState {
  sourcePos: number
  dropPos: number | null
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

export function createComposerPillMoveTransaction(
  state: EditorState,
  sourcePos: number,
  requestedDropPos: number
): Transaction | null {
  const node = state.doc.nodeAt(sourcePos)
  if (!isComposerPillNode(node)) return null

  const dropPos = composerPillDropPoint(state.doc, requestedDropPos, node)
  if (dropPos === null || dropPos === sourcePos || dropPos === sourcePos + node.nodeSize) return null

  const insertPos = dropPos > sourcePos ? dropPos - node.nodeSize : dropPos
  const tr = state.tr.delete(sourcePos, sourcePos + node.nodeSize)
  const $insert = tr.doc.resolve(insertPos)
  if (
    !$insert.parent.inlineContent ||
    !$insert.parent.canReplaceWith($insert.index(), $insert.index(), node.type, node.marks)
  ) {
    return null
  }

  tr.insert(insertPos, node)
  tr.setSelection(Selection.near(tr.doc.resolve(insertPos + node.nodeSize), 1))
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
  const source = state.doc.nodeAt(drag.sourcePos)
  if (!isComposerPillNode(source)) return []

  const decorations: Decoration[] = [
    Decoration.node(drag.sourcePos, drag.sourcePos + source.nodeSize, {
      class: "composer-pill-dragging",
      "data-composer-pill-dragging": "true",
    }),
  ]

  if (drag.dropPos !== null) {
    decorations.push(
      Decoration.widget(
        drag.dropPos,
        () => {
          const cursor = document.createElement("span")
          cursor.className = "composer-pill-drop-cursor"
          cursor.setAttribute("aria-hidden", "true")
          return cursor
        },
        {
          key: "composer-pill-drop-cursor",
          side: drag.dropPos <= drag.sourcePos ? -1 : 1,
          ignoreSelection: true,
        }
      )
    )
  }

  return decorations
}

function pillDecorations(state: EditorState): DecorationSet | null {
  const decorations = [...dragDecorations(state), ...selectedPillDecorations(state)]
  return decorations.length === 0 ? null : DecorationSet.create(state.doc, decorations)
}

function mappedDragState(tr: Transaction, current: ComposerPillDragState | null): ComposerPillDragState | null {
  const meta = tr.getMeta(ComposerPillDragPluginKey) as ComposerPillDragState | null | undefined
  if (meta !== undefined) return meta
  if (!current || !tr.docChanged) return current

  const sourcePos = tr.mapping.map(current.sourcePos, 1)
  const dropAssociation = current.dropPos !== null && current.dropPos <= current.sourcePos ? -1 : 1
  const dropPos = current.dropPos === null ? null : tr.mapping.map(current.dropPos, dropAssociation)
  return isComposerPillNode(tr.doc.nodeAt(sourcePos)) ? { sourcePos, dropPos } : null
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
  if (current && next && current.sourcePos === next.sourcePos && current.dropPos === next.dropPos) return
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
    ]
  },
})
