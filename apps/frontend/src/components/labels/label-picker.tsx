import { Check, Tag } from "lucide-react"
import { Link } from "react-router-dom"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
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

/**
 * Apply or remove labels on a single resource. A multi-select toggle list:
 * selecting a row flips its assignment and keeps the surface open so several
 * labels can be set in one pass. Renders as a centered dialog on desktop and a
 * bottom drawer on mobile (ResponsiveDialog). The catalog is the viewer's usable
 * labels (`useLabelsView().myLabels`). The checkmark reflects the viewer's own
 * attribution (`myLabelIds`): toggling adds or removes *my* row in the shared
 * pool, never anyone else's.
 */
export function LabelPicker({ workspaceId, resourceType, resourceId, open, onOpenChange }: LabelPickerProps) {
  const isOnline = useIsOnline()
  const { myLabels } = useLabelsView(workspaceId)
  const { myLabelIds } = useResourceLabelAssignments(workspaceId, resourceType, resourceId)
  const assign = useAssignLabel(workspaceId)
  const unassign = useUnassignLabel(workspaceId)

  const toggle = (label: CachedLabel) => {
    if (myLabelIds.has(label.id)) {
      unassign.mutate({ labelId: label.id, resourceType, resourceId })
    } else {
      assign.mutate({ labelId: label.id, resourceType, resourceId })
    }
  }

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

        <Command>
          <CommandInput placeholder="Search labels…" />
          <CommandList className="max-h-[min(60vh,360px)] overscroll-contain">
            <CommandEmpty>
              {myLabels.length === 0 ? (
                <span className="text-sm text-muted-foreground">
                  No labels yet.{" "}
                  <Link to={`/w/${workspaceId}/labels`} className="font-medium text-foreground underline">
                    Create one
                  </Link>
                </span>
              ) : (
                "No labels found."
              )}
            </CommandEmpty>
            {myLabels.length > 0 && (
              <CommandGroup>
                {myLabels.map((label) => {
                  const checked = myLabelIds.has(label.id)
                  return (
                    <CommandItem
                      key={label.id}
                      value={label.id}
                      keywords={[label.name]}
                      disabled={!isOnline}
                      onSelect={() => toggle(label)}
                      className="gap-2.5"
                    >
                      <LabelGlyph label={label} />
                      <span className="min-w-0 flex-1 truncate">{label.name}</span>
                      <Check className={cn("h-4 w-4 shrink-0", checked ? "opacity-100" : "opacity-0")} />
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>

        {!isOnline && (
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            You're offline. Labels need a live connection.
          </p>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
