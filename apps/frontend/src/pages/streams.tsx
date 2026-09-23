import { useEffect, useMemo, useRef, useState } from "react"
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Archive, ArrowDownUp, Check, Compass, Flame, Lock, Search } from "lucide-react"
import { toast } from "sonner"
import {
  ENCRYPTED_MESSAGE_PREVIEW_LABEL,
  type LastMessagePreview,
  type Stream,
  type StreamDirectoryStats,
} from "@threahq/types"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { PageHeaderTabs } from "@/components/layout"
import { ActorAvatar } from "@/components/actor-avatar"
import { UnreadBadge } from "@/components/unread-badge"
import { StreamHoverCard, useSidebarHoverIntent } from "@/components/layout/sidebar/stream-hover-card"
import { getActivityTime, truncateContent } from "@/components/layout/sidebar/utils"
import { useStreamService } from "@/contexts"
import { actorTypeFromId, useActors, useJoinStream } from "@/hooks"
import { useIsMobile } from "@/hooks/use-mobile"
import { useStreamWarmup } from "@/hooks/use-stream-warmup"
import { useFormattedDate } from "@/hooks/use-formatted-date"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import {
  useWorkspaceDmPeers,
  useWorkspaceStreamIndex,
  useWorkspaceStreamMemberships,
  useWorkspaceStreams,
  useWorkspaceUnreadState,
  useWorkspaceUsers,
} from "@/stores/workspace-store"
import { STREAM_ICONS, getStreamTypeLabel, resolveDmDisplayName, streamLabel } from "@/lib/streams"
import { cn } from "@/lib/utils"
import {
  DIRECTORY_MEMBERSHIPS,
  DIRECTORY_SORTS,
  DIRECTORY_TABS,
  buildDirectoryRows,
  pickMostActive,
  type DirectoryMembership,
  type DirectoryRow,
  type DirectorySort,
  type DirectoryTab,
} from "@/components/stream-directory/directory"

const TAB_LABELS: Record<DirectoryTab, string> = {
  all: "All",
  channels: "Channels",
  scratchpads: "Scratchpads",
  dms: "DMs",
  threads: "Threads",
}

const SORT_LABELS: Record<DirectorySort, string> = {
  activity: "Recent activity",
  name: "Name",
  members: "Members",
}

const MEMBERSHIP_LABELS: Record<Exclude<DirectoryMembership, "any">, string> = {
  joined: "Joined",
  "not-joined": "Not joined",
}

const VALID_TABS = new Set<string>(DIRECTORY_TABS)
const MOST_ACTIVE_LIMIT = 4
const EMPTY_STATS: StreamDirectoryStats[] = []

type ListedStream = Stream & { lastMessagePreview?: LastMessagePreview | null }

function parseParam<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/**
 * Route is `/w/:workspaceId/streams/:tab?`; bare `/streams` is the All tab.
 * `?archived=1`, `?sort=` and `?show=` ride in the query, so every view
 * survives refresh and shared links (INV-59).
 */
export function StreamsPage() {
  const { workspaceId, tab: tabParam } = useParams<{ workspaceId: string; tab?: string }>()
  const [searchParams] = useSearchParams()

  if (!workspaceId) return null
  if (tabParam === "all" || (tabParam !== undefined && !VALID_TABS.has(tabParam))) {
    return <Navigate to={{ pathname: `/w/${workspaceId}/streams`, search: searchParams.toString() }} replace />
  }

  const tab = (tabParam as DirectoryTab | undefined) ?? "all"
  return (
    <StreamsPageInner
      workspaceId={workspaceId}
      tab={tab}
      searchParams={searchParams}
      archived={searchParams.get("archived") === "1"}
      sort={parseParam(searchParams.get("sort"), DIRECTORY_SORTS, "activity")}
      membership={parseParam(searchParams.get("show"), DIRECTORY_MEMBERSHIPS, "any")}
    />
  )
}

