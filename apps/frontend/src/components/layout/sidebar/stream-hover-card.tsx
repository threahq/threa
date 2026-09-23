import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Check, CheckCheck, ExternalLink } from "lucide-react"
import { ENCRYPTED_MESSAGE_PREVIEW_LABEL, type EventType, type StreamEvent } from "@threahq/types"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { RelativeTime } from "@/components/relative-time"
import { ActorAvatar } from "@/components/actor-avatar"
import { actorRowTheme } from "@/components/message/actor-row-theme"
import { useStreamService } from "@/contexts"
import { useActors, useUnreadCounts } from "@/hooks"
import { useFormattedDate } from "@/hooks/use-formatted-date"
import { useDecryptedMessageContent } from "@/hooks/use-decrypted-message-content"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useWorkspaceStreamReadStates } from "@/stores/workspace-store"
import { resolveFrontierSequence } from "@/lib/read-frontier"
import { isSameAuthorRun } from "@/lib/message-grouping"
import { stripMarkdownToInline } from "@/lib/markdown"
import { streamLabel } from "@/lib/streams"
import { cn } from "@/lib/utils"
import type { StreamItemData } from "./types"

const OPEN_DELAY_MS = 450
const CLOSE_DELAY_MS = 150
const CARD_MESSAGE_LIMIT = 8
const MESSAGE_EVENT_TYPES: EventType[] = ["message_created", "message_edited", "message_deleted"]
/** Enough rows that edits and deletes of the last few messages still leave eight to show. */
const FETCH_LIMIT = 40

export interface HoverCardMessage {
  messageId: string
  sequence: bigint
  /** The `message_created` event with any later edit folded into its payload. */
  event: StreamEvent
}

/** Fold a chronological run of message events into the latest live messages. */
export function foldHoverMessages(events: StreamEvent[], limit = CARD_MESSAGE_LIMIT): HoverCardMessage[] {
  const byId = new Map<string, HoverCardMessage>()
  for (const event of events) {
    const payload = event.payload as { messageId?: string } & Record<string, unknown>
    const messageId = payload?.messageId
    if (!messageId) continue
    if (event.eventType === "message_created") {
      byId.set(messageId, { messageId, sequence: BigInt(event.sequence), event })
    } else if (event.eventType === "message_edited") {
      const existing = byId.get(messageId)
      if (existing) {
        byId.set(messageId, {
          ...existing,
          event: { ...existing.event, payload: { ...(existing.event.payload as object), ...payload } },
        })
      }
    } else if (event.eventType === "message_deleted") {
      byId.delete(messageId)
    }
  }
  return [...byId.values()].sort((a, b) => (a.sequence < b.sequence ? -1 : 1)).slice(-limit)
}

/**
 * Pointer hover intent for a sidebar row: opens after a dwell, and stays open while
 * the pointer crosses from the row into the card. Touch pointers never open it.
 */
export function useSidebarHoverIntent(enabled: boolean) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const schedule = useCallback(
    (next: boolean, delay: number) => {
      clear()
      timer.current = setTimeout(() => setOpen(next), delay)
    },
    [clear]
  )
  const close = useCallback(() => {
    clear()
    setOpen(false)
  }, [clear])

  useEffect(() => clear, [clear])
  useEffect(() => {
    if (!enabled) close()
  }, [enabled, close])

  const onPointerEnter = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled || event.pointerType === "touch") return
      schedule(true, open ? 0 : OPEN_DELAY_MS)
    },
    [enabled, open, schedule]
  )
  const onPointerLeave = useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType === "touch") return
      if (open) schedule(false, CLOSE_DELAY_MS)
      else clear()
    },
    [open, schedule, clear]
  )

  return { enabled, open, setOpen, close, onPointerEnter, onPointerLeave }
}

export type SidebarHoverIntent = ReturnType<typeof useSidebarHoverIntent>

interface StreamHoverCardProps {
  hover: SidebarHoverIntent
  workspaceId: string
  stream: StreamItemData
  unreadCount: number
  /** Clear this stream from the Inbox; set only on Inbox rows. */
  onClearFromInbox?: () => void
  /** The row element the card anchors beside. */
  children: ReactNode
}

