import { useState, type MouseEvent } from "react"
import { useNavigate } from "react-router-dom"
import {
  CornerDownRight,
  ExternalLink,
  Film,
  Github,
  Globe,
  ImageIcon,
  Link2,
  MessagesSquare,
  Play,
} from "lucide-react"
import { attachmentContentUrl } from "@/api"
import { CATEGORY_META } from "@/components/attachment-explorer/category"
import { useFormattedDate } from "@/hooks"
import { formatFileSize } from "@/lib/file-size"
import { getKnowledgeConfig, memoLabel } from "@/lib/memo-display"
import { cn } from "@/lib/utils"
import { resolveInternalAppPath } from "@/lib/internal-url"
import type { ContextItem, LinkContextItem, MediaContextItem } from "@/lib/stream-context/types"

interface StreamContextRowProps {
  workspaceId: string
  item: ContextItem
  onJumpToMessage: (messageId: string) => void
  onOpenThread: (threadId: string) => void
  onOpenMemo: (memoId: string) => void
}

function prettyHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/** Thumbnail for an image/gif/video item, with an icon fallback on load error. */
function MediaThumb({ workspaceId, item }: { workspaceId: string; item: MediaContextItem }) {
  const [failed, setFailed] = useState(false)
  const src =
    item.giphyUrl ??
    (item.attachmentId ? attachmentContentUrl(workspaceId, item.attachmentId, { variant: "thumbnail" }) : null)

  if (!src || failed) {
    const Icon = item.mediaKind === "video" ? Film : ImageIcon
    return (
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>
    )
  }

  return (
    <div className="relative size-10 shrink-0 overflow-hidden rounded-md bg-muted">
      <img src={src} alt="" loading="lazy" className="size-full object-cover" onError={() => setFailed(true)} />
      {item.mediaKind === "video" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/25">
          <Play className="size-4 fill-white text-white" />
        </div>
      )}
      {item.mediaKind === "gif" && (
        <span className="absolute bottom-0.5 right-0.5 rounded bg-black/60 px-1 text-[9px] font-semibold leading-tight text-white">
          GIF
        </span>
      )}
    </div>
  )
}

function LinkLeading({ item }: { item: LinkContextItem }) {
  const [failed, setFailed] = useState(false)
  if (item.previewKind === "github") {
    return (
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
        <Github className="size-4" />
      </div>
    )
  }
  if (item.faviconUrl && !failed) {
    return (
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
        <img
          src={item.faviconUrl}
          alt=""
          loading="lazy"
          className="size-4 rounded-sm"
          onError={() => setFailed(true)}
        />
      </div>
    )
  }
  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      {item.previewKind === "generic" ? <Globe className="size-4" /> : <Link2 className="size-4" />}
    </div>
  )
}

function BadgePill({ label, tone }: { label: string; tone: "github" | "linear" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-px text-[10px] font-semibold uppercase tracking-wide",
        tone === "github"
          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          : "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
      )}
    >
      {label}
    </span>
  )
}

