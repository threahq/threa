import type { DraggableSyntheticListeners } from "@dnd-kit/core"
import { NodeSelection } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import {
  COMPOSER_PILL_TOUCH_DRAG_MODE,
  isComposerPillNode,
  isComposerPillSelected,
  pillFromDom,
  setComposerPillHighlight,
  type ComposerPillDragSource,
} from "./composer-pill-drag-extension"

const COMPATIBILITY_MOUSE_WINDOW_MS = 400

/** Bubbling DOM event announcing live pill-gesture activity; see {@link ComposerPillDragHost.markGesture}. */
export const COMPOSER_PILL_GESTURE_EVENT = "composer-pill-gesture"

export type ComposerPillGestureKind = "mouse" | "touch"

/**
 * One gesture's immutable identity, snapshotted by the sensor at pointer-down.
 * The host's own fields are overwritten by the next pointer-down on any pill —
 * which can land before the previous gesture ends — so anything acting on behalf
 * of the gesture that is ending reads this, never the host.
 */
export interface ComposerPillGesture {
  kind: ComposerPillGestureKind
  touchId: number
  source: ComposerPillDragSource
  startX: number
  startY: number
}

/**
 * The editor-side effects of a drag. Driven straight from the sensor rather than
 * from dnd-kit's React callbacks: a gesture can start and be cancelled inside a
 * single tick (a hold that the OS immediately steals), and the callbacks only
 * fire once dnd-kit's `active` state has rendered — teardown would be skipped
 * and the drag decoration would stick.
 */
export interface ComposerPillDragLifecycle {
  start(gesture: ComposerPillGesture): void
  move(gesture: ComposerPillGesture, x: number, y: number): void
  end(gesture: ComposerPillGesture, x: number, y: number): void
  cancel(): void
}

function touchById(list: TouchList, id: number): Touch | null {
  for (let index = 0; index < list.length; index++) {
    const touch = list[index]
    if (touch?.identifier === id) return touch
  }
  return null
}

/**
 * Editor-side half of the pill drag: it owns the `view.dom` listeners, hands the
 * gesture to dnd-kit's activator, and keeps the compatibility-event suppression
 * windows that outlive any single drag (a touch's synthesised mouse events land
 * after the sensor is gone).
 */
export class ComposerPillDragHost {
  private view: EditorView | null = null
  private editorSlotOwner: string | null = null
  private listeners: DraggableSyntheticListeners
  private suppressMouseUntil = 0
  private suppressClickUntil = 0
  private readonly awaitingTouchCompletions = new Set<number>()

  /** Mutable payload read through the draggable's `data` ref at activation. */
  readonly dragData: { source: ComposerPillDragSource | null } = { source: null }
  gestureKind: ComposerPillGestureKind = "mouse"
  gestureTouchId = 0
  gestureTouchEligible = false
  gestureStartX = 0
  gestureStartY = 0
  /** True once the gesture has produced a pointer move the drop point may follow. */
  engaged = false
  /** True between the sensor's activation and its teardown. */
  dragActive = false
  cancelActiveGesture: (() => void) | null = null
  lifecycle: ComposerPillDragLifecycle | null = null

  /**
   * A host drives exactly one editor. The slot is keyed by the provider that
   * binds it, not by the editor, so the provider holds it from its first render
   * — before its editor exists — and a *different* editor inside this host's
   * tree (a dialog's composer) is refused and opens its own context instead of
   * taking a binding the composer is still building towards. The key is a
   * `useId()`, stable across a re-render, a StrictMode double-invoke and a
   * remount at the same position, so re-claiming is idempotent.
   */
  claimEditorSlot(ownerId: string): boolean {
    if (this.editorSlotOwner !== null && this.editorSlotOwner !== ownerId) return false
    this.editorSlotOwner = ownerId
    return true
  }

  releaseEditorSlot(ownerId: string) {
    if (this.editorSlotOwner === ownerId) this.editorSlotOwner = null
  }

  attach(view: EditorView) {
    this.view = view
    view.dom.dataset.composerPillDragMode = COMPOSER_PILL_TOUCH_DRAG_MODE
    view.dom.addEventListener("mousedown", this.onMouseDown, true)
    view.dom.addEventListener("touchstart", this.onTouchStart, { capture: true, passive: true })
    view.dom.addEventListener("click", this.onClick, true)
    view.dom.addEventListener("dragstart", this.onNativeDragStart, true)
  }

