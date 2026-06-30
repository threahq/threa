import { useMemo, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { MessageSquare, Hash, Brain, Lock, Globe, NotebookPen, ArrowUpRight, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ActorAvatar } from "@/components/actor-avatar"
import { stripMarkdownToInline } from "@/lib/markdown"
import { classifyDraftLink } from "@/lib/in-app-links"
import { useStreamName } from "@/hooks/use-stream-name"
import { linkPreviewsApi } from "@/api"
import type {
  InAppLinkPreviewData,
  LinkPreviewSummary,
  MessageLinkPreviewData,
  StreamLinkPreviewData,
  MemoLinkPreviewData,
  StreamType,
} from "@threa/types"

/**
 * Resolves in-app link data from one of two mutually-exclusive sources: a
 * persisted preview row (`previewId`, the posted-message timeline) or a raw
 * `url` (a draft chip with no persisted row). Both hit the same access-tiered
 * resolver; only the lookup key differs. Pass both undefined to no-op (a chip
 * that resolved its name locally and needs no fetch).
 *
 * Backed by a shared (in-memory, 5-min) query cache keyed on the lookup id, so a
 * link the composer already resolved renders resolved the instant the sent
 * message re-mounts on the timeline — no second round-trip and no pending-glyph
 * flash between the two surfaces (INV-21). `loading` is only true on a cold miss.
 */
export function useResolvedInAppLink(
  workspaceId: string,
  previewId: string | undefined,
  url: string | undefined,
  hydrate: boolean
): { data: InAppLinkPreviewData | null; loading: boolean } {
  const key = previewId ?? url ?? null
  const query = useQuery({
    queryKey: ["inAppLinkResolve", workspaceId, key],
    queryFn: () =>
      previewId
        ? linkPreviewsApi.resolveInAppLink(workspaceId, previewId)
        : linkPreviewsApi.resolveInAppLinkByUrl(workspaceId, url!),
    enabled: hydrate && key !== null,
    staleTime: 5 * 60_000,
    // Previews are non-critical; a failed resolve collapses to no card/chip
    // rather than retrying and holding a skeleton.
    retry: false,
  })

  return { data: query.data ?? null, loading: query.isLoading }
}

interface InAppLinkPreviewCardProps {
  preview: LinkPreviewSummary
  workspaceId: string
  onDismiss?: (previewId: string) => void
  hydrate?: boolean
}

export function InAppLinkPreviewCard({ preview, workspaceId, onDismiss, hydrate = true }: InAppLinkPreviewCardProps) {
  const { data, loading } = useResolvedInAppLink(workspaceId, preview.id, undefined, hydrate)

  if (loading) return <CardSkeleton variant={preview.contentType === "memo_link" ? "memo" : "message"} />
  if (!data) return null

  return (
    <ResolvedInAppLink
      data={data}
      url={preview.url}
      workspaceId={workspaceId}
      onDismiss={onDismiss ? () => onDismiss(preview.id) : undefined}
    />
  )
}

// The timeline does not compensate a row that grows after its first paint — its
// scroll anchor no-ops content resizes while reading history (use-timeline-scroll)
// and `overflow-anchor` is off — so the skeleton and EVERY resolved tier must
// commit the same height or the list jumps (INV-21). These reserve a fixed header
// and body footprint that content can't exceed (single-line title via `truncate`,
// body via `line-clamp-2`); the skeleton and the minimal tier mirror them. Two
// body sizes because the memo card carries an extra source-stream line.
const CARD_HEADER_H = "min-h-[2.0625rem]" // text/icon line + py-1.5 + border, fits the h-5 dismiss button
const CARD_BODY_MESSAGE = "min-h-[5.5rem]" // avatar + author line + 2-line clamp
const CARD_BODY_MEMO = "min-h-[7rem]" // tile + title + 2-line clamp + source line

type CardVariant = "message" | "memo"

/** Stream id of an in-app stream/message link, for client-side name resolution. */
function streamIdFromUrl(url: string): string | null {
  const ref = classifyDraftLink(url)
  return ref && (ref.kind === "stream" || ref.kind === "message") ? ref.streamId : null
}

/** Dispatches resolved data to the matching card. `onDismiss` is already bound. */
function ResolvedInAppLink({
  data,
  url,
  workspaceId,
  onDismiss,
}: {
  data: InAppLinkPreviewData
  url: string
  workspaceId: string
  onDismiss?: () => void
}) {
  if (data.kind === "stream")
    return <StreamLinkCard data={data} url={url} workspaceId={workspaceId} onDismiss={onDismiss} />
  if (data.kind === "memo") return <MemoLinkCard data={data} url={url} onDismiss={onDismiss} />
  return <MessageLinkCard data={data} url={url} workspaceId={workspaceId} onDismiss={onDismiss} />
}

function MessageLinkCard({
  data,
  url,
  workspaceId,
  onDismiss,
}: {
  data: MessageLinkPreviewData
  url: string
  workspaceId: string
  onDismiss?: () => void
}) {
  // A DM/stream name is per-viewer and absent from the backend resolve, so
  // prefer the locally-resolved name (same source the composer chip uses).
  const streamId = useMemo(() => streamIdFromUrl(url), [url])
  const localStreamName = useStreamName(workspaceId, streamId ?? "")

  if (data.accessTier === "cross_workspace") {
    return (
      <MinimalCard
        kindIcon={<MessageSquare />}
        kindLabel="Message"
        label="In another workspace"
        onDismiss={onDismiss}
      />
    )
  }

  if (data.accessTier === "private") {
    return (
      <MinimalCard
        kindIcon={<MessageSquare />}
        kindLabel="Message"
        bodyIcon={<Lock />}
        label="In a private conversation"
        onDismiss={onDismiss}
      />
    )
  }

  if (data.deleted) {
    return (
      <MinimalCard
        kindIcon={<MessageSquare />}
        kindLabel="Message"
        label="This message was deleted"
        italic
        onDismiss={onDismiss}
      />
    )
  }

  const internalPath = getInternalPath(url)
  const body = (
    <CardBody className={CARD_BODY_MESSAGE}>
      <div className="flex gap-3">
        <ActorAvatar
          actorId={data.authorId ?? null}
          actorType={data.authorType ?? "user"}
          workspaceId={workspaceId}
          size="lg"
          alt={data.authorName ?? ""}
          showStatus={false}
        />
        <div className="min-w-0 flex-1">
          {data.authorName && (
            <span className="block truncate text-xs font-semibold text-foreground">{data.authorName}</span>
          )}
          {data.contentPreview && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground line-clamp-2">
              {stripMarkdownToInline(data.contentPreview)}
            </p>
          )}
        </div>
      </div>
    </CardBody>
  )

  // `localStreamName` is already display-formatted (`#slug` for channels, a plain
  // per-viewer name for DMs/scratchpads). The backend `streamName` is a bare slug,
  // so it keeps the `#` channel prefix.
  let headerLabel = "Message"
  if (localStreamName) headerLabel = localStreamName
  else if (data.streamName) headerLabel = `#${data.streamName}`
  return (
    <CardShell header={<CardHeader label={headerLabel} onDismiss={onDismiss} />}>
      <InternalLink path={internalPath}>{body}</InternalLink>
    </CardShell>
  )
}

