import { useMemo } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, AtSign, Bell, Globe, Hash, Lock, MessagesSquare, NotebookPen, PanelLeft, Tag } from "lucide-react"
import { StreamTypes, Visibilities, type StreamType } from "@threa/types"
import { Button, buttonVariants } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SidebarToggle } from "@/components/layout"
import { LabelGlyph } from "@/components/labels/label-chip"
import { cn } from "@/lib/utils"
import { hexToRgba } from "@/lib/labels"
import { stripMarkdownToInline } from "@/lib/markdown"
import { truncateContent } from "@/components/layout/sidebar/utils"
import { resolveStreamName } from "@/lib/streams"
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
  useLabelsSync(workspaceId)
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
        <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
          {!label ? (
            <NotFound workspaceId={workspaceId} />
          ) : (
            <>
              <LabelHero label={label} config={sidebarConfig} onConfigChange={setSidebarConfig} />
              <section className="mt-8">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  Streams
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                    {namedStreams.length}
                  </span>
                </h2>
                {namedStreams.length === 0 ? (
                  <EmptyStreams />
                ) : (
                  <ul className="flex flex-col gap-1">
                    {namedStreams.map(({ stream, name }) => (
                      <li key={stream.id}>
                        <StreamRow workspaceId={workspaceId} stream={stream} name={name} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </main>
      </ScrollArea>
    </div>
  )
}

function LabelHero({
  label,
  config,
  onConfigChange,
}: {
  label: CachedLabel
  config: SidebarConfig
  onConfigChange: (config: SidebarConfig) => void
}) {
  const pinned = hasLabelSection(config, label.id)
  const isPublic = label.visibility === Visibilities.PUBLIC
  return (
    <div className="rounded-xl border bg-card p-4 sm:p-5" style={{ borderLeft: `3px solid ${label.color}` }}>
      <div className="flex items-start gap-3">
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-2xl"
          style={{ backgroundColor: hexToRgba(label.color, 0.12), color: label.color }}
          aria-hidden
        >
          {label.emoji ?? <Tag className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold leading-tight">{label.name}</h2>
          <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            {isPublic ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
            <span>{isPublic ? "Public" : "Private"}</span>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={pinned}
          className={cn("h-7 shrink-0 gap-1.5 px-2 text-xs", pinned && "text-primary")}
          onClick={() => onConfigChange(toggleLabelSection(config, label.id))}
        >
          <PanelLeft className="h-3 w-3" />
          {pinned ? "In sidebar" : "Show in sidebar"}
        </Button>
      </div>
      {label.description && (
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{stripMarkdownToInline(label.description)}</p>
      )}
    </div>
  )
}

// Module-scoped so it isn't a component defined inside a component (INV-18).
const STREAM_TYPE_ICONS: Record<StreamType, typeof Hash> = {
  [StreamTypes.CHANNEL]: Hash,
  [StreamTypes.SCRATCHPAD]: NotebookPen,
  [StreamTypes.DM]: AtSign,
  [StreamTypes.THREAD]: MessagesSquare,
  [StreamTypes.SYSTEM]: Bell,
}

function StreamRow({ workspaceId, stream, name }: { workspaceId: string; stream: CachedStream; name: string | null }) {
  const Icon = STREAM_TYPE_ICONS[stream.type] ?? Tag
  const preview = stream.lastMessagePreview
  const activityAt = preview?.createdAt ?? stream.createdAt
  return (
    <Link
      to={`/w/${workspaceId}/s/${stream.id}`}
      className="flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:border-border hover:bg-muted/50"
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{name ?? "Untitled"}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {formatRelativeTime(new Date(activityAt), undefined, undefined, { terse: true })}
          </span>
        </div>
        {preview && <p className="truncate text-xs text-muted-foreground">{truncateContent(preview.content, 120)}</p>}
      </div>
    </Link>
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
