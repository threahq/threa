import { useLayoutEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import type { Editor } from "@tiptap/react"
import { MessageSquare, MessageSquarePlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createDraftPanelId, usePanel } from "@/contexts"
import { useLatest } from "@/hooks/use-latest"
import type { DocBlockThreads } from "./use-doc-block-threads"

interface MeasuredBlock {
  index: number
  blockId: string | null
  /** From the gutter's container, which scrolls with the editor. */
  top: number
  bottom: number
}

function sameBlocks(a: MeasuredBlock[], b: MeasuredBlock[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (block, i) =>
        block.index === b[i].index &&
        block.blockId === b[i].blockId &&
        block.top === b[i].top &&
        block.bottom === b[i].bottom
    )
  )
}

function measureBlocks(editor: Editor, container: HTMLElement): MeasuredBlock[] {
  const origin = container.getBoundingClientRect().top
  const blocks: MeasuredBlock[] = []
  editor.state.doc.forEach((node, offset, index) => {
    const dom = editor.view.nodeDOM(offset)
    if (!(dom instanceof HTMLElement)) return
    const rect = dom.getBoundingClientRect()
    const blockId = typeof node.attrs.blockId === "string" ? node.attrs.blockId : null
    blocks.push({ index, blockId, top: rect.top - origin, bottom: rect.bottom - origin })
  })
  return blocks
}

/** The block a pointer at `y` is over: each block owns the gap down to the next one. */
function blockAt(blocks: MeasuredBlock[], y: number): number | null {
  for (let i = 0; i < blocks.length; i++) {
    const end = i + 1 < blocks.length ? blocks[i + 1].top : blocks[i].bottom
    if (y >= blocks[i].top && y < end) return blocks[i].index
  }
  return null
}

const MAX_SHOWN_COUNT = 99

function commentsLabel(count: number): string {
  return count === 1 ? "1 comment on this block" : `${count} comments on this block`
}

interface DocBlockGutterProps {
  editor: Editor | null
  /** The positioned editor column the overlay sits in; blocks are measured from its top. */
  container: HTMLElement | null
  docId: string
  threads: DocBlockThreads
  canComment: boolean
}

/** Comment counts beside the doc's top-level blocks, and Comment on the hovered block, else the caret's. */
export function DocBlockGutter({ editor, container, docId, threads, canComment }: DocBlockGutterProps) {
  const { getPanelUrl } = usePanel()
  const overlayRef = useRef<HTMLDivElement>(null)
  const [blocks, setBlocks] = useState<MeasuredBlock[]>([])
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [caretIndex, setCaretIndex] = useState<number | null>(null)
  const latestBlocks = useLatest(blocks)

  useLayoutEffect(() => {
    const overlay = overlayRef.current
    if (!editor || editor.isDestroyed || !overlay || !container) return

    const measure = () => {
      if (editor.isDestroyed) return
      const next = measureBlocks(editor, container)
      setBlocks((previous) => (sameBlocks(previous, next) ? previous : next))
    }
    let focused = editor.isFocused
    const trackCaret = () => setCaretIndex(focused ? editor.state.selection.$from.index(0) : null)
    const onFocus = () => {
      focused = true
      trackCaret()
    }
    const onBlur = ({ event }: { event: FocusEvent }) => {
      if (event.relatedTarget instanceof Node && overlay.contains(event.relatedTarget)) return
      focused = false
      trackCaret()
    }
    const onOverlayFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget
      if (next instanceof Node && (overlay.contains(next) || editor.view.dom.contains(next))) return
      focused = false
      trackCaret()
    }
    // A tap must not leave a hover behind that outranks the caret.
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return
      const y = event.clientY - container.getBoundingClientRect().top
      setHoveredIndex(blockAt(latestBlocks(), y))
    }
    const onPointerLeave = () => setHoveredIndex(null)

    measure()
    trackCaret()
    editor.on("update", measure)
    editor.on("selectionUpdate", trackCaret)
    editor.on("focus", onFocus)
    editor.on("blur", onBlur)
    overlay.addEventListener("focusout", onOverlayFocusOut)
    container.addEventListener("pointermove", onPointerMove)
    container.addEventListener("pointerleave", onPointerLeave)
    window.addEventListener("resize", measure)
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(editor.view.dom)
    return () => {
      editor.off("update", measure)
      editor.off("selectionUpdate", trackCaret)
      editor.off("focus", onFocus)
      editor.off("blur", onBlur)
      overlay.removeEventListener("focusout", onOverlayFocusOut)
      container.removeEventListener("pointermove", onPointerMove)
      container.removeEventListener("pointerleave", onPointerLeave)
      window.removeEventListener("resize", measure)
      resizeObserver.disconnect()
    }
  }, [editor, container, latestBlocks])

  const activeIndex = hoveredIndex ?? caretIndex

  return (
    <div ref={overlayRef} className="pointer-events-none absolute inset-y-0 right-1.5 w-7">
      {blocks.map(({ index, blockId, top }) => {
        if (!blockId) return null
        const thread = threads.get(blockId)
        if (thread) {
          return (
            <Button
              key={index}
              asChild
              variant="ghost"
              size="sm"
              className="pointer-events-auto absolute right-0 h-6 min-w-7 gap-0.5 px-1 text-xs text-muted-foreground"
              style={{ top }}
            >
              <Link to={getPanelUrl(thread.threadId)} aria-label={commentsLabel(thread.replyCount)}>
                <MessageSquare className="h-3 w-3" aria-hidden />
                <span className="tabular-nums">
                  {thread.replyCount > MAX_SHOWN_COUNT ? `${MAX_SHOWN_COUNT}+` : thread.replyCount}
                </span>
              </Link>
            </Button>
          )
        }
        if (!canComment || index !== activeIndex) return null
        return (
          <Button
            key={index}
            asChild
            variant="ghost"
            size="icon"
            className="pointer-events-auto absolute right-0.5 h-6 w-6 text-muted-foreground"
            style={{ top }}
          >
            {/* Keeps the editor's focus, so the caret's block stays active through the tap. */}
            <Link
              to={getPanelUrl(createDraftPanelId(docId, blockId))}
              aria-label="Comment on this block"
              onMouseDown={(event) => event.preventDefault()}
            >
              <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </Button>
        )
      })}
    </div>
  )
}