function streamKindLabel(streamType?: StreamType): string {
  switch (streamType) {
    case "channel":
      return "Channel"
    case "scratchpad":
      return "Scratchpad"
    default:
      return "Conversation"
  }
}

function streamKindIcon(streamType?: StreamType): ReactNode {
  switch (streamType) {
    case "scratchpad":
      return <NotebookPen />
    case "channel":
      return <Hash />
    default:
      return <MessageSquare />
  }
}

function StreamLinkCard({
  data,
  url,
  workspaceId,
  onDismiss,
}: {
  data: StreamLinkPreviewData
  url: string
  workspaceId: string
  onDismiss?: () => void
}) {
  // A DM/stream name is per-viewer and absent from the backend resolve, so
  // prefer the locally-resolved name (same source the composer chip uses).
  const streamId = useMemo(() => streamIdFromUrl(url), [url])
  const localStreamName = useStreamName(workspaceId, streamId ?? "")

  if (data.accessTier === "cross_workspace") {
    return (
      <MinimalCard kindIcon={<Hash />} kindLabel="Conversation" label="In another workspace" onDismiss={onDismiss} />
    )
  }

  if (data.accessTier === "private") {
    return (
      <MinimalCard
        kindIcon={<Hash />}
        kindLabel="Conversation"
        bodyIcon={<Lock />}
        label="Private conversation"
        onDismiss={onDismiss}
      />
    )
  }

  const internalPath = getInternalPath(url)
  const isPrivate = data.visibility === "private"
  const body = (
    <CardBody>
      <div className="flex items-start gap-3">
        <IconTile>{streamKindIcon(data.streamType)}</IconTile>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className="truncate text-sm font-semibold leading-snug text-foreground">
              {localStreamName ?? data.streamName ?? "Conversation"}
            </h4>
            <MetaBadge icon={isPrivate ? <Lock /> : <Globe />}>{isPrivate ? "Private" : "Public"}</MetaBadge>
          </div>
          {data.description && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground line-clamp-2">
              {stripMarkdownToInline(data.description)}
            </p>
          )}
        </div>
      </div>
    </CardBody>
  )

  return (
    <CardShell header={<CardHeader label={streamKindLabel(data.streamType)} onDismiss={onDismiss} />}>
      <InternalLink path={internalPath}>{body}</InternalLink>
    </CardShell>
  )
}

