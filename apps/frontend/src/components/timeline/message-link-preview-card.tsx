import { useState, useEffect } from "react"
import { Link } from "react-router-dom"
import { MessageSquare, Lock, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { linkPreviewsApi } from "@/api"
import { LinkPreviewBody } from "./link-preview-body"
import type { LinkPreviewSummary, MessageLinkPreviewData } from "@threa/types"

interface MessageLinkPreviewCardProps {
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

export function MessageLinkPreviewCard({
  preview,
  workspaceId,
  messageId,
  onDismiss,
  hydrate = true,
}: MessageLinkPreviewCardProps) {
  const [data, setData] = useState<MessageLinkPreviewData | null>(null)
  const [loading, setLoading] = useState(hydrate)

  useEffect(() => {
    if (!hydrate) {
      setLoading(true)
      return
    }

    let mounted = true
    linkPreviewsApi
      .resolveMessageLink(workspaceId, preview.id)
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

  if (data.accessTier === "cross_workspace") {
    return <CrossWorkspaceCard preview={preview} onDismiss={onDismiss} />
  }

  if (data.accessTier === "private") {
    return <PrivateMessageCard preview={preview} onDismiss={onDismiss} />
  }

  // Full access tier
  if (data.deleted) {
    return (
      <div className="group/preview reveal-host relative overflow-hidden rounded-lg border bg-card max-w-md">
        <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
          <MessageSquare className="h-4 w-4 shrink-0" />
          <span className="text-xs italic">This message was deleted</span>
          <DismissButton previewId={preview.id} onDismiss={onDismiss} />
        </div>
      </div>
    )
  }

  const internalPath = getInternalMessagePath(preview.url)
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
    <div className="group/preview reveal-host relative overflow-hidden rounded-lg border bg-card transition-all max-w-md hover:border-primary/50 hover:shadow-sm">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-muted/30">
        <MessageSquare className="h-4 w-4 text-primary shrink-0" />
        {data.streamName && <span className="text-xs text-muted-foreground truncate">#{data.streamName}</span>}
        <DismissButton previewId={preview.id} onDismiss={onDismiss} />
      </div>
      <LinkPreviewBody messageId={messageId} previewId={preview.id}>
        {internalPath ? (
          <Link to={internalPath} className="block hover:bg-muted/20 transition-colors">
            {body}
          </Link>
        ) : (
          body
        )}
      </LinkPreviewBody>
    </div>
  )
}

function getInternalMessagePath(url: string): string | null {
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

function PrivateMessageCard({
  preview,
  onDismiss,
}: {
  preview: LinkPreviewSummary
  onDismiss?: (previewId: string) => void
}) {
  return (
    <div className="group/preview reveal-host relative overflow-hidden rounded-lg border bg-card max-w-md">
      <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
        <Lock className="h-4 w-4 shrink-0" />
        <span className="text-xs">Message in a private conversation</span>
        <DismissButton previewId={preview.id} onDismiss={onDismiss} />
      </div>
    </div>
  )
}

function CrossWorkspaceCard({
  preview,
  onDismiss,
}: {
  preview: LinkPreviewSummary
  onDismiss?: (previewId: string) => void
}) {
  return (
    <div className="group/preview reveal-host relative overflow-hidden rounded-lg border bg-card max-w-md">
      <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
        <MessageSquare className="h-4 w-4 shrink-0" />
        <span className="text-xs">A message in Threa</span>
        <DismissButton previewId={preview.id} onDismiss={onDismiss} />
      </div>
    </div>
  )
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