  detach(view: EditorView) {
    if (this.view !== view) return
    this.cancelActiveGesture?.()
    this.clearAwaitedTouchCompletions()
    view.dom.removeEventListener("mousedown", this.onMouseDown, true)
    view.dom.removeEventListener("touchstart", this.onTouchStart, true)
    view.dom.removeEventListener("click", this.onClick, true)
    view.dom.removeEventListener("dragstart", this.onNativeDragStart, true)
    delete view.dom.dataset.composerPillDragMode
    this.view = null
  }

  setListeners(listeners: DraggableSyntheticListeners) {
    this.listeners = listeners
  }

  getView(): EditorView | null {
    return this.view
  }

  get source(): ComposerPillDragSource | null {
    return this.dragData.source
  }

  /**
   * True while the click that ends a just-activated drag is still travelling.
   * The tray chip is also a button (it opens the lightbox), so it asks before
   * acting on a click it may have produced by being dragged.
   */
  get activationClickSuppressed(): boolean {
    return Date.now() <= this.suppressClickUntil
  }

  /**
   * A fresh pointer-down means the click it produces belongs to that press, not
   * to the drag that ended before it — otherwise the window swallows a chip tap
   * for as long as it runs.
   */
  clearActivationClickSuppression() {
    this.suppressClickUntil = 0
  }

  /**
   * Entry point for a drag that starts outside the editor. Same activator, same
   * sensor: only the source differs, so the tray never grows a parallel path.
   */
  startTrayGesture(source: Extract<ComposerPillDragSource, { kind: "tray" }>, event: MouseEvent | TouchEvent) {
    if (!this.view?.editable) return
    if ("touches" in event) {
      const touch = event.touches[0]
      if (event.touches.length !== 1 || !touch) return
      this.dragData.source = source
      this.gestureKind = "touch"
      this.gestureTouchId = touch.identifier
      this.gestureTouchEligible = false
      this.gestureStartX = touch.clientX
      this.gestureStartY = touch.clientY
      this.forward("onTouchStart", event)
      return
    }
    if (event.button !== 0 || Date.now() <= this.suppressMouseUntil) return
    this.dragData.source = source
    this.gestureKind = "mouse"
    this.gestureTouchId = 0
    this.gestureTouchEligible = false
    this.gestureStartX = event.clientX
    this.gestureStartY = event.clientY
    this.forward("onMouseDown", event)
  }

  /**
   * Point the editor at the attachment whose references should light up. The
   * drag half is derived from the drag state, so this carries only hover.
   */
  highlightAttachment(attachmentId: string | null) {
    const view = this.view
    if (!view) return
    setComposerPillHighlight(view, attachmentId)
  }

