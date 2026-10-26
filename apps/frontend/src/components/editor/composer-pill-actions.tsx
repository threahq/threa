import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react"
import { createPortal } from "react-dom"
import { Check, Copy, Image, Maximize2, Tag } from "lucide-react"
import { toast } from "sonner"
import type { Editor } from "@tiptap/react"
import { NodeSelection } from "@tiptap/pm/state"
import { Button } from "@/components/ui/button"
import { useInputMode } from "@/hooks/use-input-mode"
import { cn } from "@/lib/utils"
import { serializeClipboardSlice } from "./clipboard-copy"
import { ComposerPillDragPluginKey, isComposerPillNode } from "./composer-pill-drag-extension"
import { useImageViewer, type ImageViewer } from "./image-viewer-context"
import {
  DISPLAY_TOGGLE_LABEL,
  imageReferenceDisplay,
  toggledDisplay,
  type AttachmentDisplay,
} from "./attachment-reference-extension"

const COPY_CONFIRMATION_MS = 1_200
const ACTION_BAR_OFFSET_PX = 8
const ACTION_BUTTON_SIZE_PX = 40
const ACTION_BUTTON_GAP_PX = 8

interface ActionBarAnchor {
  pos: number
  left: number
  top: number
  below: boolean
  imageDisplay: AttachmentDisplay | null
  canOpenImage: boolean
}

function pillRect(editor: Editor, pos: number): DOMRect | null {
  const dom = editor.view.nodeDOM(pos)
  const element = dom instanceof Element ? dom : dom?.parentElement
  if (element) return element.getBoundingClientRect()

  try {
    const node = editor.state.doc.nodeAt(pos)
    if (!node) return null
    const start = editor.view.coordsAtPos(pos)
    const end = editor.view.coordsAtPos(pos + node.nodeSize)
    return new DOMRect(
      Math.min(start.left, end.left),
      Math.min(start.top, end.top),
      Math.abs(end.left - start.left),
      Math.max(start.bottom, end.bottom) - Math.min(start.top, end.top)
    )
  } catch {
    return null
  }
}

function selectedPillPos(editor: Editor): number | null {
  const { selection } = editor.state
  if (!(selection instanceof NodeSelection) || !isComposerPillNode(selection.node)) return null
  return selection.from
}

function actionBarAnchor(editor: Editor, viewer: ImageViewer | null): ActionBarAnchor | null {
  if (editor.isDestroyed || ComposerPillDragPluginKey.getState(editor.state)) return null
  const pos = selectedPillPos(editor)
  if (pos === null) return null

  const rect = pillRect(editor, pos)
  if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) return null
  const node = editor.state.doc.nodeAt(pos)
  const imageDisplay = node ? imageReferenceDisplay(node) : null
  const canOpenImage = !!viewer && !!imageDisplay && node?.attrs.status === "uploaded"
  const buttonCount = 1 + (imageDisplay ? 1 : 0) + (canOpenImage ? 1 : 0)
  const barWidth = buttonCount * ACTION_BUTTON_SIZE_PX + (buttonCount - 1) * ACTION_BUTTON_GAP_PX
  const half = barWidth / 2
  const left = Math.min(Math.max(rect.left + rect.width / 2, half), Math.max(half, window.innerWidth - half))
  const below = rect.top < ACTION_BUTTON_SIZE_PX + ACTION_BAR_OFFSET_PX
  return {
    pos,
    left,
    top: below ? rect.bottom + ACTION_BAR_OFFSET_PX : rect.top - ACTION_BAR_OFFSET_PX,
    below,
    imageDisplay,
    canOpenImage,
  }
}

function sameAnchor(left: ActionBarAnchor | null, right: ActionBarAnchor | null): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.pos === right.pos &&
    left.left === right.left &&
    left.top === right.top &&
    left.below === right.below &&
    left.imageDisplay === right.imageDisplay &&
    left.canOpenImage === right.canOpenImage
  )
}

/**
 * Touch-owned actions for a selected composer pill (copy, and for an image the
 * display toggle and, where the surface has a gallery, opening it). Blink resolves a long press inside a contenteditable against its
 * own editing heuristics, so a native selection can neither be pinned to one atom
 * nor share the gesture with the app's drag; the pill's exact `NodeSelection`
 * gets its own control instead.
 */
