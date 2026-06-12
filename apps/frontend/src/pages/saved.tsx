import { Navigate, useParams, Link } from "react-router-dom"
import { ArrowLeft, Bookmark } from "lucide-react"
import { toast } from "sonner"
import { SAVED_STATUSES } from "@threa/types"
import { buttonVariants } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { useSavedList, useUpdateSaved, useDeleteSaved } from "@/hooks"
import { SavedItem } from "@/components/saved/saved-item"
import { SavedEmpty } from "@/components/saved/saved-empty"
import { SavedSkeleton } from "@/components/saved/saved-skeleton"
import { SidebarToggle } from "@/components/layout"
import type { SavedStatus } from "@threa/types"

const TABS: { value: SavedStatus; label: string }[] = [
  { value: "saved", label: "Saved" },
  { value: "done", label: "Done" },
  { value: "archived", label: "Archived" },
]

const VALID_TABS = new Set<string>(SAVED_STATUSES)

/**
 * Route is `/w/:workspaceId/saved/:tab?` — bare `/saved` renders the default
 * Saved tab, `/saved/done` and `/saved/archived` render the other two.
 * Refreshes, back/forward, and shared links all land on the same view
 * (INV-59). Unknown tab segments redirect to the default so typos don't
 * render a blank page.
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

  const tab: SavedStatus = (tabParam as SavedStatus | undefined) ?? "saved"

  return <SavedPageInner workspaceId={workspaceId} tab={tab} />
}

interface InnerProps {
  workspaceId: string
  tab: SavedStatus
}

/**
 * Tab strip shared by the routed page and the side-panel rendering. Tabs are
 * navigation — rendered as <a> so cmd-click / context menu work (INV-40); the
 * caller supplies hrefs (route segments on the page, panel URLs in a panel)
 * so the view stays URL-driven in both surfaces (INV-59).
 */
export function SavedTabs({ value, tabHref }: { value: SavedStatus; tabHref: (next: SavedStatus) => string }) {
  return (
    <Tabs value={value}>
      <TabsList className="h-8">
        {TABS.map((t) => (
          <TabsTrigger key={t.value} value={t.value} asChild>
            <Link to={tabHref(t.value)} className="text-xs px-2.5 py-1">
              {t.label}
            </Link>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}

/** The saved-items list for one tab — shared by the page and the side panel. */
export function SavedList({ workspaceId, tab }: InnerProps) {
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

function SavedPageInner({ workspaceId, tab }: InnerProps) {
  const tabHref = (next: SavedStatus) =>
    next === "saved" ? `/w/${workspaceId}/saved` : `/w/${workspaceId}/saved/${next}`

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 items-center justify-between border-b px-4 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <SidebarToggle location="page" />
          <Link
            to={`/w/${workspaceId}`}
            className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8 shrink-0")}
            aria-label="Back to workspace"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex items-center gap-2 min-w-0">
            <Bookmark className="h-5 w-5 text-muted-foreground shrink-0" />
            <h1 className="font-semibold truncate">Saved</h1>
          </div>
        </div>

        <SavedTabs value={tab} tabHref={tabHref} />
      </header>

      <ScrollArea className="flex-1 [&>div>div]:!block [&>div>div]:!w-full">
        <main className="py-1">
          <SavedList workspaceId={workspaceId} tab={tab} />
        </main>
      </ScrollArea>
    </div>
  )
}
