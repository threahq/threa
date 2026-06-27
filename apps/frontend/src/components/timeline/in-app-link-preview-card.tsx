import { useState, useEffect, useMemo, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { MessageSquare, Hash, Brain, Lock, Globe, NotebookPen, ArrowUpRight, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { stripMarkdownToInline } from "@/lib/markdown"
import { classifyDraftLink } from "@/lib/in-app-links"
import { useStreamName } from "@/hooks/use-stream-name"
import { linkPreviewsApi } from "@/api"
import { LinkPreviewBody } from "./link-preview-body"
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
 * that resolved its name locally and needs no fetch). Deps are primitives so a
 * settled resolve doesn't re-fire on unrelated re-renders.
 */
export function useResolvedInAppLink(
  workspaceId: string,
  previewId: string | undefined,
  url: string | undefined,
  hydrate: boolean
): { data: InAppLinkPreviewData | null; loading: boolean } {
  const [data, setData] = useState<InAppLinkPreviewData | null>(null)
  const [loading, setLoading] = useState(hydrate)

  useEffect(() => {
    if (!hydrate) {
      // Hydration deferred (e.g. board feed): don't fetch and don't sit on a
      // perpetual skeleton — collapse until a caller flips hydrate on.
      setData(null)
      setLoading(false)
      return
    }

    let request: Promise<InAppLinkPreviewData> | null = null
    if (previewId) request = linkPreviewsApi.resolveInAppLink(workspaceId, previewId)
    else if (url) request = linkPreviewsApi.resolveInAppLinkByUrl(workspaceId, url)
    if (!request) {
      // Neither key (e.g. a chip that resolved its name locally) — collapse to
      // no data rather than leaving a prior resolve's result on screen.
      setData(null)
      setLoading(false)
      return
    }

    let mounted = true
    // Clear any prior target's data so a failed re-resolve (silently caught
    // below) can't leave the previous link's card showing for the new one.
    setData(null)
    setLoading(true)
    request
      .then((result) => {
        if (mounted) setData(result)
      })
      .catch(() => {
        // Silently fail — previews are non-critical
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [workspaceId, previewId, url, hydrate])

  return { data, loading }
}

interface InAppLinkPreviewCardProps {
  preview: LinkPreviewSummary
  workspaceId: string
  /**
   * Scopes the per-preview "Show more" persistence key. Optional so tests and
   * transient previews without a host message still render.
   */
  messageId?: string
  onDismiss?: (previewId: string) => void
  hydrate?: boolean
}

export function InAppLinkPreviewCard({
  preview,
  workspaceId,
  messageId,
  onDismiss,
  hydrate = true,
}: InAppLinkPreviewCardProps) {
  const { data, loading } = useResolvedInAppLink(workspaceId, preview.id, undefined, hydrate)

  if (loading) return <CardSkeleton />
  if (!data) return null

  return (
    <ResolvedInAppLink
      data={data}
      url={preview.url}
      workspaceId={workspaceId}
      previewKey={preview.id}
      messageId={messageId}
      onDismiss={onDismiss ? () => onDismiss(preview.id) : undefined}
    />
  )
}

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
  previewKey,
  messageId,
  onDismiss,
}: {
  data: InAppLinkPreviewData
  url: string
  workspaceId: string
  previewKey: string
  messageId?: string
  onDismiss?: () => void
}) {
  if (data.kind === "stream")
    return <StreamLinkCard data={data} url={url} workspaceId={workspaceId} onDismiss={onDismiss} />
  if (data.kind === "memo") return <MemoLinkCard data={data} url={url} onDismiss={onDismiss} />
  return (
    <MessageLinkCard
      data={data}
      url={url}
      workspaceId={workspaceId}
      previewKey={previewKey}
      messageId={messageId}
      onDismiss={onDismiss}
    />
  )
}

function MessageLinkCard({
  data,
  url,
  workspaceId,
  previewKey,
  messageId,
  onDismiss,
}: {
  data: MessageLinkPreviewData
  url: string
  workspaceId: string
  previewKey: string
  messageId?: string
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
    <CardBody>
      <div className="flex gap-3">
        <AuthorAvatar avatarUrl={data.authorAvatarUrl} authorName={data.authorName} />
        <div className="min-w-0 flex-1">
          {data.authorName && <span className="text-xs font-semibold text-foreground">{data.authorName}</span>}
          {data.contentPreview && (
            <div className="mt-0.5">
              <MarkdownContent
                content={data.contentPreview}
                className="text-xs leading-relaxed text-muted-foreground"
              />
            </div>
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
      <LinkPreviewBody messageId={messageId} previewId={previewKey}>
        <InternalLink path={internalPath}>{body}</InternalLink>
      </LinkPreviewBody>
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
    return <MinimalCard kindIcon={<Brain />} kindLabel="Memory" label="In another workspace" onDismiss={onDismiss} />
  }

  if (data.accessTier === "private") {
    return (
      <MinimalCard
        kindIcon={<Brain />}
        kindLabel="Memory"
        bodyIcon={<Lock />}
        label="From a private conversation"
        onDismiss={onDismiss}
      />
    )
  }

  const internalPath = getInternalPath(url)
  const body = (
    <CardBody>
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

function CardBody({ children }: { children: ReactNode }) {
  return (
    <div className="relative overflow-hidden px-3.5 py-3">
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
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">{header}</div>
      {children}
    </div>
  )
}

/**
 * Loading placeholder. Mirrors the resolved card's header bar + tile + two text
 * lines so resolving doesn't shift following timeline rows (INV-21).
 */
function CardSkeleton() {
  return (
    <div className="max-w-md animate-pulse overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
        <div className="h-3 w-20 rounded bg-muted" />
      </div>
      <div className="flex items-start gap-3 px-3.5 py-3">
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
  onDismiss,
}: {
  kindIcon: ReactNode
  kindLabel: string
  bodyIcon?: ReactNode
  label: string
  italic?: boolean
  onDismiss?: () => void
}) {
  return (
    <div className="group/preview reveal-host relative max-w-md overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-muted-foreground">
        <span className="shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5">{kindIcon}</span>
        <span className="text-xs font-medium">{kindLabel}</span>
        <DismissButton onDismiss={onDismiss} />
      </div>
      <div className="flex items-center gap-3 px-3.5 py-3 text-muted-foreground">
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

function AuthorAvatar({ avatarUrl, authorName }: { avatarUrl?: string; authorName?: string }) {
  if (avatarUrl) {
    return (
      <Avatar className="h-9 w-9 shrink-0 rounded-lg">
        <AvatarImage src={avatarUrl} alt={authorName ?? ""} />
        <AvatarFallback className="rounded-lg text-xs">{authorName?.charAt(0)?.toUpperCase() ?? "?"}</AvatarFallback>
      </Avatar>
    )
  }

  if (authorName) {
    return (
      <Avatar className="h-9 w-9 shrink-0 rounded-lg">
        <AvatarFallback className="rounded-lg text-xs">{authorName.charAt(0).toUpperCase()}</AvatarFallback>
      </Avatar>
    )
  }

  return null
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
