import { Extension } from "@tiptap/core"
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from "@tiptap/pm/state"
import { dropPoint } from "@tiptap/pm/transform"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import { LONG_PRESS_MOVE_TOLERANCE_PX, LONG_PRESS_THRESHOLD_MS } from "@/hooks/use-long-press"
import { ComposerPillTouchGuide } from "./composer-pill-touch-guide"

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
const MOUSE_DRAG_THRESHOLD_PX = 6
const COMPATIBILITY_CLICK_WINDOW_MS = 400
const TOUCH_ACTIVATION_HAPTIC_MS = 10
const TOUCH_TARGET_HAPTIC_MS = 10
const TOUCH_DROP_HAPTIC_PATTERN_MS = [10, 20, 10]

interface ComposerPillDragState {
  sourcePos: number
  dropPos: number | null
}

interface PendingDrag {
  kind: "mouse" | "touch"
  id: number
  sourcePos: number
  startX: number
  startY: number
  active: boolean
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

function dragDecorations(state: EditorState): DecorationSet | null {
  const drag = ComposerPillDragPluginKey.getState(state)
  if (!drag) return null
  const source = state.doc.nodeAt(drag.sourcePos)
  if (!isComposerPillNode(source)) return null

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

  return DecorationSet.create(state.doc, decorations)
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

function pillFromDom(view: EditorView, target: EventTarget | null): { element: Element; pos: number } | null {
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

function dropPositionAt(view: EditorView, x: number, y: number): number | null {
  const sourceState = ComposerPillDragPluginKey.getState(view.state)
  if (!sourceState) return null
  const sourceNode = view.state.doc.nodeAt(sourceState.sourcePos)
  if (!isComposerPillNode(sourceNode)) return null

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

function distanceFromStart(drag: PendingDrag, x: number, y: number): number {
  return Math.hypot(x - drag.startX, y - drag.startY)
}

function movedBeyondLongPressTolerance(drag: PendingDrag, x: number, y: number): boolean {
  return (
    Math.abs(x - drag.startX) > LONG_PRESS_MOVE_TOLERANCE_PX || Math.abs(y - drag.startY) > LONG_PRESS_MOVE_TOLERANCE_PX
  )
}

function touchById(list: TouchList, id: number): Touch | null {
  for (let index = 0; index < list.length; index++) {
    const touch = list[index]
    if (touch?.identifier === id) return touch
  }
  return null
}

function vibrate(win: Window, pattern: number | number[]) {
  try {
    win.navigator.vibrate?.(pattern)
  } catch {
    // Vibration is optional feedback.
  }
}

class ComposerPillDragController {
  private view: EditorView
  private readonly doc: Document
  private readonly win: Window
  private pending: PendingDrag | null = null
  private longPressTimer: number | null = null
  private suppressClickUntil = 0
  private touchGuide: ComposerPillTouchGuide | null = null

  constructor(view: EditorView) {
    this.view = view
    this.doc = view.dom.ownerDocument
    this.win = this.doc.defaultView ?? window
    view.dom.addEventListener("mousedown", this.onMouseDown, true)
    view.dom.addEventListener("touchstart", this.onTouchStart, { capture: true, passive: true })
    view.dom.addEventListener("click", this.onClick, true)
    view.dom.addEventListener("contextmenu", this.onContextMenu, true)
    view.dom.addEventListener("dragstart", this.onNativeDragStart, true)
  }

  update(view: EditorView, previousState?: EditorState) {
    this.view = view
    const dragState = ComposerPillDragPluginKey.getState(view.state)
    const active = dragState !== null && dragState !== undefined
    view.dom.classList.toggle("composer-pill-drag-active", active)
    if (this.pending?.active && !active) {
      this.clearPending()
      return
    }
    if (previousState?.doc !== view.state.doc && this.pending?.kind === "touch" && this.pending.active && dragState) {
      this.touchGuide?.refresh(view.state.doc, dragState.dropPos)
    }
  }

  destroy() {
    this.view.dom.removeEventListener("mousedown", this.onMouseDown, true)
    this.view.dom.removeEventListener("touchstart", this.onTouchStart, true)
    this.view.dom.removeEventListener("click", this.onClick, true)
    this.view.dom.removeEventListener("contextmenu", this.onContextMenu, true)
    this.view.dom.removeEventListener("dragstart", this.onNativeDragStart, true)
    this.clearPending()
    this.view.dom.classList.remove("composer-pill-drag-active")
  }

  private begin(drag: PendingDrag) {
    this.cancel()
    this.pending = drag
    this.doc.addEventListener("keydown", this.onKeyDown, true)
    this.win.addEventListener("blur", this.onWindowBlur)

    if (drag.kind === "mouse") {
      this.doc.addEventListener("mousemove", this.onMouseMove, true)
      this.doc.addEventListener("mouseup", this.onMouseUp, true)
      return
    }

    this.doc.addEventListener("touchstart", this.onAdditionalTouchStart, true)
    this.doc.addEventListener("touchmove", this.onTouchMove, { capture: true, passive: false })
    this.doc.addEventListener("touchend", this.onTouchEnd, true)
    this.doc.addEventListener("touchcancel", this.onTouchCancel, true)
    this.longPressTimer = this.win.setTimeout(() => {
      if (!this.pending || this.pending.kind !== "touch") return
      this.activate()
    }, LONG_PRESS_THRESHOLD_MS)
  }

  private activate() {
    const drag = this.pending
    if (!drag || drag.active || !isComposerPillNode(this.view.state.doc.nodeAt(drag.sourcePos))) return
    drag.active = true
    this.win.getSelection()?.removeAllRanges()
    const dropPos = composerPillDropPoint(
      this.view.state.doc,
      drag.sourcePos,
      this.view.state.doc.nodeAt(drag.sourcePos)!
    )
    this.setDragState({ sourcePos: drag.sourcePos, dropPos })
    if (drag.kind === "touch") {
      this.updateTouchGuide(drag.startX, drag.startY, dropPos)
      vibrate(this.win, TOUCH_ACTIVATION_HAPTIC_MS)
    }
  }

  private updateDrop(x: number, y: number) {
    const drag = this.pending
    if (!drag?.active) return
    const current = ComposerPillDragPluginKey.getState(this.view.state)
    if (!current) {
      this.clearPending()
      return
    }
    const dropPos = dropPositionAt(this.view, x, y)
    if (drag.kind === "touch") {
      this.updateTouchGuide(x, y, dropPos)
      if (dropPos !== null && dropPos !== current.dropPos) vibrate(this.win, TOUCH_TARGET_HAPTIC_MS)
    }
    this.setDragState({ ...current, dropPos })
  }

  private finish(x: number, y: number) {
    const drag = this.pending
    if (!drag?.active) {
      this.cancel()
      return
    }

    this.updateDrop(x, y)
    const current = ComposerPillDragPluginKey.getState(this.view.state)
    const tr =
      current?.dropPos === null || current?.dropPos === undefined
        ? null
        : createComposerPillMoveTransaction(this.view.state, current.sourcePos, current.dropPos)

    const touchDrop = drag.kind === "touch"
    this.suppressClickUntil = Date.now() + COMPATIBILITY_CLICK_WINDOW_MS
    this.clearPending()
    if (tr) {
      this.view.dispatch(tr.setMeta(ComposerPillDragPluginKey, null).setMeta("uiEvent", "drop"))
      if (touchDrop) vibrate(this.win, TOUCH_DROP_HAPTIC_PATTERN_MS)
    } else {
      this.clearDragState()
    }
  }

  private cancel = () => {
    const wasActive = this.pending?.active === true
    this.clearPending()
    if (wasActive) this.clearDragState()
  }

  private clearPending() {
    if (this.longPressTimer !== null) {
      this.win.clearTimeout(this.longPressTimer)
      this.longPressTimer = null
    }
    this.doc.removeEventListener("mousemove", this.onMouseMove, true)
    this.doc.removeEventListener("mouseup", this.onMouseUp, true)
    this.doc.removeEventListener("touchstart", this.onAdditionalTouchStart, true)
    this.doc.removeEventListener("touchmove", this.onTouchMove, true)
    this.doc.removeEventListener("touchend", this.onTouchEnd, true)
    this.doc.removeEventListener("touchcancel", this.onTouchCancel, true)
    this.doc.removeEventListener("keydown", this.onKeyDown, true)
    this.win.removeEventListener("blur", this.onWindowBlur)
    this.removeTouchGuide()
    this.pending = null
  }

  private updateTouchGuide(x: number, y: number, dropPos: number | null) {
    if (this.pending?.kind !== "touch" || !this.pending.active) return
    this.touchGuide ??= new ComposerPillTouchGuide(this.doc, this.win)
    this.touchGuide.update(this.view.state.doc, dropPos, x, y)
  }

  private removeTouchGuide() {
    this.touchGuide?.destroy()
    this.touchGuide = null
  }

  private setDragState(next: ComposerPillDragState) {
    const current = ComposerPillDragPluginKey.getState(this.view.state)
    if (current?.sourcePos === next.sourcePos && current.dropPos === next.dropPos) return
    this.view.dispatch(this.view.state.tr.setMeta(ComposerPillDragPluginKey, next).setMeta("addToHistory", false))
  }

  private clearDragState() {
    const dragState = ComposerPillDragPluginKey.getState(this.view.state)
    if (dragState === null || dragState === undefined) return
    this.view.dispatch(this.view.state.tr.setMeta(ComposerPillDragPluginKey, null).setMeta("addToHistory", false))
  }

  private onMouseDown = (event: MouseEvent) => {
    if (!this.view.editable || event.button !== 0) return
    const pill = pillFromDom(this.view, event.target)
    if (!pill) return
    this.begin({
      kind: "mouse",
      id: 0,
      sourcePos: pill.pos,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    })
  }

  private onMouseMove = (event: MouseEvent) => {
    const drag = this.pending
    if (!drag || drag.kind !== "mouse") return
    if (!drag.active && distanceFromStart(drag, event.clientX, event.clientY) < MOUSE_DRAG_THRESHOLD_PX) return
    if (!drag.active) this.activate()
    if (!this.pending?.active) return
    event.preventDefault()
    event.stopPropagation()
    this.updateDrop(event.clientX, event.clientY)
  }

  private onMouseUp = (event: MouseEvent) => {
    const drag = this.pending
    if (!drag || drag.kind !== "mouse") return
    if (drag.active) event.preventDefault()
    this.finish(event.clientX, event.clientY)
  }

  private onTouchStart = (event: TouchEvent) => {
    if (!this.view.editable || event.touches.length !== 1) {
      this.cancel()
      return
    }
    const pill = pillFromDom(this.view, event.target)
    const touch = event.touches[0]
    if (!pill || !touch) return
    this.begin({
      kind: "touch",
      id: touch.identifier,
      sourcePos: pill.pos,
      startX: touch.clientX,
      startY: touch.clientY,
      active: false,
    })
  }

  private onAdditionalTouchStart = (event: TouchEvent) => {
    if (this.pending?.kind === "touch" && event.touches.length > 1) this.cancel()
  }

  private onTouchMove = (event: TouchEvent) => {
    const drag = this.pending
    if (!drag || drag.kind !== "touch") return
    if (event.touches.length > 1) {
      this.cancel()
      return
    }
    const touch = touchById(event.touches, drag.id)
    if (!touch) return
    if (!drag.active) {
      if (movedBeyondLongPressTolerance(drag, touch.clientX, touch.clientY)) this.cancel()
      return
    }
    if (event.cancelable) event.preventDefault()
    event.stopPropagation()
    this.updateDrop(touch.clientX, touch.clientY)
  }

  private onTouchEnd = (event: TouchEvent) => {
    const drag = this.pending
    if (!drag || drag.kind !== "touch") return
    const touch = touchById(event.changedTouches, drag.id)
    if (!touch) return
    if (drag.active && event.cancelable) event.preventDefault()
    this.finish(touch.clientX, touch.clientY)
  }

  private onTouchCancel = () => this.cancel()

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    this.cancel()
  }

  private onWindowBlur = () => this.cancel()

  private onClick = (event: MouseEvent) => {
    if (Date.now() > this.suppressClickUntil) return
    this.suppressClickUntil = 0
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  private onContextMenu = (event: MouseEvent) => {
    if (this.pending?.kind === "touch") event.preventDefault()
  }

  private onNativeDragStart = (event: DragEvent) => {
    if (pillFromDom(this.view, event.target)) event.preventDefault()
  }
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
          decorations: dragDecorations,
        },
        view(view) {
          const controller = new ComposerPillDragController(view)
          return {
            update: (updatedView, previousState) => controller.update(updatedView, previousState),
            destroy: () => controller.destroy(),
          }
        },
      }),
    ]
  },
})