export function StreamHoverCard({
  hover,
  workspaceId,
  stream,
  unreadCount,
  onClearFromInbox,
  children,
}: StreamHoverCardProps) {
  if (!hover.enabled) return <>{children}</>
  return (
    <Popover open={hover.open} onOpenChange={(open) => !open && hover.close()}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      {hover.open && (
        <PopoverContent
          side="right"
          align="start"
          sideOffset={10}
          collisionPadding={8}
          className="w-80 p-0"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={hover.onPointerEnter}
          onPointerLeave={hover.onPointerLeave}
        >
          <HoverCardBody
            workspaceId={workspaceId}
            stream={stream}
            unreadCount={unreadCount}
            onClearFromInbox={onClearFromInbox}
            onNavigate={hover.close}
          />
        </PopoverContent>
      )}
    </Popover>
  )
}

interface HoverCardBodyProps {
  workspaceId: string
  stream: StreamItemData
  unreadCount: number
  onClearFromInbox?: () => void
  onNavigate: () => void
}

function HoverCardBody({ workspaceId, stream, unreadCount, onClearFromInbox, onNavigate }: HoverCardBodyProps) {
  const streamService = useStreamService()
  const { getActorName } = useActors(workspaceId)
  const { markAsRead } = useUnreadCounts(workspaceId)
  const readStates = useWorkspaceStreamReadStates(workspaceId)
  const { data: messages, isError } = useQuery({
    queryKey: ["sidebar-hover-card", workspaceId, stream.id],
    queryFn: () => streamService.getEvents(workspaceId, stream.id, { limit: FETCH_LIMIT, types: MESSAGE_EVENT_TYPES }),
    select: (response) => foldHoverMessages(response.events),
    staleTime: 15_000,
  })

  const frontier = resolveFrontierSequence(readStates.find((row) => row.streamId === stream.id))
  const firstUnreadIndex = useMemo(() => {
    if (!messages || unreadCount === 0 || frontier === undefined) return -1
    return messages.findIndex((message) => frontier === null || message.sequence > frontier)
  }, [messages, unreadCount, frontier])

  const groups = useMemo(() => groupHoverMessages(messages ?? [], firstUnreadIndex), [messages, firstUnreadIndex])
  const latest = messages?.at(-1)
  const streamHref = `/w/${workspaceId}/s/${stream.id}`

  return (
    <div className="flex max-h-[min(28rem,var(--radix-popover-content-available-height))] flex-col">
      <div className="flex items-center gap-1 border-b px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{streamLabel(stream, "sidebar")}</span>
        {unreadCount > 0 && latest && (
          <CardAction label="Mark read" onClick={() => void markAsRead(stream.id, latest.event.id)}>
            <CheckCheck />
          </CardAction>
        )}
        {onClearFromInbox && (
          <CardAction label="Clear from Inbox" onClick={onClearFromInbox}>
            <Check />
          </CardAction>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="ghost" size="icon" className="h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5">
              <Link to={streamHref} onClick={onNavigate} aria-label="Open">
                <ExternalLink />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {messages === undefined && !isError && <HoverCardSkeleton />}
        {isError && <p className="px-3 py-3 text-xs text-muted-foreground">Couldn't load messages</p>}
        {messages?.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">No messages yet</p>}
        {groups.map((group) => (
          <div key={group.messages[0].messageId}>
            {group.startsUnread && (
              <div className="flex items-center gap-2 px-3 pt-1.5 text-[11px] font-medium text-primary">
                <span>New</span>
                <span className="h-px flex-1 bg-primary/30" />
              </div>
            )}
            {group.messages.map((message, index) => (
              <HoverCardMessageRow
                key={message.messageId}
                workspaceId={workspaceId}
                message={message}
                authorName={getActorName(message.event.actorId, message.event.actorType)}
                head={index === 0}
                href={`${streamHref}?m=${message.messageId}`}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export interface HoverMessageGroup {
  startsUnread: boolean
  messages: HoverCardMessage[]
}

/** Same-author runs by the timeline's rule; the first unread message always heads its own run. */
export function groupHoverMessages(messages: HoverCardMessage[], firstUnreadIndex: number): HoverMessageGroup[] {
  const groups: HoverMessageGroup[] = []
  messages.forEach((message, index) => {
    const last = groups.at(-1)
    const previous = last?.messages.at(-1)
    const startsUnread = index === firstUnreadIndex
    if (last && previous && !startsUnread && isSameAuthorRun(toRunRow(previous), toRunRow(message))) {
      last.messages.push(message)
      return
    }
    groups.push({ startsUnread, messages: [message] })
  })
  return groups
}

function toRunRow(message: HoverCardMessage) {
  return {
    authorId: message.event.actorId,
    authorType: message.event.actorType,
    createdAtMs: new Date(message.event.createdAt).getTime(),
  }
}

function CardAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5"
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

interface HoverCardMessageRowProps {
  workspaceId: string
  message: HoverCardMessage
  authorName: string
  /** First message of a same-author run: carries the avatar and name line. */
  head: boolean
  href: string
  onNavigate: () => void
}

function HoverCardMessageRow({ workspaceId, message, authorName, head, href, onNavigate }: HoverCardMessageRowProps) {
  const currentUserId = useWorkspaceUserId(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const { formatTime, formatFull } = useFormattedDate()
  const content = useDecryptedMessageContent(message.event, workspaceId, currentUserId)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)
  const { actorId, actorType, createdAt } = message.event
  const theme = actorRowTheme(actorType)
  const sentAt = new Date(createdAt)

  let text: string | null = null
  if (content.status === "plaintext" || content.status === "decrypted") {
    text = stripMarkdownToInline(content.contentMarkdown, toEmoji)
  } else if (content.status === "locked") {
    text = ENCRYPTED_MESSAGE_PREVIEW_LABEL
  } else if (content.status === "failed") {
    text = "Couldn't decrypt this message"
  }

  useLayoutEffect(() => {
    const el = textRef.current
    if (!el || expanded) return
    setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [text, expanded])

  return (
    <div className={cn("message-hover-wash", theme.rowAccent, head ? "pt-2" : "pt-0.5", "pb-0.5")}>
      <Link
        to={href}
        onClick={onNavigate}
        className="group flex gap-2 px-3 outline-none focus-visible:bg-muted/80"
        data-message-id={message.messageId}
      >
        {head ? (
          <ActorAvatar
            actorId={actorId}
            actorType={actorType}
            workspaceId={workspaceId}
            size="sm"
            alt={authorName}
            showStatus={false}
          />
        ) : (
          <span
            className="w-7 shrink-0 text-right font-mono text-[10px] tabular-nums leading-[18px] text-transparent transition-colors group-hover:text-muted-foreground/60"
            title={formatFull(sentAt)}
          >
            {formatTime(sentAt)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          {head && (
            <div className="flex items-baseline gap-2">
              <span className={cn("min-w-0 truncate text-xs font-semibold", theme.nameClassName)}>{authorName}</span>
              {theme.badge}
              <RelativeTime date={createdAt} className="shrink-0 text-[11px] text-muted-foreground" />
            </div>
          )}
          {text === null ? (
            <Skeleton className="my-1 h-3.5 w-3/4" />
          ) : (
            <p
              ref={textRef}
              className={cn(
                "whitespace-pre-wrap break-words text-[13px] leading-[18px]",
                !expanded && "line-clamp-3",
                (content.status === "locked" || content.status === "failed") && "text-muted-foreground"
              )}
            >
              {text || " "}
            </p>
          )}
        </div>
      </Link>
      {(overflows || expanded) && (
        <button
          type="button"
          className="ml-12 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  )
}

function HoverCardSkeleton() {
  return (
    <div className="space-y-3 px-3 py-2">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex gap-2">
          <Skeleton className="h-7 w-7 rounded-[6px]" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3.5 w-5/6" />
          </div>
        </div>
      ))}
    </div>
  )
}
