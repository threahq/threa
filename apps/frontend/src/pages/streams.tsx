import { useMemo, useState } from "react"
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Archive, Compass, Lock, Search } from "lucide-react"
import { toast } from "sonner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PageHeaderTabs } from "@/components/layout"
import { useStreamService } from "@/contexts"
import { useJoinStream } from "@/hooks"
import {
  useWorkspaceDmPeers,
  useWorkspaceStreamIndex,
  useWorkspaceStreamMemberships,
  useWorkspaceStreams,
  useWorkspaceUsers,
} from "@/stores/workspace-store"
import { STREAM_ICONS, getStreamTypeLabel, resolveDmDisplayName, streamLabel } from "@/lib/streams"
import { formatRelativeTime } from "@/lib/dates"
import { cn } from "@/lib/utils"
import { getActivityTime } from "@/components/layout/sidebar/utils"
import {
  DIRECTORY_TABS,
  buildDirectoryRows,
  type DirectoryRow,
  type DirectoryStream,
  type DirectoryTab,
} from "@/components/stream-directory/directory"
import type { Stream } from "@threahq/types"

const TAB_LABELS: Record<DirectoryTab, string> = {
  all: "All",
  channels: "Channels",
  scratchpads: "Scratchpads",
  dms: "DMs",
  threads: "Threads",
}

const VALID_TABS = new Set<string>(DIRECTORY_TABS)

type ListedStream = DirectoryStream & Pick<Stream, "displayName" | "slug">

/**
 * Route is `/w/:workspaceId/streams/:tab?`; bare `/streams` is the All tab and
 * `?archived=1` swaps the list to archived streams, so both survive refresh and
 * shared links (INV-59).
 */
export function StreamsPage() {
  const { workspaceId, tab: tabParam } = useParams<{ workspaceId: string; tab?: string }>()
  const [searchParams] = useSearchParams()

  if (!workspaceId) return null
  if (tabParam === "all" || (tabParam !== undefined && !VALID_TABS.has(tabParam))) {
    return <Navigate to={{ pathname: `/w/${workspaceId}/streams`, search: searchParams.toString() }} replace />
  }

  const tab = (tabParam as DirectoryTab | undefined) ?? "all"
  return <StreamsPageInner workspaceId={workspaceId} tab={tab} archived={searchParams.get("archived") === "1"} />
}

function StreamsPageInner({
  workspaceId,
  tab,
  archived,
}: {
  workspaceId: string
  tab: DirectoryTab
  archived: boolean
}) {
  const [query, setQuery] = useState("")
  const streamService = useStreamService()
  const cachedStreams = useWorkspaceStreams(workspaceId)
  const streamIndex = useWorkspaceStreamIndex(workspaceId)
  const memberships = useWorkspaceStreamMemberships(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const archivedQuery = useQuery({
    queryKey: ["streams", workspaceId, "archived"],
    queryFn: () => streamService.list(workspaceId, { status: ["archived"] }),
    enabled: archived,
    staleTime: 30_000,
  })

  const memberStreamIds = useMemo(() => new Set(memberships.map((m) => m.streamId)), [memberships])
  const streams: readonly ListedStream[] = archived ? (archivedQuery.data ?? []) : cachedStreams

  const rows = useMemo(
    () =>
      buildDirectoryRows({
        streams,
        memberStreamIds,
        tab,
        archived,
        query,
        nameOf: (stream) => resolveDmDisplayName(stream.id, users, dmPeers) ?? streamLabel(stream, "sidebar"),
      }),
    [streams, memberStreamIds, tab, archived, query, users, dmPeers]
  )

  const emptyText = directoryEmptyText({
    failed: archived && archivedQuery.isError,
    loading: archived && archivedQuery.isPending,
    empty: rows.length === 0,
    searching: query.trim() !== "",
  })

  const search = archived ? "?archived=1" : ""
  const tabHref = (next: DirectoryTab) =>
    `${next === "all" ? `/w/${workspaceId}/streams` : `/w/${workspaceId}/streams/${next}`}${search}`
  const archivedHref = `${tab === "all" ? `/w/${workspaceId}/streams` : `/w/${workspaceId}/streams/${tab}`}${archived ? "" : "?archived=1"}`

  return (
    <div className="flex h-full flex-col">
      <PageHeaderTabs
        backTo={`/w/${workspaceId}`}
        icon={Compass}
        title="Streams"
        value={tab}
        tabs={DIRECTORY_TABS.map((value) => ({ value, label: TAB_LABELS[value], href: tabHref(value) }))}
        actions={
          <Link
            to={archivedHref}
            replace
            aria-pressed={archived}
            className={cn(
              buttonVariants({ variant: archived ? "secondary" : "ghost", size: "sm" }),
              "h-8 gap-1.5 text-xs"
            )}
          >
            <Archive className="h-3.5 w-3.5" />
            Archived
          </Link>
        }
      />

      <div className="border-b px-4 py-2">
        <div className="relative mx-auto max-w-3xl">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={archived ? "Search archived" : "Search streams"}
            aria-label="Search streams"
            className="h-9 pl-8"
          />
        </div>
      </div>

      <ScrollArea className="flex-1 [&>div>div]:!block [&>div>div]:!w-full">
        <main className="mx-auto max-w-3xl py-1">
          {emptyText ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">{emptyText}</p>
          ) : (
            <ul>
              {rows.map((row) => (
                <DirectoryItem
                  key={row.stream.id}
                  workspaceId={workspaceId}
                  row={row}
                  parentName={
                    row.stream.rootStreamId ? streamLabelOrNull(streamIndex.get(row.stream.rootStreamId)) : null
                  }
                />
              ))}
            </ul>
          )}
        </main>
      </ScrollArea>
    </div>
  )
}

function directoryEmptyText(state: { failed: boolean; loading: boolean; empty: boolean; searching: boolean }) {
  if (state.failed) return "Could not load archived streams"
  if (state.loading || !state.empty) return null
  return state.searching ? "No streams match" : "Nothing here yet"
}

function streamLabelOrNull(stream: ListedStream | undefined): string | null {
  return stream ? streamLabel(stream, "sidebar") : null
}

function DirectoryItem({
  workspaceId,
  row,
  parentName,
}: {
  workspaceId: string
  row: DirectoryRow<ListedStream>
  parentName: string | null
}) {
  const joinStream = useJoinStream(workspaceId)
  const { stream, name, joinable } = row
  const Icon = STREAM_ICONS[stream.type]
  const lastActive = formatRelativeTime(new Date(getActivityTime(stream)), new Date(), undefined, { terse: true })
  const meta = parentName ? `in ${parentName}` : getStreamTypeLabel(stream.type)

  return (
    <li className="group flex items-center gap-2 px-2">
      <Link
        to={`/w/${workspaceId}/s/${stream.id}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/60"
      >
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{name}</span>
            {stream.visibility === "private" && stream.type === "channel" && (
              <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Private" />
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground">{meta}</div>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{lastActive}</span>
      </Link>
      {joinable && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 text-xs"
          disabled={joinStream.isPending}
          onClick={() => joinStream.mutate(stream.id, { onError: () => toast.error(`Could not join ${name}`) })}
        >
          Join
        </Button>
      )}
    </li>
  )
}
