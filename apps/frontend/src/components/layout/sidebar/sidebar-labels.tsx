import { createContext, useContext, useMemo, type ReactNode } from "react"
import { LabelableResourceTypes } from "@threa/types"
import { useWorkspaceLabels, useWorkspaceLabelAssignments } from "@/stores/workspace-store"
import { LabelGlyph } from "@/components/labels/label-chip"
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

/**
 * Compact label indicator for a stream row: the first label's color dot, with a
 * "+N" when the stream carries more. Sits on the right of the title so a stream
 * reads as labeled even when it's parked in a custom section (away from its
 * label lens). Returns null when the stream has no labels, so it adds nothing to
 * the layout in the common case (INV-21).
 */
export function StreamLabelDots({ streamId }: { streamId: string }) {
  const labels = useStreamLabels(streamId)
  if (labels.length === 0) return null

  const extra = labels.length - 1
  const aria = labels.length === 1 ? `Label: ${labels[0].name}` : `${labels.length} labels`

  return (
    <span className="flex shrink-0 items-center gap-0.5" role="img" aria-label={aria}>
      <LabelGlyph label={labels[0]} className="h-3.5 w-3.5" />
      {extra > 0 && <span className="text-[10px] font-medium leading-none text-muted-foreground">+{extra}</span>}
    </span>
  )
}