  selectPill(pos: number) {
    const view = this.view
    if (!view) return
    const node = view.state.doc.nodeAt(pos)
    if (!isComposerPillNode(node) || !NodeSelection.isSelectable(node)) return
    view.focus()
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)).setMeta("pointer", true))
    this.keepEditorFocused()
  }

  /**
   * Announces pill-gesture activity as a bubbling DOM event. The composer
   * (an ancestor, so context can't carry this — the DnD host mounts inside
   * it) stamps the time and holds its blur-collapse for a short grace: the
   * stray Android blur can land whole tasks after {@link keepEditorFocused}'s
   * next-tick recheck, so only a guard that runs on the blur itself is safe.
   */
  markGesture() {
    this.view?.dom.dispatchEvent(new CustomEvent(COMPOSER_PILL_GESTURE_EVENT, { bubbles: true }))
  }

  /**
   * Chrome on Android can move focus off the editor after a touch interaction
   * with a non-editable pill atom — even with the compatibility mouse events
   * suppressed — and on mobile a blurred editor collapses the composer chrome
   * mid-edit. Assert focus now and once more on the next tick; blurs that
   * outlive even the recheck are caught by the composer's gesture-grace via
   * {@link markGesture}.
   */
  keepEditorFocused() {
    const view = this.view
    if (!view) return
    this.markGesture()
    if (!view.hasFocus()) view.focus()
    const dom = view.dom
    const doc = dom.ownerDocument
    setTimeout(() => {
      if (this.view !== view) return
      if (!dom.contains(doc.activeElement)) view.focus()
    }, 0)
  }

  suppressCompatibilityMouse() {
    this.suppressMouseUntil = Date.now() + COMPATIBILITY_MOUSE_WINDOW_MS
  }

  gestureEnded(gesture: ComposerPillGesture, options: { activated: boolean; touchFinished: boolean }) {
    const touchId = gesture.kind === "touch" ? gesture.touchId : null
    if (touchId !== null) this.suppressCompatibilityMouse()
    if (options.activated) this.suppressClickUntil = Date.now() + COMPATIBILITY_MOUSE_WINDOW_MS
    this.engaged = false
    this.dragActive = false
    this.cancelActiveGesture = null
    if (touchId === null) return
    if (options.touchFinished) this.stopAwaitingTouchCompletion(touchId)
    else this.awaitTouchCompletion(touchId)
  }

  private ownerDocument(): Document | null {
    return this.view?.dom.ownerDocument ?? null
  }

  private awaitTouchCompletion(id: number) {
    const doc = this.ownerDocument()
    if (!doc || this.awaitingTouchCompletions.has(id)) return
    if (this.awaitingTouchCompletions.size === 0) {
      doc.addEventListener("touchend", this.onAwaitedTouchCompletion, true)
      doc.addEventListener("touchcancel", this.onAwaitedTouchCompletion, true)
    }
    this.awaitingTouchCompletions.add(id)
  }

  private stopAwaitingTouchCompletion(id: number) {
    this.awaitingTouchCompletions.delete(id)
    if (this.awaitingTouchCompletions.size === 0) this.removeAwaitedTouchCompletionListeners()
  }

  private clearAwaitedTouchCompletions() {
    this.awaitingTouchCompletions.clear()
    this.removeAwaitedTouchCompletionListeners()
  }

  private removeAwaitedTouchCompletionListeners() {
    const doc = this.ownerDocument()
    if (!doc) return
    doc.removeEventListener("touchend", this.onAwaitedTouchCompletion, true)
    doc.removeEventListener("touchcancel", this.onAwaitedTouchCompletion, true)
  }

  private onAwaitedTouchCompletion = (event: TouchEvent) => {
    let completed = false
    for (const id of this.awaitingTouchCompletions) {
      if (!touchById(event.changedTouches, id) && touchById(event.touches, id)) continue
      this.awaitingTouchCompletions.delete(id)
      completed = true
    }
    if (completed) this.suppressCompatibilityMouse()
    if (this.awaitingTouchCompletions.size === 0) this.removeAwaitedTouchCompletionListeners()
  }

  private forward(eventName: "onMouseDown" | "onTouchStart", event: Event) {
    const listener = this.listeners?.[eventName]
    listener?.({ nativeEvent: event } as unknown as React.SyntheticEvent)
  }

  private onMouseDown = (event: MouseEvent) => {
    if (Date.now() <= this.suppressMouseUntil) {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    this.clearActivationClickSuppression()
    const view = this.view
    if (!view?.editable || event.button !== 0) return
    const pill = pillFromDom(view, event.target)
    if (!pill) return
    this.dragData.source = { kind: "doc", pos: pill.pos }
    this.gestureKind = "mouse"
    this.gestureTouchId = 0
    this.gestureTouchEligible = false
    this.gestureStartX = event.clientX
    this.gestureStartY = event.clientY
    this.forward("onMouseDown", event)
  }

  private onTouchStart = (event: TouchEvent) => {
    const view = this.view
    if (!view?.editable || event.touches.length !== 1) {
      this.cancelActiveGesture?.()
      return
    }
    const pill = pillFromDom(view, event.target)
    const touch = event.touches[0]
    if (!pill || !touch) return
    this.dragData.source = { kind: "doc", pos: pill.pos }
    this.gestureKind = "touch"
    this.gestureTouchId = touch.identifier
    this.gestureTouchEligible = isComposerPillSelected(view.state, pill.pos)
    this.gestureStartX = touch.clientX
    this.gestureStartY = touch.clientY
    this.forward("onTouchStart", event)
  }

  private onClick = (event: MouseEvent) => {
    const now = Date.now()
    if (now > this.suppressMouseUntil && now > this.suppressClickUntil) return
    this.suppressMouseUntil = 0
    this.suppressClickUntil = 0
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  private onNativeDragStart = (event: DragEvent) => {
    const view = this.view
    if (view && pillFromDom(view, event.target)) event.preventDefault()
  }
}