function MemoLinkCard({ data, url, onDismiss }: { data: MemoLinkPreviewData; url: string; onDismiss?: () => void }) {
  if (data.accessTier === "cross_workspace") {
    return (
      <MinimalCard
        kindIcon={<Brain />}
        kindLabel="Memory"
        label="In another workspace"
        variant="memo"
        onDismiss={onDismiss}
      />
    )
  }

  if (data.accessTier === "private") {
    return (
      <MinimalCard
        kindIcon={<Brain />}
        kindLabel="Memory"
        bodyIcon={<Lock />}
        label="From a private conversation"
        variant="memo"
        onDismiss={onDismiss}
      />
    )
  }

  const internalPath = getInternalPath(url)
  const body = (
    <CardBody className={CARD_BODY_MEMO}>
      <div className="flex items-start gap-3">
        <IconTile>
          <Brain />
        </IconTile>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className="truncate text-sm font-semibold leading-snug text-foreground">{data.title ?? "Memory"}</h4>
            {data.knowledgeType && <MetaBadge>{formatKnowledgeType(data.knowledgeType)}</MetaBadge>}
          </div>
          {data.abstract && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground line-clamp-2">
              {stripMarkdownToInline(data.abstract)}
            </p>
          )}
          {data.sourceStreamName && (
            <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Hash className="h-3 w-3 shrink-0" />
              From #{data.sourceStreamName}
            </span>
          )}
        </div>
      </div>
    </CardBody>
  )

  return (
    <CardShell header={<CardHeader label="Memory" onDismiss={onDismiss} />}>
      <InternalLink path={internalPath}>{body}</InternalLink>
    </CardShell>
  )
}

/** Soft golden corner glow — the "golden thread" depth cue shared by every in-app card body. */
function CardGlow() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute -right-12 -top-12 h-28 w-28 rounded-full bg-primary/10 blur-2xl"
    />
  )
}

/** Rounded primary-tinted tile that anchors a stream/memo card the way an avatar anchors a message. */
function IconTile({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/15 bg-primary/10 text-primary [&>svg]:h-[18px] [&>svg]:w-[18px]">
      {children}
    </div>
  )
}

function MetaBadge({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground [&>svg]:h-2.5 [&>svg]:w-2.5">
      {icon}
      {children}
    </span>
  )
}

