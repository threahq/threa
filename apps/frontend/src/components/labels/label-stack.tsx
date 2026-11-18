import { memo, type CSSProperties } from "react"
import { Link } from "react-router-dom"
import type { LabelableResourceType } from "@threahq/types"
import { cn } from "@/lib/utils"
import { useResourceLabelAssignments } from "@/hooks"
import { useInputMode } from "@/hooks/use-input-mode"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { LabelChip, LabelGlyphStack, labelFanReach } from "./label-chip"

/** Collapsed marks shown before the "+N" overflow indicator. */
const VISIBLE_CAP = 3

interface LabelStackProps {
  workspaceId: string
  /** What carries the labels — a stream (top bar) or a message (message rows). */
  resourceType: LabelableResourceType
  resourceId: string
  className?: string
}

/**
 * Display-only stack of the labels on a resource (a stream's top bar, a message
 * row). Shows up to {@link VISIBLE_CAP} overlapping glyphs + a `+N` overflow
 * count. Mouse hover spreads the marks like a hand of cards and shows the full
 * set as tinted name-pills in a hover card; a touch tap opens them in a bottom
 * drawer. Both are overlays — no layout shift (INV-21). Editing lives in
 * `LabelPicker`.
 *
 * Resource-generic: `resourceType` + `resourceId` are the only per-resource
 * inputs. Reads the viewer's active assignments (already deduped + active-only)
 * and stays live via the `label:assigned`/`label:unassigned` socket handlers.
 */
export const LabelStack = memo(function LabelStack({
  workspaceId,
  resourceType,
  resourceId,
  className,
}: LabelStackProps) {
  const { labels } = useResourceLabelAssignments(workspaceId, resourceType, resourceId)
  // Drawer-vs-hovercard keys off the active input mode: a finger taps for the
  // drawer, a mouse (even on a touchscreen laptop) hovers for the hovercard.
  const isTouch = useInputMode() === "touch"

  if (labels.length === 0) return null

  const visible = labels.slice(0, VISIBLE_CAP)
  const overflow = labels.length - VISIBLE_CAP
  // Names go in the accessible name (not just the count) so keyboard / screen
  // reader users get the full set — the visual fan-out is hover/tap only.
  const noun = labels.length === 1 ? "label" : "labels"
  const ariaLabel = `${labels.length} ${noun}: ${labels.map((label) => label.name).join(", ")}`
  const trigger = (
    <button
      type="button"
      aria-label={ariaLabel}
      // Negative margin keeps the glyphs visually aligned with neighbouring
      // controls while the padding gives a comfortable tap target. The hover
      // state is the fan itself (`.label-fan`, index.css), so no hover fill.
      className={cn(
        "label-fan -m-1 flex items-center rounded-md p-1",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      style={{ "--label-fan-reach": `${labelFanReach(visible.length, "md")}px` } as CSSProperties}
    >
      <LabelGlyphStack labels={visible} size="md" />
      {overflow > 0 && (
        <span className="label-fan-shift ml-1 text-xs font-medium text-muted-foreground">+{overflow}</span>
      )}
    </button>
  )

  // Each chip links to the label's landing page — the fan-out is both the
  // disclosure of the full set and the way into each label.
  const fanOut = (
    <div className="flex max-h-[50dvh] flex-wrap gap-1.5 overflow-y-auto">
      {labels.map((label) => (
        <Link
          key={label.id}
          to={`/w/${workspaceId}/labels/${label.id}`}
          className="rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <LabelChip label={label} />
        </Link>
      ))}
    </div>
  )

  if (isTouch) {
    return (
      <Drawer>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent className="pb-[env(safe-area-inset-bottom)]">
          <DrawerHeader>
            <DrawerTitle>Labels</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 pb-4">{fanOut}</div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <HoverCard openDelay={100} closeDelay={100}>
      <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
      <HoverCardContent align="start" className="w-auto max-w-xs p-2">
        {fanOut}
      </HoverCardContent>
    </HoverCard>
  )
})