function StreamsPageInner({
  workspaceId,
  tab,
  searchParams,
  archived,
  sort,
  membership,
}: {
  workspaceId: string
  tab: DirectoryTab
  searchParams: URLSearchParams
  archived: boolean
  sort: DirectorySort
  membership: DirectoryMembership
}) {
  const [query, setQuery] = useState("")
  const streamService = useStreamService()
  const cachedStreams = useWorkspaceStreams(workspaceId)
  const streamIndex = useWorkspaceStreamIndex(workspaceId)
  const memberships = useWorkspaceStreamMemberships(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const unreadCounts = useWorkspaceUnreadState(workspaceId)?.unreadCounts
  const archivedQuery = useQuery({
    queryKey: ["streams", workspaceId, "archived"],
    queryFn: () => streamService.list(workspaceId, { status: ["archived"] }),
    enabled: archived,
    staleTime: 30_000,
  })
  const statsQuery = useQuery({
    queryKey: ["streams", workspaceId, "directory-stats"],
    queryFn: () => streamService.directoryStats(workspaceId),
    enabled: !archived,
    staleTime: 60_000,
  })

  const joinedAtById = useMemo(() => new Map(memberships.map((m) => [m.streamId, m.joinedAt])), [memberships])
  const memberStreamIds = useMemo(() => new Set(joinedAtById.keys()), [joinedAtById])
  const statsById = useMemo(
    () => new Map((statsQuery.data ?? EMPTY_STATS).map((stat) => [stat.streamId, stat])),
    [statsQuery.data]
  )
  const streams: readonly ListedStream[] = archived ? (archivedQuery.data ?? []) : cachedStreams

  const rows = useMemo(
    () =>
      buildDirectoryRows({
        streams,
        memberStreamIds,
        tab,
        archived,
        query,
        membership,
        sort,
        memberCountOf: (id) => statsById.get(id)?.memberCount ?? 0,
        nameOf: (stream) => resolveDmDisplayName(stream.id, users, dmPeers) ?? streamLabel(stream, "sidebar"),
      }),
    [streams, memberStreamIds, tab, archived, query, membership, sort, statsById, users, dmPeers]
  )

  const mostActive = useMemo(
    () =>
      archived || query.trim() !== ""
        ? []
        : pickMostActive(rows, (id) => messageTotal(statsById.get(id)), MOST_ACTIVE_LIMIT),
    [archived, query, rows, statsById]
  )

  const emptyText = directoryEmptyText({
    failed: archived && archivedQuery.isError,
    loading: archived && archivedQuery.isPending,
    empty: rows.length === 0,
    searching: query.trim() !== "" || membership !== "any",
  })

  const pathFor = (next: DirectoryTab) =>
    next === "all" ? `/w/${workspaceId}/streams` : `/w/${workspaceId}/streams/${next}`
  const hrefWith = (patch: Record<string, string | null>, pathname = pathFor(tab)) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key)
      else next.set(key, value)
    }
    const search = next.toString()
    return search ? `${pathname}?${search}` : pathname
  }
  const parentNameOf = (row: DirectoryRow<ListedStream>) =>
    row.stream.rootStreamId ? streamLabelOrNull(streamIndex.get(row.stream.rootStreamId)) : null

  return (
    <div className="flex h-full flex-col">
      <PageHeaderTabs
        backTo={`/w/${workspaceId}`}
        icon={Compass}
        title="Streams"
        value={tab}
        tabs={DIRECTORY_TABS.map((value) => ({ value, label: TAB_LABELS[value], href: hrefWith({}, pathFor(value)) }))}
        actions={
          <Link
            to={hrefWith({ archived: archived ? null : "1" })}
            replace
            aria-pressed={archived}
            aria-label="Archived"
            className={cn(
              buttonVariants({ variant: archived ? "secondary" : "ghost", size: "sm" }),
              "h-8 gap-1.5 text-xs"
            )}
          >
            <Archive className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Archived</span>
          </Link>
        }
      />

      <div className="border-b px-4 py-2">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <div className="relative min-w-0 flex-1">
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
          {(["joined", "not-joined"] as const).map((value) => (
            <Link
              key={value}
              to={hrefWith({ show: membership === value ? null : value })}
              replace
              aria-pressed={membership === value}
              className={cn(
                buttonVariants({ variant: membership === value ? "secondary" : "ghost", size: "sm" }),
                "h-9 shrink-0 px-2.5 text-xs"
              )}
            >
              {MEMBERSHIP_LABELS[value]}
            </Link>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-9 shrink-0 gap-1.5 px-2.5 text-xs" aria-label="Sort">
                <ArrowDownUp className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{SORT_LABELS[sort]}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {DIRECTORY_SORTS.map((value) => (
                <DropdownMenuItem key={value} asChild>
                  <Link to={hrefWith({ sort: value === "activity" ? null : value })} replace>
                    <span className="flex-1">{SORT_LABELS[value]}</span>
                    {value === sort && <Check className="h-3.5 w-3.5" />}
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ScrollArea className="flex-1 [&>div>div]:!block [&>div>div]:!w-full">
        <main className="mx-auto max-w-3xl py-2">
          {mostActive.length > 0 && (
            <section aria-labelledby="most-active-heading" className="px-4 pb-3 pt-1">
              <h2
                id="most-active-heading"
                className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
              >
                <Flame className="h-3.5 w-3.5" />
                Most active
              </h2>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {mostActive.map((row) => (
                  <MostActiveCard
                    key={row.stream.id}
                    workspaceId={workspaceId}
                    row={row}
                    stats={statsById.get(row.stream.id)}
                  />
                ))}
              </ul>
            </section>
          )}
          {emptyText ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">{emptyText}</p>
          ) : (
            <ul>
              {rows.map((row) => (
                <DirectoryItem
                  key={row.stream.id}
                  workspaceId={workspaceId}
                  row={row}
                  parentName={parentNameOf(row)}
                  joinedAt={joinedAtById.get(row.stream.id) ?? null}
                  stats={statsById.get(row.stream.id)}
                  unreadCount={unreadCounts?.[row.stream.id] ?? 0}
                />
              ))}
            </ul>
          )}
        </main>
      </ScrollArea>
    </div>
  )
}

function messageTotal(stats: StreamDirectoryStats | undefined): number {
  return stats ? stats.activity.reduce((sum, count) => sum + count, 0) : 0
}

function messageCountLabel(count: number): string {
  return count === 1 ? "1 message" : `${count} messages`
}

function directoryEmptyText(state: { failed: boolean; loading: boolean; empty: boolean; searching: boolean }) {
  if (state.failed) return "Could not load archived streams"
  if (state.loading || !state.empty) return null
  return state.searching ? "No streams match" : "Nothing here yet"
}

function streamLabelOrNull(stream: ListedStream | undefined): string | null {
  return stream ? streamLabel(stream, "sidebar") : null
}

function MostActiveCard({
  workspaceId,
  row,
  stats,
}: {
  workspaceId: string
  row: DirectoryRow<ListedStream>
  stats: StreamDirectoryStats | undefined
}) {
  const Icon = STREAM_ICONS[row.stream.type]
  const total = messageTotal(stats)
  return (
    <li>
      <Link
        to={`/w/${workspaceId}/s/${row.stream.id}`}
        className="flex h-full flex-col gap-2 rounded-lg border bg-card p-3 transition-colors hover:bg-muted/60"
      >
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{row.name}</span>
        </span>
        {stats && <ActivitySparkline activity={stats.activity} className="h-8 w-full" />}
        <span className="flex items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
          <span>{messageCountLabel(total)}</span>
          {stats && <MemberStack workspaceId={workspaceId} stats={stats} max={3} />}
        </span>
      </Link>
    </li>
  )
}

/** True once the element has scrolled into view; stays true so a row warms once. */
function useSeen(ref: React.RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [seen, setSeen] = useState(false)

  useEffect(() => {
    const element = ref.current
    if (!enabled || seen || !element || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, enabled, seen])

  return seen
}

function DirectoryItem({
  workspaceId,
  row,
  parentName,
  joinedAt,
  stats,
  unreadCount,
}: {
  workspaceId: string
  row: DirectoryRow<ListedStream>
  parentName: string | null
  joinedAt: string | null
  stats: StreamDirectoryStats | undefined
  unreadCount: number
}) {
  const joinStream = useJoinStream(workspaceId)
  const isMobile = useIsMobile()
  const { getActorName } = useActors(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const { formatDate, formatRelative } = useFormattedDate()
  const { stream, name, joinable } = row
  const hoverCardEnabled = !isMobile && !stream.archivedAt
  const hover = useSidebarHoverIntent(hoverCardEnabled)
  const itemRef = useRef<HTMLLIElement>(null)
  const seen = useSeen(itemRef, hoverCardEnabled)
  const warmStreamIds = useMemo(() => (seen ? [stream.id] : []), [seen, stream.id])
  useStreamWarmup(warmStreamIds)
  const Icon = STREAM_ICONS[stream.type]
  const preview = stream.lastMessagePreview
  const lastActive = formatRelative(new Date(getActivityTime(stream)), new Date(), { terse: true })
  const meta = [
    parentName ? `in ${parentName}` : getStreamTypeLabel(stream.type),
    joinedAt ? `Joined ${formatDate(new Date(joinedAt))}` : null,
  ].filter(Boolean)

  let previewText: string | null = null
  if (preview?.content) {
    const body = stream.e2eEnabled ? ENCRYPTED_MESSAGE_PREVIEW_LABEL : truncateContent(preview.content, 140, toEmoji)
    previewText = `${getActorName(preview.authorId, preview.authorType)}: ${body}`
  }

  return (
    <li
      ref={itemRef}
      className="group flex items-center gap-2 px-2"
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
    >
      <StreamHoverCard
        hover={hover}
        workspaceId={workspaceId}
        stream={{ ...stream, lastMessagePreview: preview ?? null }}
        title={name}
        unreadCount={unreadCount}
        side="bottom"
      >
        <Link
          to={`/w/${workspaceId}/s/${stream.id}`}
          onClick={hover.close}
          className="flex min-w-0 flex-1 items-start gap-3 rounded-md px-2 py-2.5 hover:bg-muted/60"
        >
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className={cn("truncate text-sm", unreadCount > 0 ? "font-semibold" : "font-medium")}>{name}</span>
              {stream.visibility === "private" && stream.type === "channel" && (
                <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Private" />
              )}
              <UnreadBadge count={unreadCount} className="h-4 min-w-4 px-1 text-[10px]" />
            </div>
            <div className="truncate text-xs text-muted-foreground">{meta.join(" · ")}</div>
            {previewText && <div className="mt-0.5 truncate text-xs text-foreground/80">{previewText}</div>}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <span className="text-xs tabular-nums text-muted-foreground">{lastActive}</span>
            {stats && (
              <div className="flex items-center gap-3">
                <ActivitySparkline activity={stats.activity} className="hidden h-4 w-14 sm:block" />
                <MemberStack workspaceId={workspaceId} stats={stats} max={isMobile ? 0 : 3} />
              </div>
            )}
          </div>
        </Link>
      </StreamHoverCard>
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

/** Fourteen daily bars, oldest on the left; `activity[0]` is the last 24h. */
function ActivitySparkline({ activity, className }: { activity: number[]; className?: string }) {
  const peak = Math.max(1, ...activity)
  const total = activity.reduce((sum, count) => sum + count, 0)
  const days = [...activity].reverse()
  return (
    <svg
      viewBox={`0 0 ${days.length * 4} 16`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${messageCountLabel(total)} in the last ${activity.length} days`}
      className={cn("text-primary", className)}
    >
      {days.map((count, index) => {
        const height = count === 0 ? 1 : Math.max(2, (count / peak) * 16)
        return (
          <rect
            key={index}
            x={index * 4 + 0.5}
            y={16 - height}
            width={3}
            height={height}
            rx={0.75}
            className={count === 0 ? "fill-muted-foreground/25" : "fill-current"}
          />
        )
      })}
    </svg>
  )
}

function MemberStack({ workspaceId, stats, max }: { workspaceId: string; stats: StreamDirectoryStats; max: number }) {
  const { getActorName } = useActors(workspaceId)
  if (stats.memberCount === 0) return null
  const shown = stats.recentMemberIds.slice(0, max)
  return (
    <span
      className="flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground"
      title={`${stats.memberCount} members`}
    >
      {shown.length > 0 && (
        <span className="flex -space-x-1.5">
          {shown.map((memberId) => {
            const actorType = actorTypeFromId(memberId)
            return (
              <ActorAvatar
                key={memberId}
                actorId={memberId}
                actorType={actorType}
                workspaceId={workspaceId}
                size="xs"
                alt={getActorName(memberId, actorType)}
                showStatus={false}
                className="ring-2 ring-background"
              />
            )
          })}
        </span>
      )}
      <span aria-label={`${stats.memberCount} members`}>{stats.memberCount}</span>
    </span>
  )
}
