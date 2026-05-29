import { BookOpen, ExternalLink, Hash, MessageSquareQuote } from "lucide-react"
import { Link } from "react-router-dom"
import type { StreamType } from "@threa/types"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { RelativeTime } from "@/components/relative-time"
import { cn } from "@/lib/utils"
import { streamFallbackLabel } from "@/lib/streams"
import { getKnowledgeConfig, memoLabel } from "@/lib/memo-display"
import type { MemoExplorerDetail, MemoExplorerStreamRef } from "@/api"

/**
 * Full memo detail renderer — title, abstract, key points, provenance, and
 * source messages. Shared by the memory explorer page (`MemoryPage`) and the
 * in-stream memo preview dialog (`MemoPreviewDialog`) so both surfaces render
 * a memo identically. The helpers below (`KnowledgeTypeBadge`,
 * `formatStreamRef`, `buildSourceLink`) are exported for callers that compose
 * their own memo rows (e.g. the explorer's result list).
 */

export function formatStreamRef(stream: MemoExplorerStreamRef | null): string | null {
  if (!stream) return null

  if (stream.name) {
    return stream.type === "channel" && !stream.name.startsWith("#") ? `#${stream.name}` : stream.name
  }

  return streamFallbackLabel(stream.type as StreamType, "generic")
}

export function buildSourceLink(workspaceId: string, streamId: string, messageId?: string): string {
  const search = messageId ? `?m=${messageId}` : ""
  return `/w/${workspaceId}/s/${streamId}${search}`
}

export function KnowledgeTypeBadge({ type, size = "sm" }: { type: string; size?: "sm" | "xs" }) {
  const config = getKnowledgeConfig(type)
  const Icon = config.icon

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border font-medium",
        config.className,
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-1.5 py-px text-[10px]"
      )}
    >
      <Icon className={size === "sm" ? "h-3 w-3" : "h-2.5 w-2.5"} />
      {config.label}
    </span>
  )
}

function DetailSection({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">{title}</h3>
      {children}
    </section>
  )
}

export function MemoDetailContent({
  data,
  workspaceId,
  isLoading,
}: {
  data: MemoExplorerDetail | null
  workspaceId: string
  isLoading: boolean
}) {
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-16 w-full" />
        </div>
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="rounded-full bg-muted/50 p-4 mb-4">
          <BookOpen className="h-6 w-6 text-muted-foreground/30" />
        </div>
        <p className="text-sm text-muted-foreground/60">Select a memo to view its details and provenance</p>
      </div>
    )
  }

  return (
    // [overflow-wrap:anywhere] is inherited by descendants so long unbreakable
    // strings collapse in min-content calculations. Without this, the Radix
    // ScrollArea / Drawer viewport can be forced wider than the screen on mobile.
    <div className="min-w-0 space-y-8 [overflow-wrap:anywhere]">
      {/* Title section */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <KnowledgeTypeBadge type={data.memo.knowledgeType} size="sm" />
          <Badge variant="secondary" className="text-[10px] font-medium">
            {memoLabel(data.memo.memoType)}
          </Badge>
          <span className="text-[11px] tabular-nums text-muted-foreground/50">v{data.memo.version}</span>
          <span className="text-muted-foreground/30">&middot;</span>
          <RelativeTime date={data.memo.updatedAt} className="text-[11px] text-muted-foreground/50" />
        </div>

        <h2 className="text-xl font-semibold tracking-tight leading-tight">{data.memo.title}</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{data.memo.abstract}</p>

        {data.memo.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {data.memo.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex max-w-full items-center gap-0.5 rounded-md bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                <Hash className="h-2.5 w-2.5 shrink-0" />
                <span className="min-w-0 truncate">{tag}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Key points */}
      {data.memo.keyPoints.length > 0 && (
        <DetailSection title="Key points">
          <ul className="space-y-2">
            {data.memo.keyPoints.map((keyPoint) => (
              <li
                key={keyPoint}
                className="relative min-w-0 pl-4 text-sm leading-relaxed before:absolute before:left-0 before:top-[0.6em] before:h-1.5 before:w-1.5 before:rounded-full before:bg-primary/40"
              >
                {keyPoint}
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      {/* Provenance */}
      <DetailSection title="Provenance">
        <div className="flex min-w-0 flex-wrap gap-2">
          {data.sourceStream && (
            <Link
              to={buildSourceLink(workspaceId, data.sourceStream.id)}
              className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border/50 bg-card px-3 py-2 text-sm transition-colors hover:border-primary/30 hover:bg-primary/5"
            >
              <MessageSquareQuote className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-medium">{formatStreamRef(data.sourceStream)}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/40" />
            </Link>
          )}

          {data.rootStream && data.rootStream.id !== data.sourceStream?.id && (
            <Link
              to={buildSourceLink(workspaceId, data.rootStream.id)}
              className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border/50 bg-card px-3 py-2 text-sm transition-colors hover:border-primary/30 hover:bg-primary/5"
            >
              <span className="shrink-0 text-xs text-muted-foreground/60">in</span>
              <span className="min-w-0 truncate font-medium">{formatStreamRef(data.rootStream)}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/40" />
            </Link>
          )}

          {!data.sourceStream && !data.rootStream && (
            <span className="text-sm text-muted-foreground/50">Source unavailable</span>
          )}
        </div>
      </DetailSection>

      {/* Source messages */}
      <DetailSection title="Source messages">
        {data.sourceMessages.length === 0 ? (
          <p className="text-sm text-muted-foreground/50">No accessible source messages were retained for this memo.</p>
        ) : (
          <div className="space-y-3">
            {data.sourceMessages.map((message) => (
              <div key={message.id} className="min-w-0 overflow-hidden rounded-lg border border-border/50 bg-card">
                <div className="flex min-w-0 items-center gap-2 border-b border-border/30 px-4 py-2">
                  <span className="min-w-0 truncate text-xs font-semibold">{message.authorName}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/40">in</span>
                  <Link
                    to={buildSourceLink(workspaceId, message.streamId, message.id)}
                    className="min-w-0 truncate text-xs text-primary/80 hover:text-primary hover:underline"
                  >
                    {message.streamName}
                  </Link>
                  <span className="ml-auto shrink-0">
                    <RelativeTime
                      date={message.createdAt}
                      className="text-[10px] tabular-nums text-muted-foreground/40"
                    />
                  </span>
                </div>
                <div className="min-w-0 overflow-hidden px-4 py-3 text-sm leading-relaxed">
                  <MarkdownContent content={message.content} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
                </div>
              </div>
            ))}
          </div>
        )}
      </DetailSection>
    </div>
  )
}
