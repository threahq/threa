import { Link } from "react-router-dom"
import { ChevronRight, Pencil } from "lucide-react"
import type { ThreadSummary } from "@threahq/types"
import { ActorAvatar } from "@/components/actor-avatar"
import { RelativeTime } from "@/components/relative-time"
import { useActors } from "@/hooks"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { truncateContent } from "@/components/layout/sidebar/utils"
import { draftEmptyBodyLabel } from "@/lib/drafts/decryption"
import { cn } from "@/lib/utils"

export interface ThreadCardDraft {
  /** One-line plain text of the viewer's unsent reply. "" when there is nothing
   *  renderable (attachment-only, or a sealed body this device can't read). */
  preview: string
  /** Files on the draft. With no body text they name the row ("1 attachment"),
   *  so an attachment-only reply reads the same here as in every other draft
   *  list; only a row with neither drops the snippet entirely. */
  attachmentCount: number
}

/** What the draft-only card shows under its header: the body text, else the file
 *  count, else nothing (a sealed body this device can't read). */
function draftSnippet(draft: ThreadCardDraft): string {
  if (draft.preview) return draft.preview
  return draft.attachmentCount > 0 ? draftEmptyBodyLabel(draft.attachmentCount) : ""
}

interface ThreadCardProps {
  replyCount: number
  href: string
  workspaceId: string
  summary?: ThreadSummary
  /**
   * The viewer's unsent reply draft in this thread. With replies it appends a
   * muted "Draft" token after the timestamp; at `replyCount === 0` it is the
   * whole card (the thread stream does not exist yet, so there is nothing else
   * to show) and `href` points at the draft reply panel.
   */
  draft?: ThreadCardDraft | null
  /**
   * Render a pulsing gold dot next to the reply count when a session is
   * actively producing content in this thread. Lets the card stay mounted
   * across the session lifecycle instead of being swapped in and out with a
   * separate activity pill (which caused layout shift when a thread was
   * created mid-session).
   */
  isActive?: boolean
  /**
   * When rendered inside `ThreadSlot`, the slot owns the gold left-line so
   * that it can persist across pill→card transitions and animate growth.
   * The card suppresses its own `before:` line in that case.
   */
  ownsLeftLine?: boolean
  className?: string
}

/**
 * Compact thread preview card with a gold "Ariadne's thread" left-line,
 * participant avatar stack, and latest-reply snippet. Acts as the thread
 * entry tap target on both desktop and mobile.
 *
 * Preview text routes through `truncateContent()` (→ `stripMarkdownToInline`)
 * so raw markdown from `contentMarkdown` never ships as literal syntax to
 * users (INV-60). The draft snippet needs no stripping — it is projected from
 * the composer's `contentJson`, never markdown.
 */
export function ThreadCard({
  replyCount,
  href,
  workspaceId,
  summary,
  draft,
  isActive,
  ownsLeftLine = true,
  className,
}: ThreadCardProps) {
  const { getActorName } = useActors(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)

  if (replyCount === 0 && !draft) return null

  const isDraftOnly = replyCount === 0
  const draftSnippetText = draft ? draftSnippet(draft) : ""
  const replyLabel = replyCount === 1 ? "1 reply" : `${replyCount} replies`
  const participants = summary?.participants ?? []

  return (
    <Link
      to={href}
      className={cn(
        "group/thread relative flex flex-col gap-1 rounded-md py-1.5 pl-3 pr-2",
        ownsLeftLine && "mt-2",
        // 2px gold thread line that extends up into the message gap — Ariadne's literal thread.
        // Suppressed when ThreadSlot owns the line so there's no double-draw.
        ownsLeftLine &&
          "before:content-[''] before:absolute before:left-0 before:top-[-4px] before:bottom-1 before:w-[2px] before:rounded-full before:bg-primary/70 hover:before:bg-primary",
        "hover:bg-primary/[0.04] transition-colors",
        className
      )}
    >
      <div className="flex items-center gap-2 text-xs">
        {isDraftOnly && (
          <span className="flex items-center gap-1.5">
            <Pencil aria-hidden className="h-3.5 w-3.5 text-primary" />
            <span className="font-medium text-primary group-hover/thread:underline">Draft</span>
          </span>
        )}
        {!isDraftOnly && participants.length > 0 && (
          <div className="flex gap-0.5">
            {participants.map((participant) => (
              <ActorAvatar
                key={`${participant.type}:${participant.id}`}
                actorId={participant.id}
                actorType={participant.type}
                workspaceId={workspaceId}
                size="xs"
              />
            ))}
          </div>
        )}
        {!isDraftOnly && <span className="font-medium text-primary group-hover/thread:underline">{replyLabel}</span>}
        {isActive && (
          <span className="relative flex h-1.5 w-1.5" aria-label="Session active">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
          </span>
        )}
        {summary && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <RelativeTime date={summary.lastReplyAt} terse className="text-muted-foreground" />
          </>
        )}
        {draft && !isDraftOnly && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span className="flex items-center gap-1 italic text-muted-foreground" aria-label="Unsent draft">
              <Pencil aria-hidden className="h-3 w-3" />
              Draft
            </span>
          </>
        )}
        <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground/50 transition-transform group-hover/thread:translate-x-0.5 group-hover/thread:text-muted-foreground" />
      </div>
      {isDraftOnly
        ? draftSnippetText && <p className="truncate text-xs italic text-muted-foreground">{draftSnippetText}</p>
        : summary && (
            <p className="truncate text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">
                {getActorName(summary.latestReply.actorId, summary.latestReply.actorType)}
              </span>
              <span className="text-muted-foreground/60">: </span>
              {truncateContent(summary.latestReply.contentMarkdown, 120, toEmoji)}
            </p>
          )}
    </Link>
  )
}
