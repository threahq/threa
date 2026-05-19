import { useMemo, useRef, type ReactNode } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD } from "@threa/types"
import { cn } from "@/lib/utils"
import { usePreferencesOptional } from "@/contexts/preferences-context"
import { useBlockCollapse } from "./use-block-collapse"
import { useMeasuredLineCount } from "./use-measured-line-count"
import {
  InsideCollapsibleBlockProvider,
  useIsInsideCollapsibleBlock,
  useMarkdownBlockContext,
} from "./markdown-block-context"
import { extractBlockText } from "./extract-block-text"

interface BlockquoteBlockProps {
  children: ReactNode
}

export function BlockquoteBlock({ children }: BlockquoteBlockProps) {
  const text = useMemo(() => extractBlockText(children), [children])

  const preferencesContext = usePreferencesOptional()
  const threshold =
    preferencesContext?.preferences?.blockquoteCollapseThreshold ?? DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD

  const messageContext = useMarkdownBlockContext()
  const nested = useIsInsideCollapsibleBlock()
  // Whether folding is even possible here is a synchronous fact (is there a
  // message to persist against, and are we the outermost block?). Branching
  // the DOM on this — not on the async measurement — keeps the measured node
  // at a stable position so it isn't remounted when it flips to collapsible.
  const foldable = Boolean(messageContext) && !nested

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const measured = useMeasuredLineCount(bodyRef, [text])
  const lineCount = measured.lineCount
  // Same "more than threshold" semantic as before, but measured by rendered
  // line-height (handles soft wrapping) instead of paragraph/char estimates.
  // The extra half line is exactly what the collapsed view reveals as the
  // "there's more" hint, so a barely-over quote never gets a useless toggle.
  const collapsible = foldable && lineCount !== null && lineCount > threshold + 0.5
  const displayLineCount = lineCount !== null ? Math.max(1, Math.round(lineCount)) : 0

  const { collapsed, canToggle, toggle } = useBlockCollapse({
    kind: "blockquote",
    content: text,
    collapsible,
  })

  // Rendered without a message context or nested inside another foldable
  // block: a plain bordered quote. Nothing to persist to, and the fold chrome
  // would be dead UI. This branch is measurement-independent so it never
  // swaps with the foldable structure mid-life.
  if (!foldable) {
    return (
      <blockquote className="my-2 border-l-2 border-primary/50 pl-4 text-muted-foreground italic">
        {children}
      </blockquote>
    )
  }

  const collapsedMaxHeight =
    collapsed && measured.lineHeightPx !== null ? (threshold + 0.5) * measured.lineHeightPx : undefined
  const toggleLabel = collapsed
    ? `Expand ${displayLineCount} line${displayLineCount === 1 ? "" : "s"}`
    : "Collapse block quote"
  const bodyExpandable = collapsed && canToggle

  return (
    <InsideCollapsibleBlockProvider active={canToggle}>
      <blockquote
        className={cn(
          "my-2 border-l-2 border-primary/50",
          canToggle ? "rounded-r-md bg-muted/20" : "pl-4 text-muted-foreground italic"
        )}
      >
        {canToggle ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={toggleLabel}
            title={toggleLabel}
            className="flex w-full cursor-pointer items-center gap-1 px-3 py-1 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            {collapsed ? (
              <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
            )}
            <span className="shrink-0">Quote</span>
            {collapsed && (
              <span className="text-muted-foreground/80 font-normal shrink-0">
                — {displayLineCount} line{displayLineCount === 1 ? "" : "s"}, click to expand
              </span>
            )}
          </button>
        ) : null}
        <div className={cn("relative", canToggle && "px-4 pb-2 text-muted-foreground italic")}>
          <div
            ref={bodyRef}
            className={cn(collapsed && "overflow-hidden", bodyExpandable && "cursor-pointer")}
            style={collapsedMaxHeight !== undefined ? { maxHeight: collapsedMaxHeight } : undefined}
            onClick={bodyExpandable ? toggle : undefined}
          >
            {children}
          </div>
          {collapsed && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-b from-transparent to-muted/20"
            />
          )}
        </div>
      </blockquote>
    </InsideCollapsibleBlockProvider>
  )
}
