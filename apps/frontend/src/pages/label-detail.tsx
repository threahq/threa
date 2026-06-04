import { useMemo } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, ChevronRight, Globe, Lock, PanelLeft, Tag } from "lucide-react"
import { Visibilities } from "@threa/types"
import { Button, buttonVariants } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SidebarToggle } from "@/components/layout"
import { LabelGlyph } from "@/components/labels/label-chip"
import { cn } from "@/lib/utils"
import { hexToRgba } from "@/lib/labels"
import { stripMarkdownToInline } from "@/lib/markdown"
import { truncateContent } from "@/components/layout/sidebar/utils"
import { resolveStreamName, STREAM_ICONS } from "@/lib/streams"
import { formatRelativeTime } from "@/lib/dates"
import { useLabelStreams, useLabelsSync, useSidebarConfig, type CachedLabel } from "@/hooks"
import { useWorkspaceDmPeers, useWorkspaceLabels, useWorkspaceUsers, type CachedStream } from "@/stores/workspace-store"
import { hasLabelSection, toggleLabelSection } from "@/components/layout/sidebar/sidebar-config"
import type { SidebarConfig } from "@threa/types"

/**
 * Route is `/w/:workspaceId/labels/:labelId` — a label's landing page. Opens
 * from the catalog (and anywhere a label is shown) into a view of everything the
 * label gathers. Streams are the only labelable resource today (threads are
 * streams, so they list here too); the page is laid out as resource sections so
 * messages/people/files can each get their own block later without reshaping it.
 */
export function LabelDetailPage() {
  const { workspaceId, labelId } = useParams<{ workspaceId: string; labelId: string }>()

  if (!workspaceId || !labelId) return null

  return <LabelDetailPageInner workspaceId={workspaceId} labelId={labelId} />
}

