import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useFloating, offset, flip, shift, autoUpdate } from "@floating-ui/react"
import { Sparkles } from "lucide-react"
import type { DictationChunkRecord } from "@/hooks/use-voice-dictation"
import { cn } from "@/lib/utils"

interface DictationChunkInspectorProps {
  chunks: ReadonlyMap<string, DictationChunkRecord>
  /** Flip the session-wide toggle. The popover stays open after a flip so the user can read the swapped text. */
  onToggle: () => void
}

/**
 * How long the popover survives after the cursor leaves the chunk. The popover
 * is offset 8px from the chunk, so the cursor must cross a gap where it hovers
 * neither element; closing immediately on pointerout would make the popover
 * unreachable with a mouse.
 */
export const HOVER_CLOSE_GRACE_MS = 200

/**
 * Hover/tap inspector for the just-landed polished dictation chunk(s). The
 * editor decoration tags each chunk with a `[data-chunk-id]` attribute; this
 * component watches the document for hover/click on those elements and floats
 * a comparison popover anchored over the chunk showing both the polished and
 * raw versions, with a one-tap switch.
 *
 * Two interaction models, one component:
 *   - Mouse: hover opens; leaving both the chunk and the popover closes after
 *     a short grace period (the popover is offset from the chunk, so the
 *     cursor needs time to travel across the gap without dismissing it).
 *   - Touch / click: tap the chunk to open, tap outside (or Escape) to close.
 *
 * Positioning uses `@floating-ui/react` (same stack as the editor's other
 * floating UIs): `useFloating` + `offset` / `flip` / `shift` keep the popover
 * on-screen across narrow viewports, and `autoUpdate` re-positions if the
 * anchor moves (scroll, resize, editor reflow). The anchor is the live
 * `data-chunk-id` element, so we don't cache a stale DOMRect across edits.
 * Rendered via a portal so it can escape clipping ancestors in the composer
 * chrome.
 */
export function DictationChunkInspector({ chunks, onToggle }: DictationChunkInspectorProps) {
  const [anchor, setAnchor] = useState<{ chunkId: string; el: HTMLElement } | null>(null)
  // Keep the live chunks map accessible inside listener callbacks without
  // re-binding all the document listeners on every chunks-map identity change
  // (the map gets a new identity on every polish swap).
  const chunksRef = useRef(chunks)
  chunksRef.current = chunks

  const { refs, floatingStyles } = useFloating({
    placement: "top",
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    open: anchor !== null,
  })

  // Track the anchor element so floating-ui can recompute as it moves. When
  // the anchor clears we drop the reference too so the floating element
  // doesn't keep recomputing against a stale node.
  useEffect(() => {
    refs.setReference(anchor?.el ?? null)
  }, [anchor, refs])

  // Drop the anchor when the underlying chunk goes away (got locked, or a new
  // take cleared the map). Without this the popover would point at empty
  // space until the user moved the mouse.
  useEffect(() => {
    if (!anchor) return
    const record = chunks.get(anchor.chunkId)
    if (!record || record.locked) setAnchor(null)
  }, [chunks, anchor])

  const isInsidePopover = useCallback(
    (node: Node | null): boolean => {
      const popover = refs.floating.current
      return !!node && (popover?.contains(node) ?? false)
    },
    [refs.floating]
  )

  const closeTimerRef = useRef<number | null>(null)

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = useCallback(() => {
    cancelScheduledClose()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setAnchor(null)
    }, HOVER_CLOSE_GRACE_MS)
  }, [cancelScheduledClose])

  useEffect(() => cancelScheduledClose, [cancelScheduledClose])

  useEffect(() => {
    function findChunkElement(target: EventTarget | null): HTMLElement | null {
      if (!(target instanceof Element)) return null
      const el = target.closest("[data-chunk-id]")
      return el instanceof HTMLElement ? el : null
    }

    function onPointerOver(e: PointerEvent) {
      // Touch devices emulate hover-ish events on first tap; ignore them so
      // the click handler is the sole source of truth on mobile.
      if (e.pointerType === "touch") return
      // The cursor made it onto the popover: keep it open.
      if (isInsidePopover(e.target instanceof Node ? e.target : null)) {
        cancelScheduledClose()
        return
      }
      const el = findChunkElement(e.target)
      if (!el) return
      const chunkId = el.dataset.chunkId
      if (!chunkId) return
      const record = chunksRef.current.get(chunkId)
      if (!record || record.locked) return
      cancelScheduledClose()
      setAnchor({ chunkId, el })
    }

    function onPointerOut(e: PointerEvent) {
      if (e.pointerType === "touch") return
      const next = e.relatedTarget instanceof Node ? e.relatedTarget : null
      // Don't dismiss when the cursor moves onto the popover itself (so the
      // user can hover inside it to click Switch) or onto another chunk
      // element (the next pointerover handles the re-anchor).
      if (next && isInsidePopover(next)) return
      if (next instanceof Element && next.closest("[data-chunk-id]")) return
      // The popover floats with a gap from the chunk, so the cursor passes
      // over neither on its way there. Defer the close so the traversal
      // doesn't dismiss the popover before it can be reached; pointerover on
      // the popover (or a chunk) cancels the pending close.
      scheduleClose()
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
        // re-anchors to it. A pending hover-close must not fire after the
        // re-anchor, or it would dismiss the freshly opened popover.
        cancelScheduledClose()
        setAnchor((prev) => (prev?.chunkId === chunkId ? null : { chunkId, el }))
        return
      }
      setAnchor(null)
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAnchor(null)
    }

    document.addEventListener("pointerover", onPointerOver)
    document.addEventListener("pointerout", onPointerOut)
    document.addEventListener("click", onClick)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerover", onPointerOver)
      document.removeEventListener("pointerout", onPointerOut)
      document.removeEventListener("click", onClick)
      document.removeEventListener("keydown", onKey)
    }
  }, [isInsidePopover, scheduleClose, cancelScheduledClose])

  if (typeof document === "undefined" || !anchor) return null
  const record = chunks.get(anchor.chunkId)
  if (!record || record.locked) return null

  const polishedActive = record.currentlyShowing === "polished"
  const rawActive = record.currentlyShowing === "raw"
  const switchLabel = polishedActive ? "Show original" : "Show polished"

  return createPortal(
    <div
      ref={refs.setFloating}
      role="dialog"
      aria-label="Dictation polish comparison"
      className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-md border bg-popover p-3 text-popover-foreground shadow-md text-xs leading-relaxed animate-in fade-in-0 zoom-in-95 duration-100"
      style={floatingStyles}
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
