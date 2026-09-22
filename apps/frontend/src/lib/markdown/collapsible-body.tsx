import { useLayoutEffect, useRef, type ReactNode } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"
import {
  DEFAULT_MESSAGE_COLLAPSE_AT_HEIGHT,
  DEFAULT_MESSAGE_COLLAPSE_TO_HEIGHT,
  type UserPreferences,
} from "@threahq/types"
import { cn } from "@/lib/utils"
import { usePreferencesOptional } from "@/contexts/preferences-context"
import { useBlockCollapse } from "./use-block-collapse"
import { useMeasuredLineCount } from "./use-measured-line-count"
import { InsideCollapsibleBlockProvider, MarkdownBlockProvider, type MarkdownBlockKind } from "./markdown-block-context"

interface CollapsibleBodyProps {
  /** The block-collapse kind — its own `messageId`-scoped fold key + hash space. */
  kind: Extract<MarkdownBlockKind, "description" | "message">
  /** Markdown source: hashes the persisted toggle key and drives remeasure. */
  content: string
  /** Rendered line count above which the body can fold. */
  threshold?: number
  /** Rendered height above which the body can fold. */
  collapseAtHeight?: number
  /** Height to clamp to when folded. */
  collapseToHeight?: number
  /** Initial state when no persisted per-message override exists. */
  defaultCollapsed?: boolean
  /** The rendered body (a `MarkdownContent`) measured and clamped when folded. */
  children: ReactNode
  /**
   * Rendered under the body and folded with it (attachments, link previews), so
   * a folded message hides them instead of leaving them below the fade. Kept out
   * of the message's block scope: markdown inside a preview never gets fold
   * chrome keyed to the host message.
   */
  trailing?: ReactNode
}

// The collapsed body fades out its own bottom edge via a mask (the content goes
// transparent), NOT a colored overlay gradient. A colored gradient has to match
// the surface it sits on — and a timeline message sits on the actor accent tint,
// a board card on `bg-card`, etc. — so any fixed target color shows a
// wrong-colored band on some surface. Masking the content is surface-agnostic:
// whatever is behind shows through, so it's correct everywhere. ~1.5rem of fade
// at the very bottom, matching the half-line the clamp leaves as the "more" hint.
const COLLAPSED_FADE_MASK = "linear-gradient(to bottom, black calc(100% - 1.5rem), transparent)"

/**
 * Folds a whole markdown body behind a Show more/less toggle past a rendered
 * size threshold — the same measure-then-clamp mechanism code/quote blocks use,
 * persisted per message via the shared block-collapse cache so it survives the
 * timeline remounting rows under virtualization. Must be mounted inside a
 * `MarkdownBlockProvider` (the caller supplies the `messageId` scope); when this
 * body is an active fold it marks its subtree inside-a-collapsible so nested
 * code/quote blocks skip their own chrome and the whole body folds as one unit.
 */
export function CollapsibleBody({
  kind,
  content,
  threshold,
  collapseAtHeight,
  collapseToHeight,
  defaultCollapsed = true,
  children,
  trailing,
}: CollapsibleBodyProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const { lineCount, lineHeightPx, heightPx } = useMeasuredLineCount(bodyRef, [content])
  const lineCollapsible = threshold !== undefined && lineCount !== null && lineCount > threshold + 0.5
  const heightCollapsible =
    collapseAtHeight !== undefined && heightPx !== null && heightPx !== undefined && heightPx > collapseAtHeight
  const collapsible = heightCollapsible || lineCollapsible
  const { collapsed, canToggle, toggle } = useBlockCollapse({ kind, content, collapsible, defaultCollapsed })

  const collapsedMaxHeight = collapsed
    ? (collapseToHeight ??
      (threshold !== undefined && lineHeightPx !== null ? (threshold + 0.5) * lineHeightPx : undefined))
    : undefined

  const trailingRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const body = bodyRef.current
    const trailingRoot = trailingRef.current
    if (collapsedMaxHeight === undefined || !body || !trailingRoot) return
    let hidden: Element[] = []
    const release = () => {
      for (const el of hidden) el.removeAttribute("inert")
      hidden = []
    }
    // Controls clipped below the clamp stay out of the tab order; anything
    // straddling the edge is partly visible and keeps its focusable parts.
    const markClipped = () => {
      release()
      const clampBottom = body.getBoundingClientRect().top + collapsedMaxHeight
      const visit = (el: Element) => {
        const rect = el.getBoundingClientRect()
        if (rect.top >= clampBottom) {
          el.setAttribute("inert", "")
          hidden.push(el)
        } else if (rect.bottom > clampBottom) {
          for (const child of el.children) visit(child)
        }
      }
      visit(trailingRoot)
    }
    markClipped()
    const observer = new ResizeObserver(markClipped)
    observer.observe(trailingRoot)
    return () => {
      observer.disconnect()
      release()
    }
  }, [collapsedMaxHeight, heightPx])

  return (
    <div>
      <InsideCollapsibleBlockProvider active={canToggle}>
        {/* Expansion lives only on the explicit Show more/less button below — the
            body itself is NOT click-to-toggle. A message body carries clickable
            mentions/links (their onClick would double-fire with the fold) and, on
            touch, receives the row's long-press → a synthetic post-press click
            would toggle the fold. The button is always rendered when foldable, so
            nothing is stranded. (CodeBlock keeps body-tap because code has neither
            hazard and defers long-press via data-native-context.) */}
        <div
          ref={bodyRef}
          className={cn(collapsed && "overflow-hidden")}
          style={
            collapsed
              ? { maxHeight: collapsedMaxHeight, maskImage: COLLAPSED_FADE_MASK, WebkitMaskImage: COLLAPSED_FADE_MASK }
              : undefined
          }
        >
          {children}
          {trailing && (
            <div ref={trailingRef}>
              <MarkdownBlockProvider messageId={null}>{trailing}</MarkdownBlockProvider>
            </div>
          )}
        </div>
      </InsideCollapsibleBlockProvider>
      {canToggle && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          // When collapsed, lift the toggle up into the faded bottom band (the
          // clamp's half-line teaser + the mask fade read as empty space) so it
          // sits centered in that spacer rather than pinned below it. Expanded,
          // there is no fade — keep normal spacing under the full body.
          className={cn(
            "flex cursor-pointer items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground",
            collapsed ? "-mt-2" : "mt-1"
          )}
        >
          {collapsed ? (
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronUp className="h-3 w-3 shrink-0" aria-hidden="true" />
          )}
          {collapsed ? "Show more" : "Collapse"}
        </button>
      )}
    </div>
  )
}

export interface MessageCollapseSettings {
  enabled: boolean
  collapseAtHeight: number
  collapseToHeight: number
}

export function resolveMessageCollapseSettings(preferences?: UserPreferences | null): MessageCollapseSettings {
  const collapseAtHeight = preferences?.messageCollapseAtHeight ?? DEFAULT_MESSAGE_COLLAPSE_AT_HEIGHT
  const collapseToHeight = preferences?.messageCollapseToHeight ?? DEFAULT_MESSAGE_COLLAPSE_TO_HEIGHT
  return {
    enabled: preferences?.messageCollapseEnabled ?? false,
    collapseAtHeight,
    collapseToHeight: Math.min(collapseToHeight, collapseAtHeight),
  }
}

export function useMessageCollapseSettings(): MessageCollapseSettings {
  const preferences = usePreferencesOptional()
  return resolveMessageCollapseSettings(preferences?.preferences)
}