export function StreamContextRow({
  workspaceId,
  item,
  onJumpToMessage,
  onOpenThread,
  onOpenMemo,
}: StreamContextRowProps) {
  const navigate = useNavigate()
  const { formatRelative } = useFormattedDate()
  const time = formatRelative(new Date(item.createdAt), undefined, { terse: true })

  let leading: React.ReactNode
  let primaryText: string
  let secondaryText: string | null = null
  let badge: React.ReactNode = null
  let primaryAction: React.ReactNode
  let jumpTarget: string | null = item.sourceMessageId

  switch (item.category) {
    case "link": {
      leading = <LinkLeading item={item} />
      primaryText = item.title ?? prettyHost(item.url)
      secondaryText = item.title ? prettyHost(item.url) : item.snippet || prettyHost(item.url)
      if (item.refCount > 1) secondaryText = `${secondaryText} · ${item.refCount}×`
      if (item.badge)
        badge = <BadgePill label={item.badge} tone={item.previewKind === "linear" ? "linear" : "github"} />
      // A link to our own origin routes in-app (react-router), matching how the
      // message body renders links (lib/markdown/components.tsx). Modifier- and
      // middle-clicks fall through to the native <a> so "open in new tab" still
      // works. External links keep opening in a new browsing context.
      const internalPath = resolveInternalAppPath(item.url)
      primaryAction = internalPath ? (
        <a
          href={internalPath}
          onClick={(e: MouseEvent<HTMLAnchorElement>) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
            e.preventDefault()
            navigate(internalPath)
          }}
          className="absolute inset-0 z-10 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="sr-only">Open {primaryText}</span>
        </a>
      ) : (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          className="absolute inset-0 z-10 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="sr-only">Open {primaryText}</span>
        </a>
      )
      break
    }
    case "media": {
      leading = <MediaThumb workspaceId={workspaceId} item={item} />
      primaryText = item.filename
      const mediaLabel = { image: "Image", gif: "GIF", video: "Video" }[item.mediaKind]
      secondaryText = item.snippet || mediaLabel
      primaryAction = (
        <button
          type="button"
          onClick={() => item.sourceMessageId && onJumpToMessage(item.sourceMessageId)}
          className="absolute inset-0 z-10 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="sr-only">Go to message with {primaryText}</span>
        </button>
      )
      break
    }
    case "file": {
      const meta = CATEGORY_META[item.fileCategory]
      const Icon = meta.icon
      leading = (
        <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-md", meta.accent)}>
          <Icon className="size-4" />
        </div>
      )
      primaryText = item.filename
      secondaryText = formatFileSize(item.sizeBytes)
      primaryAction = (
        <button
          type="button"
          onClick={() => item.sourceMessageId && onJumpToMessage(item.sourceMessageId)}
          className="absolute inset-0 z-10 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="sr-only">Go to message with {primaryText}</span>
        </button>
      )
      break
    }
    case "memo": {
      const config = getKnowledgeConfig(item.knowledgeType)
      const Icon = config.icon
      leading = (
        <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-md border", config.className)}>
          <Icon className="size-4" />
        </div>
      )
      primaryText = item.title
      secondaryText = `${memoLabel(item.knowledgeType)} · Memory`
      primaryAction = (
        <button
          type="button"
          onClick={() => onOpenMemo(item.memoId)}
          className="absolute inset-0 z-10 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="sr-only">Open memory {primaryText}</span>
        </button>
      )
      break
    }
    case "thread": {
      leading = (
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <MessagesSquare className="size-4" />
        </div>
      )
      primaryText = item.snippet
      secondaryText = `${item.replyCount} repl${item.replyCount === 1 ? "y" : "ies"}${
        item.lastReplyPreview ? ` · ${item.lastReplyPreview}` : ""
      }`
      jumpTarget = null // primary already opens the thread
      primaryAction = (
        <button
          type="button"
          onClick={() => onOpenThread(item.threadId)}
          className="absolute inset-0 z-10 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="sr-only">Open thread</span>
        </button>
      )
      break
    }
  }

  // Links open the URL on primary click, so they keep a secondary "go to
  // message" affordance. Media/file primary already jumps to the message.
  const showJump = item.category === "link" && jumpTarget != null

  return (
    <div className="group relative flex gap-3">
      {/* spine node — the leading visual sits on the timeline, its ring masking
          the line passing behind it (the line is drawn once by the panel). */}
      <div className="flex w-12 shrink-0 justify-center">
        <div className="mt-2 rounded-md ring-4 ring-background">{leading}</div>
      </div>
      <div className="relative min-w-0 flex-1 rounded-lg py-2 pr-2 transition-colors group-hover:bg-accent/50">
        {primaryAction}
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {badge}
              <span className="truncate text-sm font-medium leading-snug">{primaryText}</span>
              {item.category === "link" && (
                // Persistent (not hover-gated) so a link row reads as "opens
                // externally" at a glance, distinct from the rows that jump to
                // the message — and visible on touch, where there is no hover.
                <ExternalLink className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
              )}
            </div>
            {secondaryText && <p className="mt-0.5 truncate text-xs text-muted-foreground">{secondaryText}</p>}
          </div>
          <span className="pointer-events-none shrink-0 pt-0.5 text-[11px] tabular-nums text-muted-foreground">
            {time}
          </span>
          {showJump && (
            <button
              type="button"
              onClick={() => jumpTarget && onJumpToMessage(jumpTarget)}
              aria-label="Go to message"
              title="Go to message"
              className="relative z-20 -mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
            >
              <CornerDownRight className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