export function ComposerPillActions({ editor }: { editor: Editor | null }) {
  const inputMode = useInputMode()
  const viewer = useImageViewer()
  const [anchor, setAnchor] = useState<ActionBarAnchor | null>(null)
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!editor || editor.isDestroyed || inputMode !== "touch") {
      setAnchor(null)
      return
    }

    const sync = () => {
      const next = actionBarAnchor(editor, viewer)
      setAnchor((current) => (sameAnchor(current, next) ? current : next))
    }
    const hide = () => setAnchor(null)
    const doc = editor.view.dom.ownerDocument
    const win = doc.defaultView ?? window
    sync()
    editor.on("selectionUpdate", sync)
    editor.on("transaction", sync)
    editor.on("blur", hide)
    doc.addEventListener("scroll", sync, true)
    win.addEventListener("resize", sync)
    win.visualViewport?.addEventListener("resize", sync)
    win.visualViewport?.addEventListener("scroll", sync)
    return () => {
      editor.off("selectionUpdate", sync)
      editor.off("transaction", sync)
      editor.off("blur", hide)
      doc.removeEventListener("scroll", sync, true)
      win.removeEventListener("resize", sync)
      win.visualViewport?.removeEventListener("resize", sync)
      win.visualViewport?.removeEventListener("scroll", sync)
    }
  }, [editor, inputMode, viewer])

  useEffect(() => {
    setCopied(false)
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
  }, [anchor?.pos])

  useEffect(
    () => () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    },
    []
  )

  const copyPill = useCallback(async () => {
    if (!editor || editor.isDestroyed || selectedPillPos(editor) === null) return

    try {
      await navigator.clipboard.writeText(serializeClipboardSlice(editor.state.selection.content(), editor.view))
      setCopied(true)
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
      resetTimerRef.current = setTimeout(() => setCopied(false), COPY_CONFIRMATION_MS)
    } catch {
      toast.error("Couldn't copy")
    }
  }, [editor])

  const toggleDisplay = useCallback(() => {
    if (!editor || editor.isDestroyed) return
    const pos = selectedPillPos(editor)
    const node = pos === null ? null : editor.state.doc.nodeAt(pos)
    const current = node ? imageReferenceDisplay(node) : null
    if (pos === null || !node || !current) return
    const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, display: toggledDisplay(current) })
    editor.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)))
  }, [editor])

  const openImage = useCallback(() => {
    if (!editor || editor.isDestroyed || !viewer) return
    const pos = selectedPillPos(editor)
    const node = pos === null ? null : editor.state.doc.nodeAt(pos)
    if (pos === null || !node) return
    // The bar sits above every overlay; moving the caret past the pill takes it down under the gallery.
    editor.commands.setTextSelection(pos + node.nodeSize)
    viewer.open(node.attrs.id as string)
  }, [editor, viewer])

  // A parent re-render can land between the editor's teardown and this effect's
  // cleanup, and `view` throws once unmounted while `isDestroyed` stays safe.
  if (!anchor || !editor || editor.isDestroyed) return null

  // Keeping the press off the document leaves the pill's NodeSelection and
  // the soft keyboard in place; Chrome for Android still delivers the click.
  const keepSelection = (event: PointerEvent) => event.preventDefault()
  const buttonClass = "rounded-full border-primary/40 bg-popover/95 shadow-lg active:scale-[0.97]"

  return createPortal(
    <div
      className={cn("fixed z-[80] flex -translate-x-1/2", anchor.below ? "translate-y-0" : "-translate-y-full")}
      style={{ left: anchor.left, top: anchor.top, gap: ACTION_BUTTON_GAP_PX }}
    >
      <Button
        type="button"
        variant="outline"
        size="icon"
        className={buttonClass}
        onPointerDown={keepSelection}
        onClick={() => void copyPill()}
        aria-label={copied ? "Pill copied" : "Copy pill"}
      >
        {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
      </Button>
      {anchor.canOpenImage && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={buttonClass}
          onPointerDown={keepSelection}
          onClick={openImage}
          aria-label="Open image"
        >
          <Maximize2 className="size-4" />
        </Button>
      )}
      {anchor.imageDisplay && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={buttonClass}
          onPointerDown={keepSelection}
          onClick={toggleDisplay}
          aria-label={DISPLAY_TOGGLE_LABEL[anchor.imageDisplay]}
        >
          {anchor.imageDisplay === "inline" ? <Tag className="size-4" /> : <Image className="size-4" />}
        </Button>
      )}
    </div>,
    editor.view.dom.ownerDocument.body
  )
}
