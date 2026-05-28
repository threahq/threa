import { useMemo, useState } from "react"
import { Check, Search, Tag } from "lucide-react"
import { Link } from "react-router-dom"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { useIsMobile } from "@/hooks/use-mobile"
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
 * Touch-native list for the mobile drawer. cmdk's keyboard-driven selection
 * model gives no press feedback on tap and pops the on-screen keyboard via its
 * auto-focused input, which feels dead and cramped inside a bottom sheet. Here
 * each row is a real button with an `active:` press state and a generous tap
 * target (matches `SidebarActionDrawerEntry`), and the search input never
 * auto-focuses so opening the sheet doesn't raise the keyboard.
 */
function MobileLabelList({
  workspaceId,
  labels,
  checkedIds,
  disabled,
  onToggle,
}: {
  workspaceId: string
  labels: CachedLabel[]
  checkedIds: Set<string>
  disabled: boolean
  onToggle: (label: CachedLabel) => void
}) {
  const [query, setQuery] = useState("")
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? labels.filter((label) => label.name.toLowerCase().includes(q)) : labels
  }, [labels, query])

  if (labels.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <NoLabelsYet workspaceId={workspaceId} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search labels…"
          aria-label="Search labels"
          // text-base keeps the font ≥16px so iOS doesn't zoom on focus.
          className="w-full bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">No labels found.</p>
        ) : (
          filtered.map((label) => {
            const checked = checkedIds.has(label.id)
            return (
              <button
                key={label.id}
                type="button"
                aria-pressed={checked}
                disabled={disabled}
                onClick={() => onToggle(label)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm transition-colors",
                  "active:bg-muted disabled:pointer-events-none disabled:opacity-50",
                  checked && "bg-muted/50"
                )}
              >
                <LabelGlyph label={label} />
                <span className="min-w-0 flex-1 truncate">{label.name}</span>
                <Check
                  className={cn(
                    "h-[18px] w-[18px] shrink-0 text-primary transition-all duration-150",
                    checked ? "scale-100 opacity-100" : "scale-50 opacity-0"
                  )}
                />
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

/**
 * Apply or remove labels on a single resource. A multi-select toggle list:
 * selecting a row flips its assignment and keeps the surface open so several
 * labels can be set in one pass. Renders as a centered dialog with a cmdk
 * command list on desktop and a touch-native list in a bottom drawer on mobile
 * (ResponsiveDialog). The catalog is the viewer's usable labels
 * (`useLabelsView().myLabels`). The checkmark reflects the viewer's own
 * attribution (`myLabelIds`): toggling adds or removes *my* row in the shared
 * pool, never anyone else's.
 */
export function LabelPicker({ workspaceId, resourceType, resourceId, open, onOpenChange }: LabelPickerProps) {
  const isMobile = useIsMobile()
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

        {isMobile ? (
          <MobileLabelList
            workspaceId={workspaceId}
            labels={myLabels}
            checkedIds={myLabelIds}
            disabled={!isOnline}
            onToggle={toggle}
          />
        ) : (
          <Command>
            <CommandInput placeholder="Search labels…" />
            <CommandList className="max-h-[min(60vh,360px)] overscroll-contain">
              <CommandEmpty>
                {myLabels.length === 0 ? <NoLabelsYet workspaceId={workspaceId} /> : "No labels found."}
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
