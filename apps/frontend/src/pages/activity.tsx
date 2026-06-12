import { useMemo } from "react"
import { Navigate, useParams, Link } from "react-router-dom"
import { Bell, ArrowLeft, Check } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { useActivityFeed, useMarkActivityRead, useMarkAllActivityRead, useActors } from "@/hooks"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { useActivityCounts } from "@/hooks/use-activity-counts"
import { getStreamName, streamFallbackLabel } from "@/lib/streams"
import { ActivityItem } from "@/components/activity/activity-item"
import { ActivityEmpty } from "@/components/activity/activity-empty"
import { ActivitySkeleton } from "@/components/activity/activity-skeleton"
import { SidebarToggle } from "@/components/layout"
import type { AuthorType, Activity } from "@threa/types"

export type ActivityFilter = "all" | "unread" | "me"

const VALID_FILTERS = new Set<string>(["all", "unread", "me"])

/**
 * Route is `/w/:workspaceId/activity/:filter?` — bare `/activity` renders the
 * default "all" filter, `/activity/unread` and `/activity/me` render the other
 * two. Refreshes, back/forward, and shared links all land on the same view
 * (INV-59). Unknown filter segments redirect to the default.
 */
export function ActivityPage() {
  const { workspaceId, filter: filterParam } = useParams<{ workspaceId: string; filter?: string }>()

  if (!workspaceId) return null

  if (filterParam === "all") {
    return <Navigate to={`/w/${workspaceId}/activity`} replace />
  }
  if (filterParam !== undefined && !VALID_FILTERS.has(filterParam)) {
    return <Navigate to={`/w/${workspaceId}/activity`} replace />
  }

  const filter: ActivityFilter = (filterParam as ActivityFilter | undefined) ?? "all"

  return <ActivityPageInner workspaceId={workspaceId} filter={filter} />
}

interface InnerProps {
  workspaceId: string
  filter: ActivityFilter
}

/**
 * Filter tab strip shared by the routed page and the side-panel rendering.
 * Tabs are links, not buttons (INV-40); the caller supplies hrefs (route
 * segments on the page, panel URLs in a panel) so the view stays URL-driven
 * in both surfaces (INV-59).
 */
export function ActivityTabs({
  value,
  filterHref,
}: {
  value: ActivityFilter
  filterHref: (next: ActivityFilter) => string
}) {
  return (
    <Tabs value={value}>
      <TabsList className="h-8">
        <TabsTrigger value="all" asChild>
          <Link to={filterHref("all")} className="text-xs px-2.5 py-1">
            All
          </Link>
        </TabsTrigger>
        <TabsTrigger value="unread" asChild>
          <Link to={filterHref("unread")} className="text-xs px-2.5 py-1">
            Unread
          </Link>
        </TabsTrigger>
        <TabsTrigger value="me" asChild>
          <Link to={filterHref("me")} className="text-xs px-2.5 py-1">
            Me
          </Link>
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

/** "Mark all read" affordance — shared by the page header and the panel. */
export function MarkAllActivityReadButton({ workspaceId }: { workspaceId: string }) {
  const markAllRead = useMarkAllActivityRead(workspaceId)
  const { unreadActivityCount } = useActivityCounts(workspaceId)

  if (unreadActivityCount === 0) return null
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => markAllRead.mutate()}
      disabled={markAllRead.isPending}
      className="text-xs gap-1.5 max-sm:h-8 max-sm:w-8 max-sm:p-0"
      title="Mark all read"
    >
      <Check className="h-3.5 w-3.5" />
      <span className="max-sm:hidden">Mark all read</span>
    </Button>
  )
}

/** The activity feed list for one filter — shared by the page and the side panel. */
export function ActivityList({ workspaceId, filter }: InnerProps) {
  const { data: activities, isLoading } = useActivityFeed(workspaceId, {
    unreadOnly: filter === "unread",
    mineOnly: filter === "me",
    othersOnly: filter === "all",
  })
  const markRead = useMarkActivityRead(workspaceId)
  const { getActorName, getActorAvatar } = useActors(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const idbStreams = useWorkspaceStreams(workspaceId)

  const streamById = useMemo(() => {
    return new Map(idbStreams.map((s) => [s.id, s]))
  }, [idbStreams])

  function resolveActivityStreamName(activity: Activity): string {
    const stream = streamById.get(activity.streamId)

    if (stream) {
      const name = getStreamName(stream)
      if (name) return name

      // Unnamed thread → show parent context
      if (stream.type === "thread" && stream.rootStreamId) {
        const root = streamById.get(stream.rootStreamId)
        const rootName = root ? getStreamName(root) : null
        if (rootName) return `a thread in ${rootName}`
      }

      return streamFallbackLabel(stream.type, "activity")
    }

    // Stream not in bootstrap — fall back to activity context snapshot
    const ctx = activity.context as {
      parentStreamName?: string
      streamName?: string
      rootStreamId?: string
    }

    if (ctx.parentStreamName) return `a thread in ${ctx.parentStreamName}`
    if (ctx.rootStreamId) {
      const root = streamById.get(ctx.rootStreamId)
      const rootName = root ? getStreamName(root) : null
      if (rootName) return `a thread in ${rootName}`
    }

    if (ctx.streamName && ctx.streamName !== "Untitled") return ctx.streamName
    return streamFallbackLabel("thread", "activity")
  }

  if (isLoading) return <ActivitySkeleton />
  if (!activities?.length) return <ActivityEmpty isFiltered={filter !== "all"} />
  return (
    <div className="flex flex-col gap-0.5">
      {activities.map((activity) => (
        <ActivityItem
          key={activity.id}
          activity={activity}
          actorName={getActorName(activity.actorId, activity.actorType as AuthorType)}
          actorAvatar={getActorAvatar(activity.actorId, activity.actorType as AuthorType)}
          streamName={resolveActivityStreamName(activity)}
          workspaceId={workspaceId}
          toEmoji={toEmoji}
          onMarkAsRead={(id) => markRead.mutate(id)}
        />
      ))}
    </div>
  )
}

function ActivityPageInner({ workspaceId, filter }: InnerProps) {
  const filterHref = (next: ActivityFilter) =>
    next === "all" ? `/w/${workspaceId}/activity` : `/w/${workspaceId}/activity/${next}`

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
            <Bell className="h-5 w-5 text-muted-foreground shrink-0" />
            <h1 className="font-semibold truncate">Activity</h1>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <ActivityTabs value={filter} filterHref={filterHref} />
          <MarkAllActivityReadButton workspaceId={workspaceId} />
        </div>
      </header>

      <ScrollArea className="flex-1 [&>div>div]:!block [&>div>div]:!w-full">
        <main className="py-2">
          <ActivityList workspaceId={workspaceId} filter={filter} />
        </main>
      </ScrollArea>
    </div>
  )
}
