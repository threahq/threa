import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Check, Copy } from "lucide-react"
import { toast } from "sonner"
import type { Editor } from "@tiptap/react"
import { NodeSelection } from "@tiptap/pm/state"
import { Button } from "@/components/ui/button"
import { useInputMode } from "@/hooks/use-input-mode"
import { serializeClipboardSlice } from "./clipboard-copy"
import { ComposerPillDragPluginKey, isComposerPillNode } from "./composer-pill-drag-extension"

const COPY_CONFIRMATION_MS = 1_200
const COPY_BUTTON_GAP_PX = 8
const COPY_BUTTON_HALF_WIDTH_PX = 48
const COPY_BUTTON_HEIGHT_PX = 40

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

function copyButtonAnchor(editor: Editor): CopyButtonAnchor | null {
  if (editor.isDestroyed || ComposerPillDragPluginKey.getState(editor.state)) return null
  const { selection } = editor.state
  if (!(selection instanceof NodeSelection) || !isComposerPillNode(selection.node)) return null

  const rect = pillRect(editor, selection.from)
  if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) return null
  const center = rect.left + rect.width / 2
  const left = Math.min(
    Math.max(center, COPY_BUTTON_HALF_WIDTH_PX),
    Math.max(COPY_BUTTON_HALF_WIDTH_PX, window.innerWidth - COPY_BUTTON_HALF_WIDTH_PX)
  )
  const below = rect.top < COPY_BUTTON_HEIGHT_PX + COPY_BUTTON_GAP_PX
  return {
    pos: selection.from,
    left,
    top: below ? rect.bottom + COPY_BUTTON_GAP_PX : rect.top - COPY_BUTTON_GAP_PX,
    below,
  }
}

/** Touch-only atomic copy affordance for a selected composer pill. */
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

    const sync = () => setAnchor(copyButtonAnchor(editor))
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
    if (!editor || editor.isDestroyed) return
    const { selection } = editor.state
    if (!(selection instanceof NodeSelection) || !isComposerPillNode(selection.node)) return

    try {
      const text = serializeClipboardSlice(selection.content(), editor.view)
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
      resetTimerRef.current = setTimeout(() => setCopied(false), COPY_CONFIRMATION_MS)
    } catch {
      toast.error("Couldn't copy pill")
    }
  }, [editor])

  if (!anchor || inputMode !== "touch") return null
  const doc = editor?.view.dom.ownerDocument ?? document

  return createPortal(
    <Button
      type="button"
      variant="outline"
      className="fixed z-[90] h-10 rounded-full bg-popover px-3 text-popover-foreground shadow-lg shadow-black/10 active:scale-[0.97]"
      style={{
        left: anchor.left,
        top: anchor.top,
        transform: anchor.below ? "translate(-50%, 0)" : "translate(-50%, -100%)",
      }}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => void copyPill()}
      aria-label={copied ? "Copied selected pill" : "Copy selected pill"}
    >
      {copied ? <Check className="text-emerald-500" /> : <Copy />}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </Button>,
    doc.body
  )
}
