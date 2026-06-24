import { useState, useEffect, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { MessageSquare, Hash, Brain, Lock, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { stripMarkdownToInline } from "@/lib/markdown"
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
  const [data, setData] = useState<InAppLinkPreviewData | null>(null)
  const [loading, setLoading] = useState(hydrate)

  useEffect(() => {
    if (!hydrate) {
      // Hydration deferred (e.g. board feed): don't fetch and don't sit on a
      // perpetual skeleton — collapse until a caller flips hydrate on.
      setLoading(false)
      return
    }

    let mounted = true
    setLoading(true)
    linkPreviewsApi
      .resolveInAppLink(workspaceId, preview.id)
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
  }, [workspaceId, preview.id, hydrate])

  if (loading) {
    return (
      <div className="rounded-lg border bg-card max-w-md animate-pulse">
        <div className="flex items-center gap-2 px-3 py-2">
          <div className="h-4 w-4 rounded bg-muted" />
          <div className="h-3 w-32 rounded bg-muted" />
        </div>
      </div>
    )
  }

  if (!data) return null

  if (data.kind === "stream") {
    return <StreamLinkCard data={data} preview={preview} onDismiss={onDismiss} />
  }

  if (data.kind === "memo") {
    return <MemoLinkCard data={data} preview={preview} onDismiss={onDismiss} />
  }

  return <MessageLinkCard data={data} preview={preview} messageId={messageId} onDismiss={onDismiss} />
}

function MessageLinkCard({
  data,
  preview,
  messageId,
  onDismiss,
}: {
  data: MessageLinkPreviewData
  preview: LinkPreviewSummary
  messageId?: string
  onDismiss?: (previewId: string) => void
}) {
  if (data.accessTier === "cross_workspace") {
    return (
      <MinimalCard icon={<MessageSquare />} label="A message in Threa" previewId={preview.id} onDismiss={onDismiss} />
    )
  }

  if (data.accessTier === "private") {
    return (
      <MinimalCard
        icon={<Lock />}
        label="Message in a private conversation"
        previewId={preview.id}
        onDismiss={onDismiss}
      />
    )
  }

  if (data.deleted) {
    return (
      <MinimalCard
        icon={<MessageSquare />}
        label="This message was deleted"
        italic
        previewId={preview.id}
        onDismiss={onDismiss}
      />
    )
  }

  const internalPath = getInternalPath(preview.url)
  const body = (
    <div className="flex gap-2.5 px-3 py-2">
      <AuthorAvatar avatarUrl={data.authorAvatarUrl} authorName={data.authorName} />
      <div className="flex-1 min-w-0">
        {data.authorName && <span className="text-xs font-medium text-foreground">{data.authorName}</span>}
        {data.contentPreview && (
          <div className="mt-0.5">
            <MarkdownContent content={data.contentPreview} className="text-xs text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  )

  return (
    <CardShell
      header={
        <>
          <MessageSquare className="h-4 w-4 text-primary shrink-0" />
          {data.streamName && <span className="text-xs text-muted-foreground truncate">#{data.streamName}</span>}
          <DismissButton previewId={preview.id} onDismiss={onDismiss} />
        </>
      }
    >
      <LinkPreviewBody messageId={messageId} previewId={preview.id}>
        {internalPath ? (
          <Link to={internalPath} className="block hover:bg-muted/20 transition-colors">
            {body}
          </Link>
        ) : (
          body
        )}
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

function StreamLinkCard({
  data,
  preview,
  onDismiss,
}: {
  data: StreamLinkPreviewData
  preview: LinkPreviewSummary
  onDismiss?: (previewId: string) => void
}) {
  if (data.accessTier === "cross_workspace") {
    return <MinimalCard icon={<Hash />} label="A conversation in Threa" previewId={preview.id} onDismiss={onDismiss} />
  }

  if (data.accessTier === "private") {
    return <MinimalCard icon={<Lock />} label="A private conversation" previewId={preview.id} onDismiss={onDismiss} />
  }

  const internalPath = getInternalPath(preview.url)
  const visibilityLabel = data.visibility === "private" ? "Private" : "Public"
  const body = (
    <div className="px-3 py-2">
      <div className="flex items-center gap-1.5">
        <Hash className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="text-sm font-medium text-foreground truncate">{data.streamName ?? "Conversation"}</span>
      </div>
      {data.description && (
        <p className="mt-1 text-xs text-muted-foreground line-clamp-3">{stripMarkdownToInline(data.description)}</p>
      )}
      <span className="mt-1.5 inline-block text-[10px] uppercase tracking-wide text-muted-foreground">
        {visibilityLabel}
      </span>
    </div>
  )

  return (
    <CardShell
      header={
        <>
          <Hash className="h-4 w-4 text-primary shrink-0" />
          <span className="text-xs text-muted-foreground">{streamKindLabel(data.streamType)}</span>
          <DismissButton previewId={preview.id} onDismiss={onDismiss} />
        </>
      }
    >
      {internalPath ? (
        <Link to={internalPath} className="block hover:bg-muted/20 transition-colors">
          {body}
        </Link>
      ) : (
        body
      )}
    </CardShell>
  )
}

function MemoLinkCard({
  data,
  preview,
  onDismiss,
}: {
  data: MemoLinkPreviewData
  preview: LinkPreviewSummary
  onDismiss?: (previewId: string) => void
}) {
  if (data.accessTier === "cross_workspace") {
    return <MinimalCard icon={<Brain />} label="A memory in Threa" previewId={preview.id} onDismiss={onDismiss} />
  }

  if (data.accessTier === "private") {
    return (
      <MinimalCard
        icon={<Lock />}
        label="A memory in a private conversation"
        previewId={preview.id}
        onDismiss={onDismiss}
      />
    )
  }

  const internalPath = getInternalPath(preview.url)
  const body = (
    <div className="px-3 py-2">
      <div className="flex items-center gap-1.5">
        <Brain className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="text-sm font-medium text-foreground truncate">{data.title ?? "Memory"}</span>
      </div>
      {data.abstract && (
        <p className="mt-1 text-xs text-muted-foreground line-clamp-3">{stripMarkdownToInline(data.abstract)}</p>
      )}
      {data.sourceStreamName && (
        <span className="mt-1.5 inline-block text-[10px] text-muted-foreground truncate">
          From #{data.sourceStreamName}
        </span>
      )}
    </div>
  )

  return (
    <CardShell
      header={
        <>
          <Brain className="h-4 w-4 text-primary shrink-0" />
          <span className="text-xs text-muted-foreground">Memory</span>
          <DismissButton previewId={preview.id} onDismiss={onDismiss} />
        </>
      }
    >
      {internalPath ? (
        <Link to={internalPath} className="block hover:bg-muted/20 transition-colors">
          {body}
        </Link>
      ) : (
        body
      )}
    </CardShell>
  )
}

function CardShell({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="group/preview reveal-host relative overflow-hidden rounded-lg border bg-card transition-all max-w-md hover:border-primary/50 hover:shadow-sm">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-muted/30">{header}</div>
      {children}
    </div>
  )
}

/** Compact single-line card for cross-workspace, private, and deleted tiers. */
function MinimalCard({
  icon,
  label,
  italic,
  previewId,
  onDismiss,
}: {
  icon: ReactNode
  label: string
  italic?: boolean
  previewId: string
  onDismiss?: (previewId: string) => void
}) {
  return (
    <div className="group/preview reveal-host relative overflow-hidden rounded-lg border bg-card max-w-md">
      <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
        <span className="[&>svg]:h-4 [&>svg]:w-4 shrink-0">{icon}</span>
        <span className={italic ? "text-xs italic" : "text-xs"}>{label}</span>
        <DismissButton previewId={previewId} onDismiss={onDismiss} />
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
      <Avatar className="h-5 w-5 shrink-0 mt-0.5">
        <AvatarImage src={avatarUrl} alt={authorName ?? ""} />
        <AvatarFallback className="text-[10px]">{authorName?.charAt(0)?.toUpperCase() ?? "?"}</AvatarFallback>
      </Avatar>
    )
  }

  if (authorName) {
    return (
      <Avatar className="h-5 w-5 shrink-0 mt-0.5">
        <AvatarFallback className="text-[10px]">{authorName.charAt(0).toUpperCase()}</AvatarFallback>
      </Avatar>
    )
  }

  return null
}

function DismissButton({ previewId, onDismiss }: { previewId: string; onDismiss?: (previewId: string) => void }) {
  if (!onDismiss) return null

  return (
    <Button
      variant="ghost"
      size="icon"
      className="reveal-actions h-5 w-5 ml-auto"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onDismiss(previewId)
      }}
      aria-label="Dismiss preview"
    >
      <X className="h-3 w-3" />
    </Button>
  )
}
