import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react"
import {
  DndContext,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
} from "@dnd-kit/core"
import type { Transaction } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import type { Editor } from "@tiptap/react"
import {
  ComposerPillDragPluginKey,
  composerPillDragNode,
  composerPillDropPoint,
  createComposerPillInsertTransaction,
  createComposerPillMoveTransaction,
  dropPositionAt,
  setComposerPillDragState,
} from "./composer-pill-drag-extension"
import {
  ComposerPillDragHost,
  type ComposerPillDragLifecycle,
  type ComposerPillGesture,
} from "./composer-pill-drag-host"
import { ComposerPillSensor } from "./composer-pill-sensor"
import { ComposerPillTouchGuide } from "./composer-pill-touch-guide"

const DRAGGABLE_ID = "composer-pill"
const DROPPABLE_ID = "composer-pill-editor"
const TOUCH_ACTIVATION_HAPTIC_MS = 10
const TOUCH_TARGET_HAPTIC_MS = 10
const TOUCH_DROP_HAPTIC_PATTERN_MS = [10, 20, 10]

// Announcements only. dnd-kit's `screenReaderInstructions` are reached through
// the `aria-describedby` in `useDraggable().attributes`, and those attributes
// belong on a draggable element — here that would be the contenteditable itself,
// which must not take `role="button"`. Announcements go through the live region
// and need no attributes.
const announcements: Announcements = {
  onDragStart: () => "Picked up the pill. Move to choose where it lands.",
  onDragOver: () => undefined,
  onDragEnd: () => "Dropped the pill.",
  onDragCancel: () => "Cancelled. The pill stayed where it was.",
}

function vibrate(win: Window, pattern: number | number[]) {
  try {
    win.navigator.vibrate?.(pattern)
  } catch {
    // Vibration is optional feedback.
  }
}

/** The editor's answer to "where would this land": a ProseMirror position. */
function resolveDropPos(host: ComposerPillDragHost, x: number, y: number): number | null {
  const view = host.getView()
  if (!view) return null
  const drag = ComposerPillDragPluginKey.getState(view.state)
  if (!drag) return null
  const sourceNode = composerPillDragNode(view.state, drag.source)
  if (!sourceNode) return null
  return dropPositionAt(view, x, y, sourceNode)
}

/**
 * The editor's drag host, so surfaces rendered inside the provider (the
 * attachment tray) can start a drag against the same sensor.
 */
const ComposerPillDragHostContext = createContext<ComposerPillDragHost | null>(null)

export function useComposerPillDragHost(): ComposerPillDragHost | null {
  return useContext(ComposerPillDragHostContext)
}

/**
 * Pointer coordinates, not rectangles, decide where a pill lands: the drop
 * target is a ProseMirror position, so the editor resolves it and reports it as
 * the single collision's payload. No position (pointer outside the editor, or a
 * slot the pill can't occupy) means no collision at all.
 */
export function createComposerPillCollisionDetection(host: ComposerPillDragHost): CollisionDetection {
  return ({ pointerCoordinates }) => {
    if (!host.engaged || !pointerCoordinates) return []
    const dropPos = resolveDropPos(host, pointerCoordinates.x, pointerCoordinates.y)
    if (dropPos === null) return []
    return [{ id: DROPPABLE_ID, data: { dropPos } }]
  }
}

