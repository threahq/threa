import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Check, CheckCheck, ExternalLink, SmilePlus } from "lucide-react"
import { ENCRYPTED_MESSAGE_PREVIEW_LABEL, type StreamWithPreview } from "@threahq/types"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { RelativeTime } from "@/components/relative-time"
import { ActorAvatar } from "@/components/actor-avatar"
import { actorRowTheme } from "@/components/message/actor-row-theme"
import { ReactionPill } from "@/components/timeline/message-reactions"
import { ReactionEmojiPicker } from "@/components/timeline/reaction-emoji-picker"
import { useHoverCardMessages, type HoverCardMessage } from "@/hooks/use-hover-card-messages"
import { reactionShortcodes, stripColons, useActors, useMessageReactions, useUnreadCounts } from "@/hooks"
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

const OPEN_DELAY_MS = 450
const CLOSE_DELAY_MS = 150
type Reactions = Record<string, string[]>

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
  stream: StreamWithPreview
  /** Resolved name when the caller already holds one (DMs carry no `displayName`). */
  title?: string
  unreadCount: number
  /** Clear this stream from the Inbox; set only on Inbox rows. */
  onClearFromInbox?: () => void
  side?: "right" | "bottom"
  /** The row element the card anchors beside. */
  children: ReactNode
}

export function StreamHoverCard({
  hover,
  workspaceId,
  stream,
  title,
  unreadCount,
  onClearFromInbox,
  side = "right",
  children,
}: StreamHoverCardProps) {
  if (!hover.enabled) return <>{children}</>
  return (
    <Popover open={hover.open} onOpenChange={(open) => !open && hover.close()}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      {hover.open && (
        <HoverCardContent
          hover={hover}
          side={side}
          workspaceId={workspaceId}
          stream={stream}
          title={title ?? streamLabel(stream, "sidebar")}
          unreadCount={unreadCount}
          onClearFromInbox={onClearFromInbox}
        />
      )}
    </Popover>
  )
}

interface HoverCardContentProps {
  hover: SidebarHoverIntent
  side: "right" | "bottom"
  workspaceId: string
  stream: StreamWithPreview
  title: string
  unreadCount: number
  onClearFromInbox?: () => void
}

/** Mounts the popover once the local read resolves (a few ms), so the card opens with its messages in place. */
function HoverCardContent({ hover, side, ...props }: HoverCardContentProps) {
  const messages = useHoverCardMessages(props.stream.id)
  if (messages === undefined) return null
  return (
    <PopoverContent
      side={side}
      align="start"
      sideOffset={side === "right" ? 10 : 4}
      collisionPadding={8}
      className="w-80 p-0"
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
    >
      <HoverCardBody {...props} messages={messages} onNavigate={hover.close} />
    </PopoverContent>
  )
}

interface HoverCardBodyProps extends Omit<HoverCardContentProps, "hover" | "side"> {
  messages: HoverCardMessage[]
  onNavigate: () => void
}

function HoverCardBody({
  workspaceId,
  stream,
  title,
  unreadCount,
  onClearFromInbox,
  messages,
  onNavigate,
}: HoverCardBodyProps) {
  const { getActorName } = useActors(workspaceId)
  const { markAsRead } = useUnreadCounts(workspaceId)
  const readStates = useWorkspaceStreamReadStates(workspaceId)

  const frontier = resolveFrontierSequence(readStates.find((row) => row.streamId === stream.id))
  const firstUnreadIndex = useMemo(() => {
    if (unreadCount === 0 || frontier === undefined) return -1
    return messages.findIndex((message) => frontier === null || message.sequence > frontier)
  }, [messages, unreadCount, frontier])

  const groups = useMemo(() => groupHoverMessages(messages, firstUnreadIndex), [messages, firstUnreadIndex])
  const latest = messages.at(-1)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const pinnedToLatest = useRef(true)

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.scrollTop = scroller.scrollHeight
    // The card's height follows the space Radix measures beside the row, which can
    // shrink a frame after the content grows; stay on the newest message through it.
    const observer = new ResizeObserver(() => {
      if (pinnedToLatest.current) scroller.scrollTop = scroller.scrollHeight
    })
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [])
  const streamHref = `/w/${workspaceId}/s/${stream.id}`

  return (
    <div className="flex max-h-[min(28rem,var(--radix-popover-content-available-height))] flex-col">
      <div className="flex items-center gap-1 border-b px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
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

      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto scroll-pb-2 pb-1 pt-3.5"
        onScroll={(event) => {
          const el = event.currentTarget
          pinnedToLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 4
        }}
      >
        {messages.length === 0 && !stream.lastMessagePreview && (
          <p className="px-3 py-3 text-xs text-muted-foreground">No messages yet</p>
        )}
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
    <div className={cn("group/row relative message-hover-wash", theme.rowAccent, head ? "pt-2" : "pt-0.5", "pb-0.5")}>
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
      <HoverCardReactions
        workspaceId={workspaceId}
        messageId={message.messageId}
        reactions={(message.event.payload as { reactions?: Reactions }).reactions ?? {}}
        currentUserId={currentUserId}
      />
    </div>
  )
}

