import type { Activators, SensorInstance, SensorProps } from "@dnd-kit/core"
import { LONG_PRESS_MOVE_TOLERANCE_PX, LONG_PRESS_THRESHOLD_MS } from "@/hooks/use-long-press"
import {
  ComposerPillDragPluginKey,
  MOUSE_DRAG_THRESHOLD_PX,
  isComposerPillNode,
  isComposerPillSelected,
} from "./composer-pill-drag-extension"
import type { ComposerPillDragHost, ComposerPillGesture, ComposerPillGestureKind } from "./composer-pill-drag-host"

export interface ComposerPillSensorOptions {
  host: ComposerPillDragHost
}

function touchById(list: TouchList, id: number): Touch | null {
  for (let index = 0; index < list.length; index++) {
    const touch = list[index]
    if (touch?.identifier === id) return touch
  }
  return null
}

/**
 * Pointer rules dnd-kit's stock sensors can't express: a mouse activates on
 * {@link MOUSE_DRAG_THRESHOLD_PX} of movement, while a touch activates on a
 * {@link LONG_PRESS_THRESHOLD_MS} hold *or* — when the pill is already
 * node-selected — as soon as it moves past {@link LONG_PRESS_MOVE_TOLERANCE_PX}.
 * A touch that neither holds nor qualifies stays a tap or a scroll.
 */
export class ComposerPillSensor implements SensorInstance {
  autoScrollEnabled = true

  static activators: Activators<ComposerPillSensorOptions> = [
    { eventName: "onMouseDown", handler: () => true },
    { eventName: "onTouchStart", handler: () => true },
  ]

  private readonly props: SensorProps<ComposerPillSensorOptions>
  private readonly host: ComposerPillDragHost
  private readonly doc: Document
  private readonly win: Window
  private readonly kind: ComposerPillGestureKind
  private readonly touchId: number
  private readonly sourcePos: number
  private readonly startX: number
  private readonly startY: number
  private readonly touchDragEligible: boolean
  private readonly gesture: ComposerPillGesture
  private activated = false
  private holdElapsed = false
  private movedBeyondTolerance = false
  private longPressTimer: number | null = null

  constructor(props: SensorProps<ComposerPillSensorOptions>) {
    this.props = props
    this.host = props.options.host
    const view = this.host.getView()
    this.doc = view?.dom.ownerDocument ?? document
    this.win = this.doc.defaultView ?? window
    this.kind = this.host.gestureKind
    this.touchId = this.host.gestureTouchId
    this.sourcePos = this.host.source?.pos ?? -1
    this.startX = this.host.gestureStartX
    this.startY = this.host.gestureStartY
    this.touchDragEligible = this.host.gestureTouchEligible
    this.gesture = {
      kind: this.kind,
      touchId: this.touchId,
      sourcePos: this.sourcePos,
      startX: this.startX,
      startY: this.startY,
    }
    this.host.engaged = false
    this.host.cancelActiveGesture = this.cancel

    this.doc.addEventListener("keydown", this.onKeyDown, true)
    this.win.addEventListener("blur", this.onWindowBlur)

    if (this.kind === "mouse") {
      this.doc.addEventListener("mousemove", this.onMouseMove, true)
      this.doc.addEventListener("mouseup", this.onMouseUp, true)
      return
    }

    this.doc.addEventListener("touchstart", this.onAdditionalTouchStart, true)
    this.doc.addEventListener("touchmove", this.onTouchMove, { capture: true, passive: false })
    this.doc.addEventListener("touchend", this.onTouchEnd, true)
    this.doc.addEventListener("touchcancel", this.onTouchCancel, true)
    this.doc.addEventListener("selectstart", this.onSelectStart, true)
    this.doc.addEventListener("contextmenu", this.onContextMenu, true)
    this.longPressTimer = this.win.setTimeout(() => {
      this.holdElapsed = true
      this.host.suppressCompatibilityMouse()
      this.start()
    }, LONG_PRESS_THRESHOLD_MS)
  }

  private detach() {
    if (this.longPressTimer !== null) {
      this.win.clearTimeout(this.longPressTimer)
      this.longPressTimer = null
    }
    this.doc.removeEventListener("keydown", this.onKeyDown, true)
    this.win.removeEventListener("blur", this.onWindowBlur)
    this.doc.removeEventListener("mousemove", this.onMouseMove, true)
    this.doc.removeEventListener("mouseup", this.onMouseUp, true)
    this.doc.removeEventListener("touchstart", this.onAdditionalTouchStart, true)
    this.doc.removeEventListener("touchmove", this.onTouchMove, true)
    this.doc.removeEventListener("touchend", this.onTouchEnd, true)
    this.doc.removeEventListener("touchcancel", this.onTouchCancel, true)
    this.doc.removeEventListener("selectstart", this.onSelectStart, true)
    this.doc.removeEventListener("contextmenu", this.onContextMenu, true)
  }