function ComposerPillDragBridge({ editor, host }: { editor: Editor | null; host: ComposerPillDragHost }) {
  const { setNodeRef: setDraggableNode, listeners } = useDraggable({ id: DRAGGABLE_ID, data: host.dragData })
  const { setNodeRef: setDroppableNode } = useDroppable({ id: DROPPABLE_ID })
  const guideRef = useRef<ComposerPillTouchGuide | null>(null)

  useEffect(() => {
    host.setListeners(listeners)
  }, [host, listeners])

  useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom
    setDraggableNode(dom)
    setDroppableNode(dom)
    host.attach(editor.view)
    return () => {
      host.detach()
      setDraggableNode(null)
      setDroppableNode(null)
    }
  }, [editor, host, setDraggableNode, setDroppableNode])

  useEffect(() => {
    const releaseGuide = () => {
      guideRef.current?.destroy()
      guideRef.current = null
    }
    const windowFor = (view: EditorView) => view.dom.ownerDocument.defaultView ?? window

    const applyDropAt = (gesture: ComposerPillGesture, x: number, y: number) => {
      const view = host.getView()
      const current = view ? ComposerPillDragPluginKey.getState(view.state) : null
      if (!view || !current) return
      const dropPos = resolveDropPos(host, x, y)
      if (gesture.kind === "touch") {
        guideRef.current?.update(view.state.doc, dropPos, x, y)
        if (dropPos !== null && dropPos !== current.dropPos) vibrate(windowFor(view), TOUCH_TARGET_HAPTIC_MS)
      }
      setComposerPillDragState(view, { source: current.source, dropPos })
    }

    const lifecycle: ComposerPillDragLifecycle = {
      start: (gesture) => {
        const view = host.getView()
        if (!view) return
        const node = composerPillDragNode(view.state, gesture.source)
        if (!node) return
        // A tray source has no position to sit at, so it starts without a drop
        // point and takes one from the first move.
        const dropPos =
          gesture.source.kind === "doc" ? composerPillDropPoint(view.state.doc, gesture.source.pos, node) : null
        setComposerPillDragState(view, { source: gesture.source, dropPos })
        if (gesture.kind !== "touch") return
        guideRef.current = new ComposerPillTouchGuide(view.dom.ownerDocument, windowFor(view))
        guideRef.current.update(view.state.doc, dropPos, gesture.startX, gesture.startY)
        vibrate(windowFor(view), TOUCH_ACTIVATION_HAPTIC_MS)
      },
      move: applyDropAt,
      // The release coordinates, not the last rate-limited move, decide where the
      // pill lands: a fast flick can lift between two dispatched moves.
      end: (gesture, x, y) => {
        applyDropAt(gesture, x, y)
        const view = host.getView()
        releaseGuide()
        if (!view) return
        const drag = ComposerPillDragPluginKey.getState(view.state)
        let tr: Transaction | null = null
        if (drag && drag.dropPos !== null) {
          const node = composerPillDragNode(view.state, drag.source)
          tr =
            drag.source.kind === "doc"
              ? createComposerPillMoveTransaction(view.state, drag.source.pos, drag.dropPos)
              : node && createComposerPillInsertTransaction(view.state, node, drag.dropPos)
        }
        if (!tr) {
          setComposerPillDragState(view, null)
          return
        }
        view.dispatch(tr.setMeta(ComposerPillDragPluginKey, null).setMeta("uiEvent", "drop"))
        if (gesture.kind === "touch") vibrate(windowFor(view), TOUCH_DROP_HAPTIC_PATTERN_MS)
      },
      cancel: () => {
        const view = host.getView()
        releaseGuide()
        if (view) setComposerPillDragState(view, null)
      },
    }

    host.lifecycle = lifecycle
    return () => {
      releaseGuide()
      if (host.lifecycle === lifecycle) host.lifecycle = null
    }
  }, [host])

  // The pill can be mapped away (deleted, or replaced by an external content
  // sync) mid-drag; the plugin drops its state, and the gesture has to follow.
  useEffect(() => {
    if (!editor) return
    const onUpdate = () => {
      const drag = ComposerPillDragPluginKey.getState(editor.view.state)
      if (!drag) {
        if (host.dragActive) host.cancelActiveGesture?.()
        return
      }
      guideRef.current?.refresh(editor.view.state.doc, drag.dropPos)
    }
    editor.on("update", onUpdate)
    return () => {
      editor.off("update", onUpdate)
    }
  }, [editor, host])

  return null
}

function ComposerPillDndOwner({ editor, children }: { editor?: Editor | null; children?: ReactNode }) {
  const hostRef = useRef<ComposerPillDragHost | null>(null)
  hostRef.current ??= new ComposerPillDragHost()
  const host = hostRef.current

  const sensors = useSensors(
    useSensor(
      ComposerPillSensor,
      useMemo(() => ({ host }), [host])
    )
  )
  const collisionDetection = useMemo(() => createComposerPillCollisionDetection(host), [host])

  return (
    <DndContext autoScroll sensors={sensors} collisionDetection={collisionDetection} accessibility={{ announcements }}>
      <ComposerPillDragHostContext.Provider value={host}>
        {editor !== undefined && <ComposerPillDragBridge editor={editor} host={host} />}
        {children}
      </ComposerPillDragHostContext.Provider>
    </DndContext>
  )
}

/**
 * Owns the drag context for a surface whose editor is mounted deeper in the
 * tree, so the drag sources that sit *outside* the editor (the composer's
 * attachment tray) keep their own position in the DOM instead of being routed
 * through an editor slot. The descendant `ComposerPillDndProvider` attaches the
 * editor to this host rather than opening a second context.
 */
export function ComposerPillDndHost({ children }: { children?: ReactNode }) {
  return <ComposerPillDndOwner>{children}</ComposerPillDndOwner>
}

/**
 * Provides in-composer pill dragging to one editor. Every editor built from
 * `createEditorExtensions()` carries the ProseMirror half, so the surfaces that
 * own an editor instance (`RichEditor`, the document editor modal) each wrap it
 * in this provider rather than relying on a context further up the tree.
 *
 * Under a `ComposerPillDndHost` it binds the editor to that host instead. The
 * branch is decided by whether a host exists, which never changes for a given
 * mount — so the children keep one React position either way.
 */
export function ComposerPillDndProvider({ editor, children }: { editor: Editor | null; children?: ReactNode }) {
  const ancestorHost = useComposerPillDragHost()
  if (ancestorHost) {
    return (
      <>
        <ComposerPillDragBridge editor={editor} host={ancestorHost} />
        {children}
      </>
    )
  }
  return <ComposerPillDndOwner editor={editor}>{children}</ComposerPillDndOwner>
}
