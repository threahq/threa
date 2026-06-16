import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { ChevronsDown, ChevronsUp } from "lucide-react"
import { cn } from "@/lib/utils"
import { useLinkPreviewCollapse } from "@/hooks/use-link-preview-collapse"

/**
 * Shared cap on every card-style link preview's body height. In pixels because
 * overflow detection compares `scrollHeight` against this value. Keep in sync
 * with `BODY_HEIGHT_CLASS`.
 */
export const LINK_PREVIEW_BODY_HEIGHT_PX = 128
const BODY_HEIGHT_CLASS = "max-h-32"

interface LinkPreviewBodyProps {
  children: ReactNode
  /**
   * Scopes the expand/collapse persistence key. When absent (tests or transient
   * contexts), toggling is disabled and state stays in memory; the clamp still applies.
   */
  messageId: string | undefined
  previewId: string
}

/**
 * Clamps preview content to a shared fixed height and reveals a "Show more" /
 * "Show less" toggle when the content overflows. The expansion choice persists
 * via `useLinkPreviewCollapse` so reloads restore the user's selection.
 */
export function LinkPreviewBody({ children, messageId, previewId }: LinkPreviewBodyProps) {
  const { expanded, toggle } = useLinkPreviewCollapse(messageId, previewId)
  const innerRef = useRef<HTMLDivElement>(null)
  const [naturalHeight, setNaturalHeight] = useState(0)

  // Measure the content's natural height off of the inner element (not the
  // clamped wrapper) so the value is stable across expand/collapse toggles.
  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    setNaturalHeight(el.scrollHeight)
  }, [children])

  useEffect(() => {
    const el = innerRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      setNaturalHeight(el.scrollHeight)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Small tolerance so sub-pixel layout differences don't flicker the
  // "Show more" button on and off across re-renders.
  const overflows = naturalHeight > LINK_PREVIEW_BODY_HEIGHT_PX + 1
  const showToggle = overflows || expanded

  const handleToggle = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      toggle()
    },
    [toggle]
  )

  return (
    <>
      <div className={cn("relative overflow-hidden", !expanded && BODY_HEIGHT_CLASS)}>
        <div ref={innerRef}>{children}</div>
        {!expanded && overflows && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent"
          />
        )}
      </div>
      {/* The toggle row is always rendered so the card commits at the same
          height before and after `useLayoutEffect` measures `scrollHeight`.
          Otherwise Virtuoso records the no-toggle height, then sees the row
          pop in (~24px) and emits a deviation correction that shifts every
          subsequent item — visible as snap-back from the bottom and content
          painting behind the composer. When the body fits the clamp and the
          user hasn't expanded, the slot is held open but rendered inert. */}
      <button
        type="button"
        onClick={showToggle ? handleToggle : undefined}
        aria-hidden={showToggle ? undefined : true}
        aria-expanded={showToggle ? expanded : undefined}
        tabIndex={showToggle ? 0 : -1}
        className={cn(
          "flex w-full items-center justify-center gap-1 border-t bg-muted/20 px-3 py-1",
          "text-[11px] font-medium text-muted-foreground transition-colors",
          showToggle ? "hover:bg-muted/40 hover:text-foreground" : "invisible pointer-events-none"
        )}
      >
        {expanded ? (
          <>
            <ChevronsUp className="h-3 w-3" aria-hidden="true" />
            Show less
          </>
        ) : (
          <>
            <ChevronsDown className="h-3 w-3" aria-hidden="true" />
            Show more
          </>
        )}
      </button>
    </>
  )
}
