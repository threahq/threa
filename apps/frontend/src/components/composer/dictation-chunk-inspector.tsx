import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Sparkles } from "lucide-react"
import type { DictationChunkRecord } from "@/hooks/use-voice-dictation"
import { cn } from "@/lib/utils"

interface DictationChunkInspectorProps {
  chunks: ReadonlyMap<string, DictationChunkRecord>
  /** Flip the session-wide toggle. The popover stays open after a flip so the user can read the swapped text. */
  onToggle: () => void
}

interface AnchorState {
  chunkId: string
  rect: DOMRect
}

const POPOVER_WIDTH = 320
const VIEWPORT_MARGIN = 8

/**
 * Hover/tap inspector for the just-landed polished dictation chunk(s). The
 * editor decoration tags each chunk with a `[data-chunk-id]` attribute; this
 * component watches the document for hover/click on those elements and floats
 * a comparison popover anchored over the chunk showing both the polished and
 * raw versions, with a one-tap switch.
 *
 * Two interaction models, one component:
 *   - Mouse: hover opens, leaving both the chunk and the popover closes.
 *   - Touch / click: tap the chunk to open, tap outside (or Escape) to close.
 *
 * The popover dismisses on scroll and on chunk removal (lock / new take) so it
 * can never anchor against a stale or invisible target. Rendered via a portal
 * so it can escape clipping ancestors in the composer chrome.
 */
export function DictationChunkInspector({ chunks, onToggle }: DictationChunkInspectorProps) {
  const [anchor, setAnchor] = useState<AnchorState | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  // Keep the live chunks map accessible inside listener callbacks without
  // re-binding all the document listeners on every chunks-map identity change
  // (the map gets a new identity on every polish swap).
  const chunksRef = useRef(chunks)
  chunksRef.current = chunks

  // Drop the anchor when the underlying chunk goes away (got locked, or a new
  // take cleared the map). Without this the popover would point at empty
  // space until the user moved the mouse.
  useEffect(() => {
    if (!anchor) return
    const record = chunks.get(anchor.chunkId)
    if (!record || record.locked) setAnchor(null)
  }, [chunks, anchor])

  useEffect(() => {
    function findChunkElement(target: EventTarget | null): HTMLElement | null {
      if (!(target instanceof Element)) return null
      const el = target.closest("[data-chunk-id]")
      return el instanceof HTMLElement ? el : null
    }

    function isInsidePopover(node: Node | null): boolean {
      return !!node && (popoverRef.current?.contains(node) ?? false)
    }

    function onPointerOver(e: PointerEvent) {
      // Touch devices emulate hover-ish events on first tap; ignore them so
      // the click handler is the sole source of truth on mobile.
      if (e.pointerType === "touch") return
      const el = findChunkElement(e.target)
      if (!el) return
      const chunkId = el.dataset.chunkId
      if (!chunkId) return
      const record = chunksRef.current.get(chunkId)
      if (!record || record.locked) return
      setAnchor({ chunkId, rect: el.getBoundingClientRect() })
    }

    function onPointerOut(e: PointerEvent) {
      if (e.pointerType === "touch") return
      const next = e.relatedTarget instanceof Node ? e.relatedTarget : null
      // Don't dismiss when the cursor moves onto the popover itself (so the
      // user can hover inside it to click Switch) or onto another chunk
      // element (the next pointerover handles the re-anchor).
      if (next && isInsidePopover(next)) return
      if (next instanceof Element && next.closest("[data-chunk-id]")) return
      setAnchor(null)
    }

    function onClick(e: MouseEvent) {
      if (isInsidePopover(e.target instanceof Node ? e.target : null)) return
      const el = findChunkElement(e.target)
      if (el) {
        const chunkId = el.dataset.chunkId
        if (!chunkId) return
        const record = chunksRef.current.get(chunkId)
        if (!record || record.locked) return
        // Tapping the same chunk toggles closed; tapping a different one
        // re-anchors to it.
        setAnchor((prev) => (prev?.chunkId === chunkId ? null : { chunkId, rect: el.getBoundingClientRect() }))
        return
      }
      setAnchor(null)
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAnchor(null)
    }

    function onScroll() {
      setAnchor(null)
    }

    document.addEventListener("pointerover", onPointerOver)
    document.addEventListener("pointerout", onPointerOut)
    document.addEventListener("click", onClick)
    document.addEventListener("keydown", onKey)
    // Capture so we catch scrolls inside any composer/editor scroll container.
    window.addEventListener("scroll", onScroll, true)
    return () => {
      document.removeEventListener("pointerover", onPointerOver)
      document.removeEventListener("pointerout", onPointerOut)
      document.removeEventListener("click", onClick)
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("scroll", onScroll, true)
    }
  }, [])

  if (typeof document === "undefined" || !anchor) return null
  const record = chunks.get(anchor.chunkId)
  if (!record || record.locked) return null

  // Position above the chunk, centered, clamped to the viewport so the popover
  // never spills past the edge on narrow screens.
  const centerX = anchor.rect.left + anchor.rect.width / 2
  const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN
  const left = Math.max(VIEWPORT_MARGIN, Math.min(maxLeft, centerX - POPOVER_WIDTH / 2))
  const bottom = window.innerHeight - anchor.rect.top + VIEWPORT_MARGIN

  const polishedActive = record.currentlyShowing === "polished"
  const rawActive = record.currentlyShowing === "raw"
  const switchLabel = polishedActive ? "Show original" : "Show polished"

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Dictation polish comparison"
      className="fixed z-50 rounded-md border bg-popover p-3 text-popover-foreground shadow-md text-xs leading-relaxed animate-in fade-in-0 zoom-in-95 duration-100"
      style={{ left, bottom, width: POPOVER_WIDTH }}
    >
      <div className="space-y-2.5">
        <section>
          <div
            className={cn(
              "mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider",
              polishedActive ? "text-primary" : "text-muted-foreground"
            )}
          >
            <Sparkles className="h-3 w-3" />
            <span>Polished</span>
            {polishedActive && <span className="rounded bg-primary/15 px-1 text-[9px] font-medium">in editor</span>}
          </div>
          <p
            className={cn(
              "whitespace-pre-wrap break-words",
              polishedActive ? "text-foreground" : "text-muted-foreground/80"
            )}
          >
            {record.polished}
          </p>
        </section>
        <section className="border-t pt-2.5">
          <div
            className={cn(
              "mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider",
              rawActive ? "text-primary" : "text-muted-foreground"
            )}
          >
            <span>Original</span>
            {rawActive && <span className="rounded bg-primary/15 px-1 text-[9px] font-medium">in editor</span>}
          </div>
          <p
            className={cn(
              "whitespace-pre-wrap break-words",
              rawActive ? "text-foreground" : "text-muted-foreground/80"
            )}
          >
            {record.raw}
          </p>
        </section>
      </div>
      <button
        type="button"
        onClick={(e) => {
          // Don't bubble: the outer onClick listener would treat this as an
          // outside-click (the popover isn't a child of the chunk) and dismiss.
          e.stopPropagation()
          onToggle()
        }}
        className="mt-3 inline-flex w-full items-center justify-center gap-1 rounded border bg-background px-2 py-1 text-[11px] font-medium shadow-sm hover:bg-muted"
      >
        {switchLabel}
      </button>
    </div>,
    document.body
  )
}
