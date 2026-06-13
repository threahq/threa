import { Navigate, useParams } from "react-router-dom"
import { Bookmark } from "lucide-react"
import { toast } from "sonner"
import { SAVED_STATUSES } from "@threa/types"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useSavedList, useUpdateSaved, useDeleteSaved } from "@/hooks"
import { useSuggestedCount } from "@/hooks/use-saved-suggestions"
import { SavedItem } from "@/components/saved/saved-item"
import { SavedEmpty } from "@/components/saved/saved-empty"
import { SavedSkeleton } from "@/components/saved/saved-skeleton"
import { SavedQuickAdd } from "@/components/saved/saved-quick-add"
import { SuggestedTab } from "@/components/saved/suggested-tab"
import { PageHeaderTabs } from "@/components/layout"
import type { SavedStatus } from "@threa/types"

// "suggested" is a view, not a saved status — it reads from a separate data
// source (the quiet collector) but lives as a fourth tab on this page.
type SavedTab = SavedStatus | "suggested"

const TABS: { value: SavedTab; label: string }[] = [
  { value: "saved", label: "Saved" },
  { value: "suggested", label: "Suggested" },
  { value: "done", label: "Done" },
  { value: "archived", label: "Archived" },
]

const VALID_TABS = new Set<string>([...SAVED_STATUSES, "suggested"])

/**
 * Route is `/w/:workspaceId/saved/:tab?` — bare `/saved` renders the default
 * Saved tab; `/saved/suggested`, `/saved/done`, `/saved/archived` render the
 * others. Refreshes, back/forward, and shared links all land on the same view
 * (INV-59). Unknown tab segments redirect to the default so typos don't render
 * a blank page.
 */
export function SavedPage() {
  const { workspaceId, tab: tabParam } = useParams<{ workspaceId: string; tab?: string }>()

  if (!workspaceId) return null

  if (tabParam === "saved") {
    // The default tab uses the unsegmented URL — canonicalise so we don't
    // have two URLs for the same view.
    return <Navigate to={`/w/${workspaceId}/saved`} replace />
  }
  if (tabParam !== undefined && !VALID_TABS.has(tabParam)) {
    return <Navigate to={`/w/${workspaceId}/saved`} replace />
  }

  const tab: SavedTab = (tabParam as SavedTab | undefined) ?? "saved"

  return <SavedPageInner workspaceId={workspaceId} tab={tab} />
}

interface InnerProps {
  workspaceId: string
  tab: SavedTab
}

function SavedPageInner({ workspaceId, tab }: InnerProps) {
  const suggestedCount = useSuggestedCount(workspaceId)

  // Tabs are navigation — rendered as <a> so cmd-click / context menu work
  // (INV-40). The Tabs primitive keeps the active-state styling via `value`.
  const tabHref = (next: SavedTab) => (next === "saved" ? `/w/${workspaceId}/saved` : `/w/${workspaceId}/saved/${next}`)

  return (
    <div className="flex h-full flex-col">
      <PageHeaderTabs
        backTo={`/w/${workspaceId}`}
        icon={Bookmark}
        title="Saved"
        value={tab}
        tabs={TABS.map((t) => ({
          value: t.value,
          label: t.label,
          href: tabHref(t.value),
          badge:
            t.value === "suggested" && suggestedCount > 0 ? (
              <span className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-600 tabular-nums">
                {suggestedCount}
              </span>
            ) : undefined,
        }))}
      />

      <ScrollArea className="flex-1 [&>div>div]:!block [&>div>div]:!w-full">
        <main className="py-1">
          {tab === "suggested" ? (
            <SuggestedTab workspaceId={workspaceId} />
          ) : (
            <>
              {tab === "saved" && <SavedQuickAdd workspaceId={workspaceId} />}
              <SavedList workspaceId={workspaceId} tab={tab} />
            </>
          )}
        </main>
      </ScrollArea>
    </div>
  )
}

/** The saved/done/archived list — split out so the suggested view doesn't run the saved query. */
function SavedList({ workspaceId, tab }: { workspaceId: string; tab: SavedStatus }) {
  const { items, isLoading } = useSavedList(workspaceId, tab)
  const updateMutation = useUpdateSaved(workspaceId)
  const deleteMutation = useDeleteSaved(workspaceId)

  const handleUpdate = (savedId: string, status: SavedStatus, successLabel: string) => {
    updateMutation.mutate(
      { savedId, input: { status } },
      {
        onSuccess: () => toast.success(successLabel),
        onError: () => toast.error("Could not update saved item"),
      }
    )
  }

  const handleDelete = (savedId: string) => {
    deleteMutation.mutate(savedId, {
      onSuccess: () => toast.success("Saved item removed"),
      onError: () => toast.error("Could not remove saved item"),
    })
  }

  if (isLoading) return <SavedSkeleton />
  if (items.length === 0) return <SavedEmpty status={tab} />

  return (
    <div className="flex flex-col">
      {items.map((saved) => (
        <SavedItem
          key={saved.id}
          saved={saved}
          workspaceId={workspaceId}
          onMarkDone={tab === "saved" ? () => handleUpdate(saved.id, "done", "Marked done") : undefined}
          onArchive={tab === "saved" ? () => handleUpdate(saved.id, "archived", "Archived") : undefined}
          onRestore={tab !== "saved" ? () => handleUpdate(saved.id, "saved", "Restored") : undefined}
          onDelete={() => handleDelete(saved.id)}
        />
      ))}
    </div>
  )
}
