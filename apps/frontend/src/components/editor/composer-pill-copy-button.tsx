import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Check, Copy } from "lucide-react"
import { toast } from "sonner"
import type { Editor } from "@tiptap/react"
import { NodeSelection } from "@tiptap/pm/state"
import { Button } from "@/components/ui/button"
import { useInputMode } from "@/hooks/use-input-mode"
import { cn } from "@/lib/utils"
import { serializeClipboardSlice } from "./clipboard-copy"
import { ComposerPillDragPluginKey, isComposerPillNode } from "./composer-pill-drag-extension"

const COPY_CONFIRMATION_MS = 1_200
const COPY_BUTTON_GAP_PX = 8
const COPY_BUTTON_SIZE_PX = 40

interface CopyButtonAnchor {
  pos: number
  left: number
  top: number
  below: boolean
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

function copyButtonAnchor(editor: Editor): CopyButtonAnchor | null {
  if (editor.isDestroyed || ComposerPillDragPluginKey.getState(editor.state)) return null
  const pos = selectedPillPos(editor)
  if (pos === null) return null

  const rect = pillRect(editor, pos)
  if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) return null
  const half = COPY_BUTTON_SIZE_PX / 2
  const left = Math.min(Math.max(rect.left + rect.width / 2, half), Math.max(half, window.innerWidth - half))
  const below = rect.top < COPY_BUTTON_SIZE_PX + COPY_BUTTON_GAP_PX
  return {
    pos,
    left,
    top: below ? rect.bottom + COPY_BUTTON_GAP_PX : rect.top - COPY_BUTTON_GAP_PX,
    below,
  }
}

function sameAnchor(left: CopyButtonAnchor | null, right: CopyButtonAnchor | null): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.pos === right.pos && left.left === right.left && left.top === right.top && left.below === right.below
}

/**
 * Touch-owned copy affordance for a selected composer pill. Blink resolves a
 * long press inside a contenteditable against its own editing heuristics, so a
 * native selection can neither be pinned to one atom nor share the gesture with
 * the app's drag; the pill's exact `NodeSelection` gets its own control instead.
 */
export function ComposerPillCopyButton({ editor }: { editor: Editor | null }) {
  const inputMode = useInputMode()
  const [anchor, setAnchor] = useState<CopyButtonAnchor | null>(null)
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!editor || editor.isDestroyed || inputMode !== "touch") {
      setAnchor(null)
      return
    }

    const sync = () => {
      const next = copyButtonAnchor(editor)
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
  }, [editor, inputMode])

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

  // A parent re-render can land between the editor's teardown and this effect's
  // cleanup, and `view` throws once unmounted while `isDestroyed` stays safe.
  if (!anchor || !editor || editor.isDestroyed) return null

  return createPortal(
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={cn(
        "fixed z-[80] -translate-x-1/2 rounded-full border-primary/40 bg-popover/95 shadow-lg active:scale-[0.97]",
        anchor.below ? "translate-y-0" : "-translate-y-full"
      )}
      style={{ left: anchor.left, top: anchor.top }}
      // Keeping the press off the document leaves the pill's NodeSelection and
      // the soft keyboard in place; Chrome for Android still delivers the click.
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => void copyPill()}
      aria-label={copied ? "Pill copied" : "Copy pill"}
    >
      {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
    </Button>,
    editor.view.dom.ownerDocument.body
  )
}