function formatKnowledgeType(knowledgeType: string): string {
  return knowledgeType
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function CardHeader({ label, onDismiss }: { label: string; onDismiss?: () => void }) {
  return (
    <>
      <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
      <ArrowUpRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
      <DismissButton onDismiss={onDismiss} />
    </>
  )
}

function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden px-3.5 py-3", className)}>
      <CardGlow />
      <div className="relative">{children}</div>
    </div>
  )
}

function InternalLink({ path, children }: { path: string | null; children: ReactNode }) {
  if (!path) return <>{children}</>
  return (
    <Link to={path} className="block transition-colors hover:bg-muted/20">
      {children}
    </Link>
  )
}

function CardShell({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="group/preview reveal-host relative max-w-md overflow-hidden rounded-lg border bg-card transition-all hover:border-primary/50 hover:shadow-sm">
      <div className={cn("flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5", CARD_HEADER_H)}>{header}</div>
      {children}
    </div>
  )
}

/**
 * Loading placeholder. Reserves the SAME header + body footprint the resolved
 * card commits to (`CARD_HEADER_H` + the variant's `CARD_BODY_*`), so resolving
 * never changes the row height (INV-21). The variant comes from the preview's
 * content type, known before the resolve, so a memo card gets the taller body.
 */
function CardSkeleton({ variant }: { variant: CardVariant }) {
  return (
    <div className="max-w-md animate-pulse overflow-hidden rounded-lg border bg-card">
      <div className={cn("flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5", CARD_HEADER_H)}>
        <div className="h-3 w-20 rounded bg-muted" />
      </div>
      <div
        className={cn("flex items-start gap-3 px-3.5 py-3", variant === "memo" ? CARD_BODY_MEMO : CARD_BODY_MESSAGE)}
      >
        <div className="h-9 w-9 shrink-0 rounded-lg bg-muted" />
        <div className="flex-1 space-y-1.5 pt-0.5">
          <div className="h-3.5 w-32 rounded bg-muted" />
          <div className="h-3 w-full rounded bg-muted" />
        </div>
      </div>
    </div>
  )
}

/**
 * Restricted-tier card (cross-workspace / private / deleted). Mirrors the full
 * card's header-bar + tile-anchored body so resolving to a minimal tier keeps the
 * same footprint as the skeleton and the full card (INV-21). The header names the
 * kind; the body carries the restricted-state message behind a muted lock tile.
 */
function MinimalCard({
  kindIcon,
  kindLabel,
  bodyIcon,
  label,
  italic,
  variant = "message",
  onDismiss,
}: {
  kindIcon: ReactNode
  kindLabel: string
  bodyIcon?: ReactNode
  label: string
  italic?: boolean
  /** Match the skeleton/full-card footprint of the link's kind so the tier swap doesn't shift. */
  variant?: CardVariant
  onDismiss?: () => void
}) {
  return (
    <div className="group/preview reveal-host relative max-w-md overflow-hidden rounded-lg border bg-card">
      <div
        className={cn("flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-muted-foreground", CARD_HEADER_H)}
      >
        <span className="shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5">{kindIcon}</span>
        <span className="text-xs font-medium">{kindLabel}</span>
        <DismissButton onDismiss={onDismiss} />
      </div>
      <div
        className={cn(
          "flex items-center gap-3 px-3.5 py-3 text-muted-foreground",
          variant === "memo" ? CARD_BODY_MEMO : CARD_BODY_MESSAGE
        )}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 [&>svg]:h-[18px] [&>svg]:w-[18px]">
          {bodyIcon ?? kindIcon}
        </div>
        <span className={italic ? "text-sm italic" : "text-sm"}>{label}</span>
      </div>
    </div>
  )
}

function getInternalPath(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.pathname + parsed.search
  } catch {
    return null
  }
}

function DismissButton({ onDismiss }: { onDismiss?: () => void }) {
  if (!onDismiss) return null

  return (
    <Button
      variant="ghost"
      size="icon"
      className="reveal-actions ml-auto h-5 w-5"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onDismiss()
      }}
      aria-label="Dismiss preview"
    >
      <X className="h-3 w-3" />
    </Button>
  )
}
