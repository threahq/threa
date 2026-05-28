import { useMemo, useState } from "react"
import { Search, Tag } from "lucide-react"
import { Link } from "react-router-dom"
import { Checkbox } from "@/components/ui/checkbox"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { useIsOnline } from "@/components/layout/connection-status"
import { cn } from "@/lib/utils"
import { hexToRgba } from "@/lib/labels"
import { useAssignLabel, useLabelsView, useResourceLabelAssignments, useUnassignLabel, type CachedLabel } from "@/hooks"
import type { LabelableResourceType } from "@threa/types"

interface LabelPickerProps {
  workspaceId: string
  /**
   * What kind of thing is being labeled. The picker is resource-generic — this
   * and `resourceId` are the only per-resource inputs; everything else (catalog,
   * toggle, persistence) is identical for every labelable surface.
   */
  resourceType: LabelableResourceType
  resourceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

function LabelGlyph({ label }: { label: CachedLabel }) {
  return (
    <span
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs leading-none"
      style={{ backgroundColor: hexToRgba(label.color, 0.15), color: label.color }}
      aria-hidden
    >
      {label.emoji ?? <Tag className="h-3 w-3" />}
    </span>
  )
}

function NoLabelsYet({ workspaceId }: { workspaceId: string }) {
  return (
    <span className="text-sm text-muted-foreground">
      No labels yet.{" "}
      <Link to={`/w/${workspaceId}/labels`} className="font-medium text-foreground underline">
        Create one
      </Link>
    </span>
  )
}

/**
 * One catalog row. A checked box means *I* applied this label; unchecking it
 * removes my attribution from the shared pool. The checkbox is the control and
 * the adjacent label (linked by `htmlFor`) extends the hit area across the
 * whole row, so the same markup feels right with a mouse or a thumb.
 */
function LabelRow({
  label,
  checked,
  disabled,
  onToggle,
}: {
  label: CachedLabel
  checked: boolean
  disabled: boolean
  onToggle: (label: CachedLabel) => void
}) {
  const id = `label-option-${label.id}`
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg px-2 transition-colors",
        disabled ? "opacity-50" : "hover:bg-muted/50 active:bg-muted"
      )}
    >
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={() => onToggle(label)} />
      <label
        htmlFor={id}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 py-2.5 text-sm",
          disabled ? "cursor-not-allowed" : "cursor-pointer"
        )}
      >
        <LabelGlyph label={label} />
        <span className="min-w-0 flex-1 truncate">{label.name}</span>
      </label>
    </div>
  )
}

/**
 * Apply or remove labels on a single resource. A checkbox list: ticking a row
 * applies the label, unticking it removes the viewer's attribution — toggling
 * adds or removes *my* row in the shared pool, never anyone else's. The list
 * stays open so several labels can be set in one pass. Renders as a centered
 * dialog on desktop and a bottom drawer on mobile (ResponsiveDialog); the rows
 * are identical on both. The catalog is the viewer's usable labels
 * (`useLabelsView().myLabels`) and the checked state reflects the viewer's own
 * attribution (`myLabelIds`).
 */
export function LabelPicker({ workspaceId, resourceType, resourceId, open, onOpenChange }: LabelPickerProps) {
  const isOnline = useIsOnline()
  const { myLabels } = useLabelsView(workspaceId)
  const { myLabelIds } = useResourceLabelAssignments(workspaceId, resourceType, resourceId)
  const assign = useAssignLabel(workspaceId)
  const unassign = useUnassignLabel(workspaceId)
  const [query, setQuery] = useState("")

  const toggle = (label: CachedLabel) => {
    if (myLabelIds.has(label.id)) {
      unassign.mutate({ labelId: label.id, resourceType, resourceId })
    } else {
      assign.mutate({ labelId: label.id, resourceType, resourceId })
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? myLabels.filter((label) => label.name.toLowerCase().includes(q)) : myLabels
  }, [myLabels, query])

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} disableSnapPoints>
      <ResponsiveDialogContent
        desktopClassName="sm:max-w-sm gap-0 p-0"
        drawerClassName="flex max-h-[80dvh] flex-col gap-0 pb-[env(safe-area-inset-bottom)]"
      >
        <ResponsiveDialogHeader className="border-b px-4 py-3 text-left">
          <ResponsiveDialogTitle className="text-base">Labels</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            Apply or remove labels for this {resourceType}.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {myLabels.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <NoLabelsYet workspaceId={workspaceId} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b px-4 py-2.5">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search labels…"
                aria-label="Search labels"
                // text-base keeps the font ≥16px so iOS doesn't zoom on focus; the
                // drawer never auto-focuses it, so opening the sheet stays keyboard-free.
                className="w-full bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
              />
            </div>
            <div className="max-h-[min(60vh,360px)] min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
              {filtered.length === 0 ? (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">No labels found.</p>
              ) : (
                filtered.map((label) => (
                  <LabelRow
                    key={label.id}
                    label={label}
                    checked={myLabelIds.has(label.id)}
                    disabled={!isOnline}
                    onToggle={toggle}
                  />
                ))
              )}
            </div>
          </div>
        )}

        {!isOnline && (
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            You're offline. Labels need a live connection.
          </p>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