  private finishGesture(touchFinished: boolean) {
    this.detach()
    this.host.gestureEnded(this.gesture, { activated: this.activated, touchFinished })
  }

  private start() {
    if (this.activated) return
    const view = this.host.getView()
    if (!view || !isComposerPillNode(view.state.doc.nodeAt(this.sourcePos))) return
    this.activated = true
    this.host.dragActive = true
    if (this.longPressTimer !== null) {
      this.win.clearTimeout(this.longPressTimer)
      this.longPressTimer = null
    }
    this.win.getSelection()?.removeAllRanges()
    this.host.lifecycle?.start(this.gesture)
    this.props.onStart({ x: this.startX, y: this.startY })
  }

  private move(x: number, y: number) {
    this.host.engaged = true
    this.host.lifecycle?.move(this.gesture, x, y)
    this.props.onMove({ x, y })
  }

  private cancel = () => {
    const wasActivated = this.activated
    this.finishGesture(false)
    if (wasActivated) this.host.lifecycle?.cancel()
    this.props.onCancel()
  }

  private finish(x: number, y: number) {
    const view = this.host.getView()
    if (!this.activated) {
      const tappedPillPos = this.kind === "touch" && !this.holdElapsed ? this.sourcePos : null
      this.finishGesture(this.kind === "touch")
      this.props.onEnd()
      if (tappedPillPos !== null) this.host.selectPill(tappedPillPos)
      return
    }

    if (this.kind === "touch" && !this.movedBeyondTolerance) {
      const state = view ? ComposerPillDragPluginKey.getState(view.state) : null
      const sourcePos = state?.sourcePos ?? this.sourcePos
      this.finishGesture(true)
      this.host.lifecycle?.cancel()
      this.props.onCancel()
      this.host.selectPill(sourcePos)
      return
    }

    this.finishGesture(this.kind === "touch")
    this.host.lifecycle?.end(this.gesture, x, y)
    this.props.onEnd()
  }

  private onMouseMove = (event: MouseEvent) => {
    if (!this.activated) {
      if (Math.hypot(event.clientX - this.startX, event.clientY - this.startY) < MOUSE_DRAG_THRESHOLD_PX) return
      this.start()
      if (!this.activated) return
    }
    event.preventDefault()
    event.stopPropagation()
    this.move(event.clientX, event.clientY)
  }

  private onMouseUp = (event: MouseEvent) => {
    if (this.activated) event.preventDefault()
    this.finish(event.clientX, event.clientY)
  }

  private onAdditionalTouchStart = (event: TouchEvent) => {
    if (event.touches.length > 1) this.cancel()
  }

  private onTouchMove = (event: TouchEvent) => {
    if (event.touches.length > 1) {
      this.cancel()
      return
    }
    const touch = touchById(event.touches, this.touchId)
    if (!touch) return
    const beyondTolerance =
      Math.abs(touch.clientX - this.startX) > LONG_PRESS_MOVE_TOLERANCE_PX ||
      Math.abs(touch.clientY - this.startY) > LONG_PRESS_MOVE_TOLERANCE_PX
    if (beyondTolerance) this.movedBeyondTolerance = true

    if (!this.activated) {
      if (!beyondTolerance) return
      const view = this.host.getView()
      if (!this.touchDragEligible || !view || !isComposerPillSelected(view.state, this.sourcePos)) {
        this.cancel()
        return
      }
      this.start()
      if (!this.activated) return
    }
    if (event.cancelable) event.preventDefault()
    event.stopPropagation()
    if (this.movedBeyondTolerance) this.move(touch.clientX, touch.clientY)
  }

  private onTouchEnd = (event: TouchEvent) => {
    const touch = touchById(event.changedTouches, this.touchId)
    if (!touch) return
    if (this.activated && event.cancelable) event.preventDefault()
    this.finish(touch.clientX, touch.clientY)
  }

  private onTouchCancel = () => {
    const wasActivated = this.activated
    this.finishGesture(true)
    if (wasActivated) this.host.lifecycle?.cancel()
    this.props.onCancel()
  }

  private onSelectStart = (event: Event) => {
    event.preventDefault()
  }

  private onContextMenu = (event: MouseEvent) => {
    event.preventDefault()
    if (this.activated) return
    this.holdElapsed = true
    this.host.suppressCompatibilityMouse()
    this.start()
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    this.cancel()
  }

  private onWindowBlur = () => this.cancel()
}
