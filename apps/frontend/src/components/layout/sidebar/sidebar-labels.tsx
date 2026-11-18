import { createContext, useContext, useMemo, type ReactNode } from "react"
import { LabelableResourceTypes } from "@threahq/types"
import { useWorkspaceLabels, useWorkspaceLabelAssignments } from "@/stores/workspace-store"
import { LabelGlyphStack } from "@/components/labels/label-chip"
import type { CachedLabel } from "@/hooks"

/**
 * Per-stream label lookup for the sidebar. Built once from the workspace store
 * (labels + assignments) and shared via context so each row reads its labels
 * with a single map lookup instead of its own `useResourceLabelAssignments`
 * hook — one derivation for the whole list rather than one per row.
 */
const EMPTY: CachedLabel[] = []
const SidebarLabelsContext = createContext<Map<string, CachedLabel[]>>(new Map())

export function SidebarLabelsProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const labels = useWorkspaceLabels(workspaceId)
  const assignments = useWorkspaceLabelAssignments(workspaceId)

  const byStreamId = useMemo(() => {
    const labelById = new Map<string, CachedLabel>()
    for (const label of labels) if (!label.archivedAt) labelById.set(label.id, label)

    const map = new Map<string, CachedLabel[]>()
    for (const assignment of assignments) {
      if (assignment.resourceType !== LabelableResourceTypes.STREAM) continue
      const label = labelById.get(assignment.labelId)
      if (!label) continue
      const list = map.get(assignment.resourceId)
      if (list) {
        if (!list.some((existing) => existing.id === label.id)) list.push(label)
      } else {
        map.set(assignment.resourceId, [label])
      }
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name))
    return map
  }, [labels, assignments])

  return <SidebarLabelsContext.Provider value={byStreamId}>{children}</SidebarLabelsContext.Provider>
}

/** Active labels applied to a stream, sorted by name. Empty array when none. */
export function useStreamLabels(streamId: string): CachedLabel[] {
  return useContext(SidebarLabelsContext).get(streamId) ?? EMPTY
}

const STACK_LIMIT = 3

/**
 * Label indicator for a stream row: up to three label glyphs stacked like the
 * top bar's, with a corner count for the rest. The stack is right-aligned, so
 * rows line up on one column however many labels they carry. No hover fan —
 * hovering the row swaps the labels for its actions. Returns null when the
 * stream has no labels.
 */
export function StreamLabelDots({ streamId }: { streamId: string }) {
  const labels = useStreamLabels(streamId)
  if (labels.length === 0) return null

  const shown = labels.slice(0, STACK_LIMIT)
  const extra = labels.length - shown.length
  const aria = labels.length === 1 ? `Label: ${labels[0].name}` : `${labels.length} labels`

  return (
    <span className="relative flex shrink-0 items-center" role="img" aria-label={aria}>
      <LabelGlyphStack labels={shown} size="sm" />
      {extra > 0 && (
        <span className="absolute -right-1.5 -top-1.5 h-3 min-w-3 rounded-full bg-muted-foreground px-0.5 text-center text-[8px] font-semibold leading-3 text-background">
          +{extra}
        </span>
      )}
    </span>
  )
}