interface HoverCardReactionsProps {
  workspaceId: string
  messageId: string
  reactions: Reactions
  currentUserId: string | null
}

/** Pills update when the reaction's socket echo patches the message row, as in the timeline. */
function HoverCardReactions({ workspaceId, messageId, reactions, currentUserId }: HoverCardReactionsProps) {
  const { toEmoji, toShortcode } = useWorkspaceEmoji(workspaceId)
  const { addReaction, removeReaction } = useMessageReactions(workspaceId, messageId)
  const entries = Object.entries(reactions)
    .filter(([, userIds]) => userIds.length > 0)
    .sort(([, a], [, b]) => b.length - a.length)
  const activeShortcodes = useMemo(
    () =>
      new Set(
        Object.entries(reactions)
          .filter(([, userIds]) => currentUserId !== null && userIds.includes(currentUserId))
          .map(([key]) => stripColons(key))
      ),
    [reactions, currentUserId]
  )

  const pillsRef = useRef<HTMLDivElement>(null)
  // The live read re-renders on any row write, so wait for the echo of this toggle itself.
  const pendingReveal = useRef<{ key: string; reacted: boolean } | null>(null)
  useLayoutEffect(() => {
    const pending = pendingReveal.current
    if (!pending || !currentUserId) return
    if ((reactions[pending.key]?.includes(currentUserId) ?? false) !== pending.reacted) return
    pendingReveal.current = null
    pillsRef.current?.scrollIntoView({ block: "nearest" })
  }, [reactions, currentUserId])

  const toggle = async (shortcode: string) => {
    if (!currentUserId) return
    const emoji = toEmoji(shortcode)
    if (!emoji) {
      toast.error("Could not resolve emoji")
      return
    }
    const key = `:${shortcode}:`
    const reacted = reactions[key]?.includes(currentUserId) ?? false
    pendingReveal.current = { key, reacted: !reacted }
    await (reacted ? removeReaction(emoji) : addReaction(emoji))
  }

  const onPick = (emoji: string) => {
    const shortcode = toShortcode(emoji)
    if (!shortcode) {
      toast.error("Could not resolve emoji")
      return
    }
    void toggle(shortcode)
  }

  return (
    <>
      {entries.length > 0 && (
        <div ref={pillsRef} className="ml-12 flex flex-wrap gap-1 pr-3 pt-1">
          {entries.map(([key, userIds]) => (
            <ReactionPill
              key={key}
              emoji={toEmoji(stripColons(key)) ?? key}
              userIds={userIds}
              currentUserId={currentUserId}
              onToggle={() => void toggle(stripColons(key))}
            />
          ))}
        </div>
      )}
      <div className="pointer-events-none absolute bottom-[calc(100%-18px)] right-2 z-10 rounded-md border border-border/60 bg-popover/95 p-0.5 opacity-0 shadow-md backdrop-blur-sm transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100">
        <ReactionEmojiPicker
          workspaceId={workspaceId}
          onSelect={onPick}
          activeShortcodes={activeShortcodes}
          allReactionShortcodes={reactionShortcodes(reactions)}
          trigger={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Add reaction"
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
            >
              <SmilePlus className="h-3.5 w-3.5" />
            </Button>
          }
        />
      </div>
    </>
  )
}
