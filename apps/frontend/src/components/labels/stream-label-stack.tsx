import { LabelableResourceTypes } from "@threa/types"
import { cn } from "@/lib/utils"
import { useResourceLabelAssignments } from "@/hooks"
import { useIsMobile } from "@/hooks/use-mobile"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { LabelChip, LabelGlyph } from "./label-chip"

/** Collapsed marks shown before the "+N" overflow indicator. */
const VISIBLE_CAP = 3

interface StreamLabelStackProps {
  workspaceId: string
  streamId: string
  className?: string
}

/**
 * Display-only stack of the labels on a stream, for the stream top bar. Shows up
 * to {@link VISIBLE_CAP} overlapping glyphs + a `+N` overflow count; the full set
 * fans out as tinted name-pills on desktop hover (an overlay — no layout shift,
 * INV-21) or in a bottom drawer on mobile tap. Editing lives in `LabelPicker`.
 *
 * Reads the shared assignment pool (public labels on the stream + the viewer's
 * private ones), already deduped + active-only, and stays live via the
 * `label:assigned`/`label:unassigned` socket handlers.
 */
export function StreamLabelStack({ workspaceId, streamId, className }: StreamLabelStackProps) {
  const { labels } = useResourceLabelAssignments(workspaceId, LabelableResourceTypes.STREAM, streamId)
  const isMobile = useIsMobile()

  if (labels.length === 0) return null

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
      // header controls while the padding gives a comfortable tap target.
      className={cn(
        "-m-1 flex items-center rounded-md p-1 transition-colors hover:bg-muted/60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <span className="flex -space-x-1">
        {labels.slice(0, VISIBLE_CAP).map((label) => (
          <LabelGlyph key={label.id} label={label} className="h-4 w-4 ring-1 ring-background" />
        ))}
      </span>
      {overflow > 0 && <span className="ml-1 text-xs font-medium text-muted-foreground">+{overflow}</span>}
    </button>
  )

  const fanOut = (
    <div className="flex max-h-[50dvh] flex-wrap gap-1.5 overflow-y-auto">
      {labels.map((label) => (
        <LabelChip key={label.id} label={label} />
      ))}
    </div>
  )

  if (isMobile) {
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
}
