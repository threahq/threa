import { createContext, useContext, useEffect, useId, useMemo, useRef, type ReactNode } from "react"
import { createPortal } from "react-dom"
import {
  DndContext,
  DragOverlay,
  useDndContext,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
} from "@dnd-kit/core"
import { FileIcon, ImageIcon } from "lucide-react"
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
  type ComposerPillDragSource,
} from "./composer-pill-drag-extension"
import { AttachmentPill } from "@/components/composer/attachment-pill"
import { formatFileSize } from "@/lib/file-size"
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

function ComposerPillDragBridge({
  editor,
  host,
  ownerId,
}: {
  editor: Editor | null
  host: ComposerPillDragHost
  ownerId: string
}) {
  const { setNodeRef: setDraggableNode, listeners } = useDraggable({ id: DRAGGABLE_ID, data: host.dragData })
  const { setNodeRef: setDroppableNode } = useDroppable({ id: DROPPABLE_ID })
  const guideRef = useRef<ComposerPillTouchGuide | null>(null)

  useEffect(() => {
    host.setListeners(listeners)
  }, [host, listeners])

  useEffect(() => {
    if (!editor) return
    if (!host.claimEditorSlot(ownerId)) return
    const view = editor.view
    const dom = view.dom
    setDraggableNode(dom)
    setDroppableNode(dom)
    host.attach(view)
    return () => {
      host.detach(view)
      setDraggableNode(null)
      setDroppableNode(null)
    }
  }, [editor, host, ownerId, setDraggableNode, setDroppableNode])

  // The slot is held for as long as this provider is mounted, not for as long as
  // it has an editor: rebuilding the editor must not open a window where another
  // one can take the host.
  useEffect(() => () => host.releaseEditorSlot(ownerId), [host, ownerId])

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
          host.keepEditorFocused()
          return
        }
        view.dispatch(tr.setMeta(ComposerPillDragPluginKey, null).setMeta("uiEvent", "drop"))
        // The drop must leave the editor focused: a post-gesture blur on
        // mobile collapses the composer chrome over the just-edited draft.
        host.keepEditorFocused()
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

/**
 * The ghost that follows the pointer during a drag out of the tray. Only a tray
 * source gets one: an in-document pill is already visible, dimmed in place, and
 * a second copy of it would be new behaviour.
 *
 * dnd-kit anchors the overlay on the draggable node, which here is the editor
 * itself — the tray chip is not the draggable. So the ghost is offset from the
 * editor's corner to the pointer's start, and dnd-kit's own transform carries it
 * from there.
 */
function ComposerPillDragPreview({ host }: { host: ComposerPillDragHost }) {
  const { active } = useDndContext()
  const source = (active?.data.current as { source?: ComposerPillDragSource | null } | undefined)?.source ?? null
  const tray = source?.kind === "tray" ? source : null
  const offset = useMemo(() => {
    const rect = tray ? host.getView()?.dom.getBoundingClientRect() : null
    if (!rect) return null
    return { x: host.gestureStartX - rect.left, y: host.gestureStartY - rect.top }
  }, [host, tray])
  if (!tray || !offset) return null

  const { attrs } = tray
  return (
    <span
      data-testid="composer-pill-drag-preview"
      className="inline-flex"
      style={{ transform: `translate3d(${offset.x}px, calc(${offset.y}px - 50%), 0)` }}
    >
      <AttachmentPill
        icon={attrs.mimeType.startsWith("image/") ? ImageIcon : FileIcon}
        label={attrs.filename}
        secondary={attrs.sizeBytes == null ? undefined : formatFileSize(attrs.sizeBytes)}
        labelMaxWidth="max-w-[120px]"
        className="shadow-lg"
      />
    </span>
  )
}

function ComposerPillDndOwner({ editor, children }: { editor?: Editor | null; children?: ReactNode }) {
  const hostRef = useRef<ComposerPillDragHost | null>(null)
  hostRef.current ??= new ComposerPillDragHost()
  const host = hostRef.current
  const ownerId = useId()

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
        {editor !== undefined && <ComposerPillDragBridge editor={editor} host={host} ownerId={ownerId} />}
        {children}
        {/* Portaled to <body>: DragOverlay renders in place with position:
            fixed, and fixed resolves against the nearest transformed ancestor
            — the composer sits under wrappers that carry transforms on mobile
            (panel/sidebar slides), which displaced the ghost by the wrapper's
            whole offset. On body, fixed always means the real viewport. */}
        {createPortal(
          <DragOverlay dropAnimation={null} style={{ pointerEvents: "none" }}>
            <ComposerPillDragPreview host={host} />
          </DragOverlay>,
          document.body
        )}
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
 * Under a `ComposerPillDndHost` whose editor slot is still free it binds the
 * editor to that host instead. A host already driving an editor is not borrowed:
 * a second editor rendered inside the composer's tree (the scheduled-message
 * edit dialog, portaled but still a React descendant) opens its own context, so
 * it neither steals the composer's view nor takes dnd-kit's ids twice. The
 * branch is read once per mount and never flips, so the children keep one React
 * position either way.
 */
export function ComposerPillDndProvider({ editor, children }: { editor: Editor | null; children?: ReactNode }) {
  const ancestorHost = useComposerPillDragHost()
  const ownerId = useId()
  const boundHostRef = useRef<ComposerPillDragHost | null | undefined>(undefined)
  // Claimed during render, not in the effect: two providers can render in one
  // commit, and the loser has to know before it picks a branch. The claim is
  // keyed by this provider, so it holds from the first render — an editor that
  // does not exist yet must not cost the composer its own host — and re-taking
  // it on a re-render, a StrictMode double-invoke or a remount is a no-op.
  if (boundHostRef.current === undefined) {
    boundHostRef.current = ancestorHost?.claimEditorSlot(ownerId) ? ancestorHost : null
  }
  const boundHost = boundHostRef.current
  if (boundHost) {
    return (
      <>
        <ComposerPillDragBridge editor={editor} host={boundHost} ownerId={ownerId} />
        {children}
      </>
    )
  }
  return <ComposerPillDndOwner editor={editor}>{children}</ComposerPillDndOwner>
}
