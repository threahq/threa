import { useRef, type ReactNode } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { DEFAULT_MESSAGE_COLLAPSE_THRESHOLD } from "@threa/types"
import { cn } from "@/lib/utils"
import { usePreferencesOptional } from "@/contexts/preferences-context"
import { useBlockCollapse } from "./use-block-collapse"
import { useMeasuredLineCount } from "./use-measured-line-count"
import { InsideCollapsibleBlockProvider, type MarkdownBlockKind } from "./markdown-block-context"

interface CollapsibleBodyProps {
  /** The block-collapse kind — its own `messageId`-scoped fold key + hash space. */
  kind: Extract<MarkdownBlockKind, "description" | "message">
  /** Markdown source: hashes the persisted toggle key and drives remeasure. */
  content: string
  /** Rendered line count above which the body starts folded. */
  threshold: number
  /** The rendered body (a `MarkdownContent`) measured and clamped by line count. */
  children: ReactNode
  /**
   * Tailwind `to-*` color the collapsed fade fades to — match the surface the
   * body sits on (`to-background` in the timeline, `to-card` on a board card),
   * or the gradient shows a band of the wrong color at the fold edge.
   */
  fadeToClassName?: string
}

/**
 * Folds a whole markdown body behind a Show more/less toggle past a rendered
 * line threshold — the same measure-then-clamp mechanism code/quote blocks use,
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
  children,
  fadeToClassName = "to-background",
}: CollapsibleBodyProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const { lineCount, lineHeightPx } = useMeasuredLineCount(bodyRef, [content])
  // The extra half line keeps a barely-over body from sprouting a toggle that
  // hides only a sliver — and is the half line the collapsed view shows as the
  // "there's more" hint. Mirrors the code/quote-block threshold math.
  const collapsible = lineCount !== null && lineCount > threshold + 0.5
  const { collapsed, canToggle, toggle } = useBlockCollapse({ kind, content, collapsible })

  const collapsedMaxHeight = collapsed && lineHeightPx !== null ? (threshold + 0.5) * lineHeightPx : undefined

  return (
    <div className="relative">
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
          style={collapsedMaxHeight !== undefined ? { maxHeight: collapsedMaxHeight } : undefined}
        >
          {children}
        </div>
      </InsideCollapsibleBlockProvider>
      {collapsed && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-b from-transparent",
            fadeToClassName
          )}
        />
      )}
      {canToggle && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className="mt-1 flex cursor-pointer items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          )}
          {collapsed ? "Show more" : "Show less"}
        </button>
      )}
    </div>
  )
}

/**
 * The user's message collapse threshold, falling back to the default when
 * preferences haven't hydrated (or in test contexts with no provider).
 */
export function useMessageCollapseThreshold(): number {
  const preferences = usePreferencesOptional()
  return preferences?.preferences?.messageCollapseThreshold ?? DEFAULT_MESSAGE_COLLAPSE_THRESHOLD
}