function LabelDetailPageInner({ workspaceId, labelId }: { workspaceId: string; labelId: string }) {
  const labelsQuery = useLabelsSync(workspaceId)
  const labels = useWorkspaceLabels(workspaceId)
  const label = useMemo(() => labels.find((l) => l.id === labelId && !l.archivedAt) ?? null, [labels, labelId])
  const streams = useLabelStreams(workspaceId, labelId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const { config: sidebarConfig, setConfig: setSidebarConfig } = useSidebarConfig(workspaceId)

  // Resolve each stream's viewer-specific name once, here, rather than a hook
  // per row — DM names live in the peer caches, not on the stream object.
  const namedStreams = useMemo(
    () => streams.map((stream) => ({ stream, name: resolveStreamName(stream.id, { streams, users, dmPeers }) })),
    [streams, users, dmPeers]
  )

  // A cold deep-link to this URL lands before bootstrap fills the cache, so an
  // empty `labels` array means "still settling", not "no such label" — wait for
  // the first fetch to settle before deciding it's genuinely missing, or the
  // page flashes a not-found state on every hard refresh.
  let body: React.ReactNode
  if (!label && !labelsQuery.isFetched) {
    body = <LoadingState />
  } else if (!label) {
    body = <NotFound workspaceId={workspaceId} />
  } else {
    body = (
      <>
        <LabelHero
          label={label}
          streamCount={namedStreams.length}
          config={sidebarConfig}
          onConfigChange={setSidebarConfig}
        />
        <section className="mt-8">
          <h2 className="mb-2.5 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Streams</h2>
          {namedStreams.length === 0 ? (
            <EmptyStreams />
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card">
              <ul className="divide-y">
                {namedStreams.map(({ stream, name }, i) => (
                  <li key={stream.id}>
                    <StreamRow workspaceId={workspaceId} stream={stream} name={name} index={i} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 items-center gap-2 border-b px-4">
        <SidebarToggle location="page" />
        <Link
          to={`/w/${workspaceId}/labels`}
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8 shrink-0")}
          aria-label="Back to labels"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex min-w-0 items-center gap-2">
          {label ? (
            <LabelGlyph label={label} className="h-5 w-5 text-sm" fallback="tag" />
          ) : (
            <Tag className="h-5 w-5 shrink-0 text-muted-foreground" />
          )}
          <h1 className="truncate font-semibold">{label?.name ?? "Label"}</h1>
        </div>
      </header>

      <ScrollArea className="flex-1">
        <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">{body}</main>
      </ScrollArea>
    </div>
  )
}

function streamCountLabel(count: number): string {
  if (count === 0) return "No streams yet"
  return `${count} ${count === 1 ? "stream" : "streams"}`
}

function LabelHero({
  label,
  streamCount,
  config,
  onConfigChange,
}: {
  label: CachedLabel
  streamCount: number
  config: SidebarConfig
  onConfigChange: (config: SidebarConfig) => void
}) {
  const pinned = hasLabelSection(config, label.id)
  const isPublic = label.visibility === Visibilities.PUBLIC
  return (
    <div
      className="relative overflow-hidden rounded-xl border p-5 sm:p-6"
      // A faint wash in the label's own color so the page reads as *its* place,
      // with the same 3px left rail the catalog cards use.
      style={{ backgroundColor: hexToRgba(label.color, 0.05), borderLeft: `3px solid ${label.color}` }}
    >
      <div className="flex items-start gap-4">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-2xl"
          style={{ backgroundColor: hexToRgba(label.color, 0.14), color: label.color }}
          aria-hidden
        >
          {label.emoji ?? <Tag className="h-6 w-6" />}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold leading-tight">{label.name}</h2>
          <div className="mt-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              {isPublic ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              {isPublic ? "Public" : "Private"}
            </span>
            <span aria-hidden>·</span>
            <span>{streamCountLabel(streamCount)}</span>
          </div>
          {label.description && (
            <p className="mt-3 max-w-prose text-sm leading-relaxed text-foreground/80">
              {stripMarkdownToInline(label.description)}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant={pinned ? "secondary" : "outline"}
          aria-pressed={pinned}
          className="h-8 shrink-0 gap-1.5 px-2.5 text-xs"
          onClick={() => onConfigChange(toggleLabelSection(config, label.id))}
        >
          <PanelLeft className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{pinned ? "In sidebar" : "Show in sidebar"}</span>
        </Button>
      </div>
    </div>
  )
}

function StreamRow({
  workspaceId,
  stream,
  name,
  index,
}: {
  workspaceId: string
  stream: CachedStream
  name: string | null
  index: number
}) {
  const Icon = STREAM_ICONS[stream.type] ?? Tag
  const preview = stream.lastMessagePreview
  const activityAt = preview?.createdAt ?? stream.createdAt
  return (
    <Link
      to={`/w/${workspaceId}/s/${stream.id}`}
      // Subtle staggered reveal on load — capped so a long list doesn't ripple.
      className="group flex animate-in fade-in items-center gap-3 px-3.5 py-3 transition-colors hover:bg-muted/40"
      style={{ animationDelay: `${Math.min(index, 8) * 25}ms`, animationFillMode: "both" }}
    >
      <span className="shrink-0 text-muted-foreground" aria-hidden>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{name ?? "Untitled"}</span>
          <time className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatRelativeTime(new Date(activityAt), undefined, undefined, { terse: true })}
          </time>
        </div>
        {preview && (
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{truncateContent(preview.content, 120)}</p>
        )}
      </div>
      {/* Always present (no layout shift, INV-21) — only its color fades in on hover. */}
      <ChevronRight
        className="h-4 w-4 shrink-0 text-transparent transition-colors group-hover:text-muted-foreground/60"
        aria-hidden
      />
    </Link>
  )
}

function LoadingState() {
  return (
    <div className="animate-pulse">
      <div className="flex items-start gap-4 rounded-xl border p-5 sm:p-6">
        <div className="h-12 w-12 shrink-0 rounded-xl bg-muted" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="h-4 w-40 rounded bg-muted" />
          <div className="h-3 w-24 rounded bg-muted" />
        </div>
      </div>
      <div className="mt-8 overflow-hidden rounded-xl border">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 border-b px-3.5 py-3 last:border-b-0">
            <div className="h-4 w-4 shrink-0 rounded bg-muted" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3.5 w-1/3 rounded bg-muted" />
              <div className="h-3 w-2/3 rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function EmptyStreams() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/40 px-6 py-12 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Tag className="h-5 w-5" />
      </div>
      <h3 className="text-sm font-semibold">Nothing here yet</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        Apply this label to a scratchpad, channel, or thread from its “Labels…” menu and it will show up here.
      </p>
    </div>
  )
}

function NotFound({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/40 px-6 py-12 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Tag className="h-5 w-5" />
      </div>
      <h3 className="text-sm font-semibold">Label not found</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        This label may have been deleted or is no longer shared with you.
      </p>
      <Link to={`/w/${workspaceId}/labels`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4")}>
        Back to labels
      </Link>
    </div>
  )
}
